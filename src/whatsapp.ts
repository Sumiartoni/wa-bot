import fs from "node:fs";
import path from "node:path";
import type { Server } from "socket.io";
import makeWASocket, { DisconnectReason, downloadMediaMessage, getContentType, type WAMessage } from "@whiskeysockets/baileys";
import { audit } from "./audit.js";
import { paths } from "./config.js";
import { prisma } from "./db.js";
import { encryptExistingSessionFiles, sessionEncryptionEnabled, useLocalWhatsappAuthState } from "./sessionStorage.js";
import { currentPolicies } from "./policies.js";

type SessionRuntime = {
  socket?: ReturnType<typeof makeWASocket>;
  status: "idle" | "connecting" | "connected" | "disconnected" | "error";
  lastQr?: string;
  error?: string;
};

const runtime: SessionRuntime = { status: "idle" };

export function getWhatsappRuntime() {
  return runtime;
}

async function upsertLocalSession(connected: boolean, lastQr?: string | null) {
  return prisma.whatsappSession.upsert({
    where: { sessionName: "local" },
    update: { connected, lastQr, encryptionEnabled: sessionEncryptionEnabled(), lastConnectedAt: connected ? new Date() : undefined },
    create: { sessionName: "local", filePath: paths.whatsappSessions, connected, lastQr, encryptionEnabled: sessionEncryptionEnabled() }
  });
}

export async function connectWhatsapp(io: Server, actorId: number) {
  if (runtime.status === "connecting" || runtime.status === "connected") {
    return { status: runtime.status, qr: runtime.lastQr };
  }

  fs.mkdirSync(paths.whatsappSessions, { recursive: true, mode: 0o700 });
  await encryptExistingSessionFiles(paths.whatsappSessions);
  runtime.status = "connecting";
  runtime.error = undefined;
  await upsertLocalSession(false, runtime.lastQr ?? null);

  const { state, saveCreds } = await useLocalWhatsappAuthState(paths.whatsappSessions);
  const socket = makeWASocket({ auth: state, printQRInTerminal: false });
  runtime.socket = socket;

  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async (update) => {
    if (update.qr) {
      runtime.lastQr = update.qr;
      runtime.status = "connecting";
      await upsertLocalSession(false, update.qr);
      emitSessionUpdate(io, { sessionName: "local", status: runtime.status, qrAvailable: true });
      emitQrUpdate(io, { sessionName: "local", status: runtime.status, qr: update.qr });
    }

    if (update.connection === "open") {
      runtime.status = "connected";
      runtime.lastQr = undefined;
      await upsertLocalSession(true, null);
      await audit({ action: "whatsapp_connected", actorId, targetType: "whatsapp_session", targetId: null, meta: { sessionName: "local" } });
      emitSessionUpdate(io, { sessionName: "local", status: runtime.status });
      emitQrUpdate(io, { sessionName: "local", status: runtime.status, qr: null });
    }

    if (update.connection === "close") {
      const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      runtime.status = statusCode === DisconnectReason.loggedOut ? "disconnected" : "idle";
      await upsertLocalSession(false, runtime.lastQr ?? null);
      emitSessionUpdate(io, { sessionName: "local", status: runtime.status });
    }
  });

  socket.ev.on("messages.update", async (updates) => {
    for (const update of updates) {
      const waId = update.key.id;
      if (!waId) continue;
      const status = mapWhatsappStatus(update.update.status);
      if (!status) continue;
      const data = status === "read" ? { status, readAt: new Date(), deliveredAt: new Date() } : status === "delivered" ? { status, deliveredAt: new Date() } : { status };
      const result = await prisma.message.updateMany({ where: { waId }, data });
      if (result.count > 0) io.emit("message:status", { waId, status });
    }
  });

  socket.ev.on("messages.upsert", async (event) => {
    for (const incoming of event.messages) {
      const jid = incoming.key.remoteJid;
      if (!jid || incoming.key.fromMe || !incoming.message) continue;
      const media = await persistIncomingMedia(incoming);
      const text = incoming.message.conversation ?? incoming.message.extendedTextMessage?.text ?? media.caption ?? media.fileName ?? `[${media.messageType} message]`;

      const contact = await prisma.contact.upsert({
        where: { waId: jid },
        update: {},
        create: { waId: jid, name: incoming.pushName ?? jid, phone: jid.split("@")[0] ?? jid, aiEnabled: currentPolicies().aiDefaultEnabled }
      });
      const conversation = await prisma.conversation.upsert({
        where: { id: contact.id },
        update: { lastMessageAt: new Date(), unreadCount: { increment: 1 } },
        create: { id: contact.id, contactId: contact.id, unreadCount: 1 }
      });
      const message = await prisma.message.create({
        data: { conversationId: conversation.id, waId: incoming.key.id, from: "contact", content: text, generatedBy: "manual", status: "delivered", deliveredAt: new Date(), messageType: media.messageType, mediaPath: media.mediaPath, mediaMimeType: media.mimeType, mediaFileName: media.fileName, mediaSizeBytes: media.sizeBytes }
      });
      io.emit("message:new", { message, conversationId: conversation.id });
      io.emit("conversation:update", { conversationId: conversation.id });
      await queueMatchingAutomation(conversation.id, contact.id, text, io);
    }
  });

  return { status: runtime.status, qr: runtime.lastQr };
}

export async function disconnectWhatsapp(io: Server, actorId: number) {
  if (runtime.socket) {
    await runtime.socket.logout().catch(() => undefined);
    runtime.socket = undefined;
  }
  runtime.status = "disconnected";
  runtime.lastQr = undefined;
  await upsertLocalSession(false, null);
  await audit({ action: "whatsapp_disconnected", actorId, targetType: "whatsapp_session", targetId: null, meta: { sessionName: "local" } });
  emitSessionUpdate(io, { sessionName: "local", status: runtime.status });
  emitQrUpdate(io, { sessionName: "local", status: runtime.status, qr: null });
  return { status: runtime.status };
}

export async function rotateWhatsappSession(io: Server, actorId: number) {
  await disconnectWhatsapp(io, actorId);
  removeWhatsappSessionFiles();
  runtime.status = "idle";
  runtime.lastQr = undefined;
  const session = await prisma.whatsappSession.upsert({
    where: { sessionName: "local" },
    update: { connected: false, lastQr: null, rotatedAt: new Date(), revokedAt: null, encryptionEnabled: sessionEncryptionEnabled() },
    create: { sessionName: "local", filePath: paths.whatsappSessions, connected: false, rotatedAt: new Date(), encryptionEnabled: sessionEncryptionEnabled() }
  });
  await audit({ action: "whatsapp_session_rotated", actorId, targetType: "whatsapp_session", targetId: session.id, meta: { sessionName: "local" } });
  emitSessionUpdate(io, { sessionName: "local", status: runtime.status, rotatedAt: session.rotatedAt });
  emitQrUpdate(io, { sessionName: "local", status: runtime.status, qr: null });
  return { status: runtime.status, session };
}

export async function revokeWhatsappSession(io: Server, actorId: number) {
  await disconnectWhatsapp(io, actorId);
  removeWhatsappSessionFiles();
  runtime.status = "disconnected";
  runtime.lastQr = undefined;
  const session = await prisma.whatsappSession.upsert({
    where: { sessionName: "local" },
    update: { connected: false, lastQr: null, revokedAt: new Date(), encryptionEnabled: sessionEncryptionEnabled() },
    create: { sessionName: "local", filePath: paths.whatsappSessions, connected: false, revokedAt: new Date(), encryptionEnabled: sessionEncryptionEnabled() }
  });
  await audit({ action: "whatsapp_session_revoked", actorId, targetType: "whatsapp_session", targetId: session.id, meta: { sessionName: "local" } });
  emitSessionUpdate(io, { sessionName: "local", status: runtime.status, revokedAt: session.revokedAt });
  emitQrUpdate(io, { sessionName: "local", status: runtime.status, qr: null });
  return { status: runtime.status, session };
}

export async function sendWhatsappMessage(input: { jid: string; text: string; mediaPath?: string | null; mediaMimeType?: string | null; mediaFileName?: string | null }) {
  if (runtime.status !== "connected" || !runtime.socket) {
    return { sent: false, reason: "WhatsApp is not connected" };
  }
  const result = await runtime.socket.sendMessage(input.jid, buildOutboundPayload(input) as never);
  return { sent: true, waId: result?.key.id };
}

export async function sendWhatsappText(jid: string, text: string) {
  return sendWhatsappMessage({ jid, text });
}

export function removeWhatsappSessionFiles() {
  if (fs.existsSync(paths.whatsappSessions)) {
    for (const entry of fs.readdirSync(paths.whatsappSessions)) {
      fs.rmSync(path.join(paths.whatsappSessions, entry), { recursive: true, force: true });
    }
  }
}

function emitSessionUpdate(io: Server, payload: Record<string, unknown>) {
  for (const [, socket] of io.sockets.sockets) {
    if (socket.data.user?.role === "superadmin") {
      socket.emit("session:update", payload);
    }
  }
}

function emitQrUpdate(io: Server, payload: Record<string, unknown>) {
  io.to("whatsapp:admins").emit("session:qr", payload);
}

function mapWhatsappStatus(status: unknown) {
  if (status === 4 || status === "READ") return "read";
  if (status === 3 || status === "DELIVERY_ACK") return "delivered";
  if (status === 2 || status === "SERVER_ACK") return "sent";
  return null;
}

function buildOutboundPayload(input: { text: string; mediaPath?: string | null; mediaMimeType?: string | null; mediaFileName?: string | null }) {
  if (!input.mediaPath) return { text: input.text };
  const buffer = fs.readFileSync(input.mediaPath);
  const mimetype = input.mediaMimeType ?? "application/octet-stream";
  if (mimetype.startsWith("image/")) return { image: buffer, caption: input.text, mimetype };
  if (mimetype.startsWith("video/")) return { video: buffer, caption: input.text, mimetype };
  if (mimetype.startsWith("audio/")) return { audio: buffer, mimetype };
  return { document: buffer, caption: input.text, mimetype, fileName: input.mediaFileName ?? path.basename(input.mediaPath) };
}

async function persistIncomingMedia(incoming: WAMessage) {
  const messageType = incoming.message ? getContentType(incoming.message) ?? "text" : "text";
  if (messageType === "conversation" || messageType === "extendedTextMessage") return { messageType: "text", mediaPath: null, mimeType: null, fileName: null, sizeBytes: null, caption: null };
  const content = (incoming.message as Record<string, unknown> | undefined)?.[messageType] as { mimetype?: string; fileName?: string; caption?: string } | undefined;
  try {
    fs.mkdirSync(paths.media, { recursive: true, mode: 0o700 });
    const buffer = await downloadMediaMessage(incoming, "buffer", {});
    const fileName = `${Date.now()}-${incoming.key.id ?? "message"}${mediaExtension(content?.mimetype, content?.fileName)}`;
    const mediaPath = path.join(paths.media, fileName);
    fs.writeFileSync(mediaPath, buffer as Buffer, { mode: 0o600 });
    return { messageType, mediaPath, mimeType: content?.mimetype ?? null, fileName: content?.fileName ?? fileName, sizeBytes: (buffer as Buffer).length, caption: content?.caption ?? null };
  } catch {
    return { messageType, mediaPath: null, mimeType: content?.mimetype ?? null, fileName: content?.fileName ?? null, sizeBytes: null, caption: content?.caption ?? null };
  }
}

function mediaExtension(mimeType?: string, fileName?: string) {
  if (fileName && path.extname(fileName)) return path.extname(fileName);
  if (mimeType?.includes("jpeg")) return ".jpg";
  if (mimeType?.includes("png")) return ".png";
  if (mimeType?.includes("pdf")) return ".pdf";
  if (mimeType?.includes("mpeg")) return ".mp3";
  if (mimeType?.includes("mp4")) return ".mp4";
  return ".bin";
}

async function queueMatchingAutomation(conversationId: number, contactId: number, text: string, io: Server) {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact || contact.optOut) return;
  const lower = text.toLowerCase();
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const macros = await prisma.automationMacro.findMany({ where: { enabled: true }, orderBy: { updatedAt: "desc" } });
  const macro = macros.find((candidate) => splitList(candidate.keywords).some((keyword) => tokens.has(keyword.toLowerCase()) || lower.includes(keyword.toLowerCase())));
  if (!macro) return;
  const body = macro.body.replace(/{{\s*name\s*}}/g, contact.name);
  const queued = await prisma.message.create({ data: { conversationId, from: "admin", content: body, generatedBy: "automation", status: "queued", queuedAt: new Date(), nextAttemptAt: new Date() } });
  await audit({ action: "automation_macro_queued", actorId: null, targetType: "automation_macro", targetId: macro.id, meta: { conversationId, messageId: queued.id } });
  io.emit("message:new", { message: queued, conversationId });
  io.emit("conversation:update", { conversationId });
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
