import { config } from "./config.js";
import { prisma } from "./db.js";

export type RuntimePolicies = {
  aiConfidenceThreshold: number;
  aiDefaultEnabled: boolean;
  defaultModel: string;
  backupIntervalMinutes: number;
  backupRetentionDays: number;
  messageQueueMaxAttempts: number;
  messageQueueRetrySeconds: number;
  auditRedactionKeys: string[];
  rateLimits: {
    globalMessages: { limit: number; windowSeconds: number };
    aiGeneration: { limit: number; windowSeconds: number };
    aiDaily: { limit: number; windowSeconds: number };
    aiContactDaily: { limit: number; windowSeconds: number };
  };
};

export type RuntimePolicyUpdate = Omit<Partial<RuntimePolicies>, "rateLimits"> & {
  rateLimits?: Partial<RuntimePolicies["rateLimits"]>;
};

const defaults: RuntimePolicies = {
  aiConfidenceThreshold: config.AI_CONFIDENCE_THRESHOLD,
  aiDefaultEnabled: config.AI_DEFAULT_ENABLED,
  defaultModel: config.OPENROUTER_MODEL,
  backupIntervalMinutes: config.BACKUP_INTERVAL_MINUTES,
  backupRetentionDays: config.BACKUP_RETENTION_DAYS,
  messageQueueMaxAttempts: config.MESSAGE_QUEUE_MAX_ATTEMPTS,
  messageQueueRetrySeconds: config.MESSAGE_QUEUE_RETRY_SECONDS,
  auditRedactionKeys: config.AUDIT_REDACTION_KEYS.split(",").map((key) => key.trim().toLowerCase()).filter(Boolean),
  rateLimits: {
    globalMessages: { limit: config.MESSAGE_RATE_LIMIT_PER_MINUTE, windowSeconds: 60 },
    aiGeneration: { limit: config.AI_RATE_LIMIT_PER_MINUTE, windowSeconds: 60 },
    aiDaily: { limit: config.AI_DAILY_LIMIT, windowSeconds: 86_400 },
    aiContactDaily: { limit: config.AI_CONTACT_DAILY_LIMIT, windowSeconds: 86_400 }
  }
};

let cached = defaults;

export function currentPolicies() {
  return cached;
}

export async function loadPolicies() {
  await ensurePolicyRows();
  const [settings, rateLimits] = await Promise.all([
    prisma.appSetting.findMany(),
    prisma.rateLimitPolicy.findMany()
  ]);
  const setting = new Map(settings.map((row) => [row.key, row.value]));
  const rate = new Map(rateLimits.map((row) => [row.scope, row]));

  cached = {
    aiConfidenceThreshold: numberSetting(setting, "ai_confidence_threshold", defaults.aiConfidenceThreshold, 0, 1),
    aiDefaultEnabled: booleanSetting(setting, "ai_default_enabled", defaults.aiDefaultEnabled),
    defaultModel: stringSetting(setting, "default_model", defaults.defaultModel),
    backupIntervalMinutes: numberSetting(setting, "backup_interval_minutes", defaults.backupIntervalMinutes, 0, 525_600),
    backupRetentionDays: numberSetting(setting, "backup_retention_days", defaults.backupRetentionDays, 0, 3650),
    messageQueueMaxAttempts: numberSetting(setting, "message_queue_max_attempts", defaults.messageQueueMaxAttempts, 1, 20),
    messageQueueRetrySeconds: numberSetting(setting, "message_queue_retry_seconds", defaults.messageQueueRetrySeconds, 1, 3600),
    auditRedactionKeys: stringSetting(setting, "audit_redaction_keys", defaults.auditRedactionKeys.join(",")).split(",").map((key) => key.trim().toLowerCase()).filter(Boolean),
    rateLimits: {
      globalMessages: rateSetting(rate, "global_messages", defaults.rateLimits.globalMessages),
      aiGeneration: rateSetting(rate, "ai_generation", defaults.rateLimits.aiGeneration),
      aiDaily: rateSetting(rate, "ai_daily", defaults.rateLimits.aiDaily),
      aiContactDaily: rateSetting(rate, "ai_contact_daily", defaults.rateLimits.aiContactDaily)
    }
  };
  return cached;
}

export async function ensurePolicyRows() {
  await Promise.all([
    upsertSetting("ai_confidence_threshold", String(defaults.aiConfidenceThreshold)),
    upsertSetting("ai_default_enabled", String(defaults.aiDefaultEnabled)),
    upsertSetting("default_model", defaults.defaultModel),
    upsertSetting("backup_interval_minutes", String(defaults.backupIntervalMinutes)),
    upsertSetting("backup_retention_days", String(defaults.backupRetentionDays)),
    upsertSetting("message_queue_max_attempts", String(defaults.messageQueueMaxAttempts)),
    upsertSetting("message_queue_retry_seconds", String(defaults.messageQueueRetrySeconds)),
    upsertSetting("audit_redaction_keys", defaults.auditRedactionKeys.join(",")),
    upsertRateLimit("global_messages", defaults.rateLimits.globalMessages),
    upsertRateLimit("ai_generation", defaults.rateLimits.aiGeneration),
    upsertRateLimit("ai_daily", defaults.rateLimits.aiDaily),
    upsertRateLimit("ai_contact_daily", defaults.rateLimits.aiContactDaily)
  ]);
}

export async function updatePolicies(input: RuntimePolicyUpdate, actorId: number) {
  const writes: Promise<unknown>[] = [];
  if (input.aiConfidenceThreshold !== undefined) writes.push(writeSetting("ai_confidence_threshold", String(input.aiConfidenceThreshold), actorId));
  if (input.aiDefaultEnabled !== undefined) writes.push(writeSetting("ai_default_enabled", String(input.aiDefaultEnabled), actorId));
  if (input.defaultModel !== undefined) writes.push(writeSetting("default_model", input.defaultModel, actorId));
  if (input.backupIntervalMinutes !== undefined) writes.push(writeSetting("backup_interval_minutes", String(input.backupIntervalMinutes), actorId));
  if (input.backupRetentionDays !== undefined) writes.push(writeSetting("backup_retention_days", String(input.backupRetentionDays), actorId));
  if (input.messageQueueMaxAttempts !== undefined) writes.push(writeSetting("message_queue_max_attempts", String(input.messageQueueMaxAttempts), actorId));
  if (input.messageQueueRetrySeconds !== undefined) writes.push(writeSetting("message_queue_retry_seconds", String(input.messageQueueRetrySeconds), actorId));
  if (input.auditRedactionKeys !== undefined) writes.push(writeSetting("audit_redaction_keys", input.auditRedactionKeys.join(","), actorId));
  if (input.rateLimits?.globalMessages) writes.push(writeRateLimit("global_messages", input.rateLimits.globalMessages));
  if (input.rateLimits?.aiGeneration) writes.push(writeRateLimit("ai_generation", input.rateLimits.aiGeneration));
  if (input.rateLimits?.aiDaily) writes.push(writeRateLimit("ai_daily", input.rateLimits.aiDaily));
  if (input.rateLimits?.aiContactDaily) writes.push(writeRateLimit("ai_contact_daily", input.rateLimits.aiContactDaily));
  await Promise.all(writes);
  return loadPolicies();
}

function upsertSetting(key: string, value: string) {
  return prisma.appSetting.upsert({ where: { key }, update: {}, create: { key, value } });
}

function writeSetting(key: string, value: string, actorId: number) {
  return prisma.appSetting.upsert({ where: { key }, update: { value, updatedBy: actorId }, create: { key, value, updatedBy: actorId } });
}

function upsertRateLimit(scope: string, value: { limit: number; windowSeconds: number }) {
  return prisma.rateLimitPolicy.upsert({ where: { scope }, update: {}, create: { scope, limit: value.limit, windowSeconds: value.windowSeconds } });
}

function writeRateLimit(scope: string, value: { limit: number; windowSeconds: number }) {
  return prisma.rateLimitPolicy.upsert({ where: { scope }, update: { limit: value.limit, windowSeconds: value.windowSeconds }, create: { scope, limit: value.limit, windowSeconds: value.windowSeconds } });
}

function rateSetting(rows: Map<string, { limit: number; windowSeconds: number }>, key: string, fallback: { limit: number; windowSeconds: number }) {
  const row = rows.get(key);
  return row ? { limit: row.limit, windowSeconds: row.windowSeconds } : fallback;
}

function stringSetting(rows: Map<string, string>, key: string, fallback: string) {
  const value = rows.get(key);
  return value && value.trim() ? value : fallback;
}

function booleanSetting(rows: Map<string, string>, key: string, fallback: boolean) {
  const value = rows.get(key);
  return value === undefined ? fallback : value === "true";
}

function numberSetting(rows: Map<string, string>, key: string, fallback: number, min: number, max: number) {
  const parsed = Number(rows.get(key));
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
