import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

dotenv.config();

const defaultDataDir = path.resolve(process.cwd(), "data");

const defaultJwtSecret = "dev-only-change-me";
const defaultAdminPassword = "ChangeMe123!";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().default(3000),
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().default(`file:${path.join(defaultDataDir, "sqlite", "jokitugasku.db")}`),
  JWT_SECRET: z.string().default(defaultJwtSecret),
  JWT_EXPIRES_IN: z.string().default("8h"),
  COOKIE_SECURE: z.coerce.boolean().default(false),
  ADMIN_EMAIL: z.string().email().default("admin@example.com"),
  ADMIN_PASSWORD: z.string().min(8).default(defaultAdminPassword),
  ADMIN_NAME: z.string().default("Seed Admin"),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().url().default("https://openrouter.ai/api/v1"),
  OPENROUTER_MODEL: z.string().default("openai/gpt-4o-mini"),
  OPENROUTER_REFERER: z.string().optional(),
  OPENROUTER_TITLE: z.string().default("JokiTugasKu Support AI"),
  AI_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.8),
  DATA_DIR: z.string().default(defaultDataDir),
  WHATSAPP_SESSION_DIR: z.string().optional(),
  WHATSAPP_SESSION_ENCRYPTION_KEY: z.string().optional(),
  MEDIA_DIR: z.string().optional(),
  BACKUP_DIR: z.string().optional(),
  MESSAGE_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(20),
  AI_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(10),
  AI_DAILY_LIMIT: z.coerce.number().default(100),
  AI_CONTACT_DAILY_LIMIT: z.coerce.number().default(25),
  AI_DEFAULT_ENABLED: z.coerce.boolean().default(false),
  ORDER_WEBHOOK_URL: z.string().url().optional().or(z.literal("")),
  ORDER_WEBHOOK_SECRET: z.string().optional(),
  ORDER_WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  ORDER_WEBHOOK_BACKOFF_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  BACKUP_INTERVAL_MINUTES: z.coerce.number().int().min(0).default(0),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),
  MESSAGE_QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  MESSAGE_QUEUE_RETRY_SECONDS: z.coerce.number().int().min(1).max(3600).default(30),
  AUDIT_REDACTION_KEYS: z.string().default("password,token,secret,csrf,authorization,cookie")
});

function validateProductionConfig(config: z.infer<typeof envSchema>) {
  if (config.NODE_ENV !== "production") {
    return config;
  }

  const unsafeDefaults: string[] = [];
  if (config.JWT_SECRET === defaultJwtSecret) {
    unsafeDefaults.push("JWT_SECRET");
  }
  if (config.ADMIN_PASSWORD === defaultAdminPassword) {
    unsafeDefaults.push("ADMIN_PASSWORD");
  }

  if (unsafeDefaults.length > 0) {
    throw new Error(`Refusing to start in production with default values for: ${unsafeDefaults.join(", ")}`);
  }

  return config;
}

export const config = validateProductionConfig(envSchema.parse(process.env));

export const paths = {
  data: path.resolve(config.DATA_DIR),
  sqlite: path.resolve(config.DATA_DIR, "sqlite"),
  whatsappSessions: path.resolve(config.WHATSAPP_SESSION_DIR ?? path.join(config.DATA_DIR, "whatsapp-sessions")),
  media: path.resolve(config.MEDIA_DIR ?? path.join(config.DATA_DIR, "media")),
  backups: path.resolve(config.BACKUP_DIR ?? path.join(config.DATA_DIR, "backups")),
  public: path.resolve(process.cwd(), "public")
};

export function ensureRuntimeDirs() {
  for (const dir of [paths.data, paths.sqlite, paths.whatsappSessions, paths.media, paths.backups]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function databaseFilePath() {
  if (!config.DATABASE_URL.startsWith("file:")) {
    return null;
  }
  const dbPath = config.DATABASE_URL.slice(5);
  return path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), "prisma", dbPath);
}
