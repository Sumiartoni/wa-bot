import crypto from "node:crypto";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { currentPolicies } from "./policies.js";

type AuditInput = {
  action: string;
  actorId?: number | null;
  targetType: string;
  targetId?: number | null;
  meta?: Record<string, unknown>;
};

export async function audit(input: AuditInput) {
  const meta = JSON.stringify(redact(input.meta ?? {}));
  const previous = await prisma.auditLog.findFirst({ where: { hash: { not: null } }, orderBy: { id: "desc" } });
  const hash = auditHash({ action: input.action, actorId: input.actorId ?? null, targetType: input.targetType, targetId: input.targetId ?? null, meta, previousHash: previous?.hash ?? null });
  return prisma.auditLog.create({
    data: {
      action: input.action,
      actorId: input.actorId ?? null,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      meta,
      hash,
      previousHash: previous?.hash ?? null
    }
  });
}

export async function verifyAuditChain() {
  const logs = await prisma.auditLog.findMany({ where: { hash: { not: null } }, orderBy: { id: "asc" } });
  let previousHash: string | null = null;
  for (const log of logs) {
    const expected = auditHash({ action: log.action, actorId: log.actorId, targetType: log.targetType, targetId: log.targetId, meta: log.meta, previousHash });
    if (log.previousHash !== previousHash || log.hash !== expected) {
      return { ok: false, checked: logs.length, failedAt: log.id };
    }
    previousHash = log.hash;
  }
  const legacyCount = await prisma.auditLog.count({ where: { hash: null } });
  return { ok: true, checked: logs.length, legacyCount };
}

function auditHash(value: Record<string, unknown>) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).update(config.JWT_SECRET).digest("hex");
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const redactionKeys = currentPolicies().auditRedactionKeys;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactionKeys.some((redactionKey) => key.toLowerCase().includes(redactionKey)) ? "[redacted]" : redact(entry)]));
}
