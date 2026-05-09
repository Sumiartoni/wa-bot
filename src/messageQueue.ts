import type { Server } from "socket.io";
import { audit } from "./audit.js";
import { prisma } from "./db.js";
import { currentPolicies } from "./policies.js";
import { sendWhatsappMessage } from "./whatsapp.js";

let processing = false;
let timer: NodeJS.Timeout | null = null;

export function startMessageQueueWorker(io: Server) {
  if (timer) return;
  timer = setInterval(() => {
    processDueMessages(io).catch((error) => console.error("Message queue worker failed", error));
  }, 10_000);
  timer.unref();
  processDueMessages(io).catch((error) => console.error("Message queue worker failed", error));
}

export async function queueOutboundMessage(input: { conversationId: number; authorId: number; content: string; generatedBy: string; messageType?: string; mediaPath?: string | null; mediaMimeType?: string | null; mediaFileName?: string | null; mediaSizeBytes?: number | null; meta?: Record<string, unknown> }, io: Server) {
  const message = await prisma.message.create({
    data: {
      conversationId: input.conversationId,
      from: "admin",
      authorId: input.authorId,
      content: input.content,
      messageType: input.messageType ?? "text",
      mediaPath: input.mediaPath ?? null,
      mediaMimeType: input.mediaMimeType ?? null,
      mediaFileName: input.mediaFileName ?? null,
      mediaSizeBytes: input.mediaSizeBytes ?? null,
      generatedBy: input.generatedBy,
      status: "queued",
      queuedAt: new Date(),
      nextAttemptAt: new Date()
    }
  });
  await audit({ action: "message_queued", actorId: input.authorId, targetType: "message", targetId: message.id, meta: { type: input.generatedBy, ...input.meta } });
  io.emit("message:new", { message, conversationId: input.conversationId });
  io.emit("conversation:update", { conversationId: input.conversationId });
  await processDueMessages(io);
  return prisma.message.findUniqueOrThrow({ where: { id: message.id } });
}

export async function replayMessage(messageId: number, actorId: number, io: Server) {
  const message = await prisma.message.findUnique({ where: { id: messageId } });
  if (!message) throw Object.assign(new Error("Message not found"), { statusCode: 404 });
  if (message.from !== "admin") throw Object.assign(new Error("Only outbound messages can be replayed"), { statusCode: 400 });
  const updated = await prisma.message.update({ where: { id: messageId }, data: { status: "queued", nextAttemptAt: new Date(), failureReason: null, queuedAt: message.queuedAt ?? new Date() } });
  await audit({ action: "message_replay_requested", actorId, targetType: "message", targetId: messageId, meta: { previousStatus: message.status } });
  io.emit("message:status", { message: updated, conversationId: updated.conversationId });
  await processDueMessages(io);
  return prisma.message.findUniqueOrThrow({ where: { id: messageId } });
}

export async function processDueMessages(io?: Server) {
  if (processing) return { processed: 0 };
  processing = true;
  try {
    const due = await prisma.message.findMany({
      where: { from: "admin", status: { in: ["queued", "retrying"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
      include: { conversation: { include: { contact: true } } },
      orderBy: [{ conversationId: "asc" }, { createdAt: "asc" }],
      take: 20
    });
    let processed = 0;
    const seenConversations = new Set<number>();
    for (const message of due) {
      if (seenConversations.has(message.conversationId)) continue;
      seenConversations.add(message.conversationId);
      const earlier = await prisma.message.count({ where: { conversationId: message.conversationId, from: "admin", status: { in: ["queued", "retrying", "sending"] }, createdAt: { lt: message.createdAt } } });
      if (earlier > 0) continue;
      await deliverMessage(message.id, io);
      processed += 1;
    }
    return { processed };
  } finally {
    processing = false;
  }
}

async function deliverMessage(messageId: number, io?: Server) {
  const message = await prisma.message.update({ where: { id: messageId }, data: { status: "sending", lastAttemptAt: new Date(), attempts: { increment: 1 } }, include: { conversation: { include: { contact: true } } } });
  emitStatus(io, message);
  const result = await sendWhatsappMessage({ jid: message.conversation.contact.waId, text: message.content, mediaPath: message.mediaPath, mediaMimeType: message.mediaMimeType, mediaFileName: message.mediaFileName });
  if (result.sent) {
    const sent = await prisma.message.update({ where: { id: message.id }, data: { status: "sent", waId: result.waId ?? null, sentAt: new Date(), nextAttemptAt: null, failureReason: null } });
    emitStatus(io, sent);
    await audit({ action: "message_sent", actorId: message.authorId, targetType: "message", targetId: message.id, meta: { whatsapp: result, attempts: sent.attempts } });
    return sent;
  }
  const maxAttempts = currentPolicies().messageQueueMaxAttempts;
  const retrySeconds = currentPolicies().messageQueueRetrySeconds;
  const failed = message.attempts >= maxAttempts;
  const updated = await prisma.message.update({
    where: { id: message.id },
    data: { status: failed ? "failed" : "retrying", failureReason: result.reason ?? "WhatsApp send failed", nextAttemptAt: failed ? null : new Date(Date.now() + retrySeconds * 1000) }
  });
  emitStatus(io, updated);
  await audit({ action: failed ? "message_failed" : "message_retry_scheduled", actorId: message.authorId, targetType: "message", targetId: message.id, meta: { reason: result.reason, attempts: updated.attempts } });
  return updated;
}

function emitStatus(io: Server | undefined, message: { id: number; conversationId: number; status: string }) {
  io?.emit("message:status", { message, conversationId: message.conversationId });
  io?.emit("conversation:update", { conversationId: message.conversationId });
}
