import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BufferJSON, initAuthCreds, proto, useMultiFileAuthState, type AuthenticationState } from "@whiskeysockets/baileys";
import { config } from "./config.js";

const encryptedVersion = 1;

type EncryptedEnvelope = {
  version: number;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
};

export async function useLocalWhatsappAuthState(folder: string) {
  if (!config.WHATSAPP_SESSION_ENCRYPTION_KEY) {
    return useMultiFileAuthState(folder);
  }

  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const readData = async (file: string) => {
    try {
      const raw = await fs.readFile(path.join(folder, fixFileName(file)), "utf8");
      return JSON.parse(decryptOrPlaintext(raw), BufferJSON.reviver);
    } catch {
      return null;
    }
  };
  const writeData = async (data: unknown, file: string) => {
    await fs.writeFile(path.join(folder, fixFileName(file)), encrypt(JSON.stringify(data, BufferJSON.replacer)), { mode: 0o600 });
  };
  const removeData = async (file: string) => {
    await fs.rm(path.join(folder, fixFileName(file)), { force: true });
  };

  const creds = (await readData("creds.json")) || initAuthCreds();
  const state = {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        const data: Record<string, unknown> = {};
        await Promise.all(ids.map(async (id) => {
          let value = await readData(`${type}-${id}.json`);
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[id] = value;
        }));
        return data;
      },
      set: async (data: Record<string, Record<string, unknown>>) => {
        const tasks: Array<Promise<void>> = [];
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            tasks.push(value ? writeData(value, `${category}-${id}.json`) : removeData(`${category}-${id}.json`));
          }
        }
        await Promise.all(tasks);
      }
    }
  } as unknown as AuthenticationState;

  return {
    state,
    saveCreds: async () => writeData(creds, "creds.json")
  };
}

export async function encryptExistingSessionFiles(folder: string) {
  if (!config.WHATSAPP_SESSION_ENCRYPTION_KEY) return { encrypted: false, files: 0 };
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(folder, { withFileTypes: true });
  let files = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(folder, entry.name);
    const raw = await fs.readFile(filePath, "utf8");
    if (isEncrypted(raw)) continue;
    JSON.parse(raw, BufferJSON.reviver);
    await fs.writeFile(filePath, encrypt(raw), { mode: 0o600 });
    files += 1;
  }
  return { encrypted: true, files };
}

export function sessionEncryptionEnabled() {
  return Boolean(config.WHATSAPP_SESSION_ENCRYPTION_KEY);
}

function fixFileName(file: string) {
  return file.replace(/\//g, "__").replace(/:/g, "-");
}

function key() {
  return crypto.createHash("sha256").update(config.WHATSAPP_SESSION_ENCRYPTION_KEY ?? "").digest();
}

function encrypt(plaintext: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const envelope: EncryptedEnvelope = {
    version: encryptedVersion,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64")
  };
  return JSON.stringify(envelope);
}

function decryptOrPlaintext(raw: string) {
  if (!isEncrypted(raw)) return raw;
  const envelope = JSON.parse(raw) as EncryptedEnvelope;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
}

function isEncrypted(raw: string) {
  try {
    const parsed = JSON.parse(raw) as Partial<EncryptedEnvelope>;
    return parsed.version === encryptedVersion && parsed.algorithm === "aes-256-gcm" && typeof parsed.data === "string";
  } catch {
    return false;
  }
}
