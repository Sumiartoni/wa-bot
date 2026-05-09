import crypto from "node:crypto";
import type { Server } from "socket.io";
import { audit } from "./audit.js";
import { config } from "./config.js";
import { prisma } from "./db.js";

let processing = false;
let timer: NodeJS.Timeout | null = null;

export async function ensureConfiguredWebhookEndpoint() {
  if (!config.ORDER_WEBHOOK_URL) return null;
  return prisma.webhookEndpoint.upsert({
    where: { name: "order_default" },
    update: {
      url: config.ORDER_WEBHOOK_URL,
      secret: config.ORDER_WEBHOOK_SECRET || null,
      enabled: true,
      maxAttempts: config.ORDER_WEBHOOK_MAX_ATTEMPTS,
      backoffSeconds: config.ORDER_WEBHOOK_BACKOFF_SECONDS
    },
    create: {
      name: "order_default",
      url: config.ORDER_WEBHOOK_URL,
      secret: config.ORDER_WEBHOOK_SECRET || null,
      enabled: true,
      maxAttempts: config.ORDER_WEBHOOK_MAX_ATTEMPTS,
      backoffSeconds: config.ORDER_WEBHOOK_BACKOFF_SECONDS
    }
  });
}

export async function queueOrderWebhook(orderId: number, event: string, actorId?: number | null) {
  await ensureConfiguredWebhookEndpoint();
  const endpoints = await prisma.webhookEndpoint.findMany({ where: { enabled: true } });
  if (endpoints.length === 0) return [];
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { contact: true } });
  if (!order) return [];
  const payload = JSON.stringify({ event, order, queuedAt: new Date().toISOString() });
  const deliveries = await Promise.all(endpoints.map((endpoint) => prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      orderId,
      event,
      status: "pending",
      nextAttemptAt: new Date(),
      payload
    }
  })));
  await audit({ action: "order_webhook_queued", actorId, targetType: "order", targetId: orderId, meta: { event, deliveries: deliveries.length } });
  return deliveries;
}

export function startWebhookWorker(io: Server) {
  if (timer) return;
  timer = setInterval(() => {
    processDueWebhookDeliveries(io).catch((error) => console.error("Webhook delivery worker failed", error));
  }, 10_000);
  timer.unref();
  processDueWebhookDeliveries(io).catch((error) => console.error("Webhook delivery worker failed", error));
}

export async function processDueWebhookDeliveries(io?: Server) {
  if (processing) return { processed: 0 };
  processing = true;
  try {
    const due = await prisma.webhookDelivery.findMany({
      where: { status: { in: ["pending", "retrying"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }] },
      include: { endpoint: true },
      orderBy: { createdAt: "asc" },
      take: 10
    });
    for (const delivery of due) {
      await deliverOnce(delivery.id, io);
    }
    return { processed: due.length };
  } finally {
    processing = false;
  }
}

export async function retryWebhookDelivery(id: number) {
  return prisma.webhookDelivery.update({ where: { id }, data: { status: "pending", nextAttemptAt: new Date(), error: null } });
}

export async function upsertWebhookEndpoint(input: { name: string; url: string; secret?: string | null; enabled: boolean; maxAttempts: number; backoffSeconds: number }) {
  return prisma.webhookEndpoint.upsert({
    where: { name: input.name },
    update: input,
    create: input
  });
}

export async function testWebhookEndpoint(id: number) {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id } });
  if (!endpoint) throw Object.assign(new Error("Webhook endpoint not found"), { statusCode: 404 });
  const payload = JSON.stringify({ event: "webhook.test", queuedAt: new Date().toISOString() });
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "jokitugasku-wa-bot/0.1" };
  if (endpoint.secret) headers["X-Jokitugasku-Signature"] = crypto.createHmac("sha256", endpoint.secret).update(payload).digest("hex");
  const response = await fetch(endpoint.url, { method: "POST", headers, body: payload });
  return { ok: response.ok, status: response.status, body: (await response.text()).slice(0, 2000) };
}

async function deliverOnce(id: number, io?: Server) {
  const delivery = await prisma.webhookDelivery.findUnique({ where: { id }, include: { endpoint: true } });
  if (!delivery || !delivery.endpoint.enabled) return;
  const attempt = delivery.attempts + 1;
  await prisma.webhookDelivery.update({ where: { id }, data: { attempts: attempt, lastAttemptAt: new Date(), status: "processing" } });

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "jokitugasku-wa-bot/0.1" };
    if (delivery.endpoint.secret) {
      headers["X-Jokitugasku-Signature"] = crypto.createHmac("sha256", delivery.endpoint.secret).update(delivery.payload).digest("hex");
    }
    const response = await fetch(delivery.endpoint.url, { method: "POST", headers, body: delivery.payload });
    const responseBody = (await response.text()).slice(0, 2000);
    if (response.ok) {
      const updated = await prisma.webhookDelivery.update({ where: { id }, data: { status: "delivered", responseStatus: response.status, responseBody, nextAttemptAt: null, error: null } });
      emitWebhookUpdate(io, updated);
      return;
    }
    await markRetryOrFailed(id, attempt, delivery.endpoint.maxAttempts, delivery.endpoint.backoffSeconds, `HTTP ${response.status}`, response.status, responseBody, io);
  } catch (error) {
    await markRetryOrFailed(id, attempt, delivery.endpoint.maxAttempts, delivery.endpoint.backoffSeconds, error instanceof Error ? error.message : "Webhook delivery failed", null, null, io);
  }
}

async function markRetryOrFailed(id: number, attempt: number, maxAttempts: number, backoffSeconds: number, error: string, responseStatus: number | null, responseBody: string | null, io?: Server) {
  const exhausted = attempt >= maxAttempts;
  const delaySeconds = backoffSeconds * 2 ** Math.max(0, attempt - 1);
  const updated = await prisma.webhookDelivery.update({
    where: { id },
    data: {
      status: exhausted ? "failed" : "retrying",
      nextAttemptAt: exhausted ? null : new Date(Date.now() + delaySeconds * 1000),
      responseStatus,
      responseBody,
      error
    }
  });
  emitWebhookUpdate(io, updated);
}

function emitWebhookUpdate(io: Server | undefined, payload: unknown) {
  io?.emit("webhook:update", { delivery: payload });
}
