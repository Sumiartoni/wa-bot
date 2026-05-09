import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { audit } from "./audit.js";
import { databaseFilePath, ensureRuntimeDirs, paths } from "./config.js";
import { prisma } from "./db.js";
import { currentPolicies, loadPolicies } from "./policies.js";

const execFileAsync = promisify(execFile);
let backupTimer: NodeJS.Timeout | null = null;

type DirectorySummary = {
  fileCount: number;
  sizeBytes: number;
  updatedAt: Date | null;
};

export async function runBackup(actorId?: number | null) {
  ensureRuntimeDirs();
  const dbPath = databaseFilePath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    const failed = await prisma.backupRun.create({ data: { filePath: "", status: "failed", sizeBytes: 0, createdBy: actorId ?? null } });
    throw Object.assign(new Error("SQLite database file not found"), { backupRun: failed });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(paths.backups, `jokitugasku-${stamp}.db`);
  fs.copyFileSync(dbPath, destination);
  const sizeBytes = fs.statSync(destination).size;
  const backupRun = await prisma.backupRun.create({ data: { filePath: destination, sizeBytes, status: "completed", createdBy: actorId ?? null } });
  await audit({ action: "backup_created", actorId, targetType: "backup", targetId: backupRun.id, meta: { filePath: destination, sizeBytes } });
  return backupRun;
}

export async function createWhatsappSessionArchive(sessionName: string, sourcePath: string, actorId?: number | null) {
  ensureRuntimeDirs();
  fs.mkdirSync(sourcePath, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(paths.backups, `whatsapp-session-${sessionName}-${stamp}.tar.gz`);

  await execFileAsync("tar", ["-czf", destination, "-C", sourcePath, "."]);
  const sizeBytes = fs.statSync(destination).size;
  const backupRun = await prisma.backupRun.create({ data: { filePath: destination, sizeBytes, status: "completed", createdBy: actorId ?? null } });
  await audit({ action: "whatsapp_session_archive_created", actorId, targetType: "backup", targetId: backupRun.id, meta: { sessionName, filePath: destination, sizeBytes } });
  return backupRun;
}

export async function getBackupStatus() {
  ensureRuntimeDirs();
  const dbPath = databaseFilePath();
  const dbStats = dbPath && fs.existsSync(dbPath) ? fs.statSync(dbPath) : null;
  const sessionStats = summarizeDirectory(paths.whatsappSessions);
  const latestBackups = await prisma.backupRun.findMany({ orderBy: { createdAt: "desc" }, take: 5 });

  return {
    database: {
      path: dbPath,
      exists: Boolean(dbStats),
      sizeBytes: dbStats?.size ?? 0,
      updatedAt: dbStats?.mtime ?? null
    },
    whatsappSession: {
      path: paths.whatsappSessions,
      exists: fs.existsSync(paths.whatsappSessions),
      fileCount: sessionStats.fileCount,
      sizeBytes: sessionStats.sizeBytes,
      updatedAt: sessionStats.updatedAt
    },
    backupDirectory: paths.backups,
    scheduler: backupSchedulerStatus(),
    latestBackups
  };
}

export async function validateBackup(backupId: number, actorId?: number | null) {
  const backup = await prisma.backupRun.findUnique({ where: { id: backupId } });
  if (!backup) throw Object.assign(new Error("Backup not found"), { statusCode: 404 });
  const validation = validateBackupFile(backup.filePath);
  await audit({ action: "backup_validated", actorId, targetType: "backup", targetId: backup.id, meta: validation });
  return { backup, validation };
}

export async function restoreBackup(backupId: number, actorId: number | null, confirmText: string) {
  const backup = await prisma.backupRun.findUnique({ where: { id: backupId } });
  if (!backup) throw Object.assign(new Error("Backup not found"), { statusCode: 404 });
  if (confirmText !== `RESTORE ${backup.id}`) throw Object.assign(new Error(`Confirmation must be RESTORE ${backup.id}`), { statusCode: 400 });
  const validation = validateBackupFile(backup.filePath);
  if (!validation.ok || !backup.filePath.endsWith(".db")) throw Object.assign(new Error("Backup is not a valid SQLite database backup"), { statusCode: 400 });
  const dbPath = databaseFilePath();
  if (!dbPath) throw Object.assign(new Error("SQLite database path is not configured"), { statusCode: 400 });

  ensureRuntimeDirs();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safetyPath = path.join(paths.backups, `pre-restore-${stamp}.db`);
  if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, safetyPath);
  fs.copyFileSync(backup.filePath, dbPath);
  const restoredStats = fs.statSync(dbPath);
  const safety = await prisma.backupRun.create({ data: { filePath: safetyPath, sizeBytes: fs.existsSync(safetyPath) ? fs.statSync(safetyPath).size : 0, status: "pre_restore", createdBy: actorId } });
  await audit({ action: "backup_restored", actorId, targetType: "backup", targetId: backup.id, meta: { restoredFrom: backup.filePath, restoredTo: dbPath, safetyBackupId: safety.id, safetyPath, sizeBytes: restoredStats.size } });
  return { backup, validation, restoredTo: dbPath, safetyBackup: safety, sizeBytes: restoredStats.size };
}

export async function startBackupScheduler() {
  if (backupTimer) return backupSchedulerStatus();
  await loadPolicies();
  const intervalMinutes = currentPolicies().backupIntervalMinutes;
  if (intervalMinutes <= 0) return backupSchedulerStatus();
  backupTimer = setInterval(() => {
    scheduledBackupTick().catch((error) => console.error("Backup scheduler failed", error));
  }, intervalMinutes * 60_000);
  backupTimer.unref();
  return backupSchedulerStatus();
}

export async function restartBackupScheduler() {
  if (backupTimer) clearInterval(backupTimer);
  backupTimer = null;
  return startBackupScheduler();
}

export function backupSchedulerStatus() {
  return { enabled: Boolean(backupTimer), intervalMinutes: currentPolicies().backupIntervalMinutes, retentionDays: currentPolicies().backupRetentionDays };
}

async function scheduledBackupTick() {
  await loadPolicies();
  if (currentPolicies().backupIntervalMinutes <= 0) {
    await restartBackupScheduler();
    return;
  }
  const backup = await runBackup(null);
  await validateBackupFile(backup.filePath);
  await pruneOldBackups();
}

async function pruneOldBackups() {
  const retentionDays = currentPolicies().backupRetentionDays;
  if (retentionDays <= 0) return { pruned: 0 };
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const backups = await prisma.backupRun.findMany({ where: { createdAt: { lt: new Date(cutoff) }, status: "completed" } });
  let pruned = 0;
  for (const backup of backups) {
    if (backup.filePath && fs.existsSync(backup.filePath)) {
      fs.rmSync(backup.filePath, { force: true });
      pruned += 1;
    }
  }
  if (pruned > 0) await audit({ action: "backup_retention_pruned", actorId: null, targetType: "backup", targetId: null, meta: { pruned, retentionDays } });
  return { pruned };
}

function validateBackupFile(filePath: string) {
  const stats = filePath && fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const sqliteHeader = stats && path.extname(filePath) === ".db" ? fs.readFileSync(filePath, { encoding: "utf8", flag: "r" }).slice(0, 16) : "";
  return { ok: Boolean(stats && stats.size > 0 && (!filePath.endsWith(".db") || sqliteHeader === "SQLite format 3\u0000")), filePath, sizeBytes: stats?.size ?? 0 };
}

function summarizeDirectory(dirPath: string): DirectorySummary {
  if (!fs.existsSync(dirPath)) return { fileCount: 0, sizeBytes: 0, updatedAt: null as Date | null };
  let fileCount = 0;
  let sizeBytes = 0;
  let updatedAt: Date | null = null;

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = summarizeDirectory(entryPath);
      fileCount += nested.fileCount;
      sizeBytes += nested.sizeBytes;
      if (nested.updatedAt && (!updatedAt || nested.updatedAt > updatedAt)) updatedAt = nested.updatedAt;
      continue;
    }

    const stats = fs.statSync(entryPath);
    fileCount += 1;
    sizeBytes += stats.size;
    if (!updatedAt || stats.mtime > updatedAt) updatedAt = stats.mtime;
  }

  return { fileCount, sizeBytes, updatedAt };
}
