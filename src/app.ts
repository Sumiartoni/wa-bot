import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { Router, type ErrorRequestHandler, type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createServer } from "node:http";
import { Server } from "socket.io";
import type { Prisma } from "@prisma/client";
import { audit, verifyAuditChain } from "./audit.js";
import { authCookieOptions, decodeAuthToken, readToken, requireAuth, requireCsrf, requireRole, signAuthToken } from "./auth.js";
import { createWhatsappSessionArchive, getBackupStatus, restartBackupScheduler, restoreBackup, runBackup, startBackupScheduler, validateBackup } from "./backup.js";
import { config, paths } from "./config.js";
import { prisma } from "./db.js";
import { queueOutboundMessage, replayMessage, startMessageQueueWorker } from "./messageQueue.js";
import { currentPolicies, loadPolicies, updatePolicies, type RuntimePolicyUpdate } from "./policies.js";
import { checkAiQuota, checkMessageRate, rateLimitStatus } from "./rateLimits.js";
import type { AuthedRequest } from "./types.js";
import { connectWhatsapp, disconnectWhatsapp, getWhatsappRuntime, removeWhatsappSessionFiles, revokeWhatsappSession, rotateWhatsappSession } from "./whatsapp.js";
import { ensureConfiguredWebhookEndpoint, processDueWebhookDeliveries, queueOrderWebhook, retryWebhookDelivery, startWebhookWorker, testWebhookEndpoint, upsertWebhookEndpoint } from "./webhooks.js";

const unsafeJsonLimit = "1mb";
const requestMetrics: RequestMetric[] = [];
const maxRequestMetricSamples = 1000;

type RequestMetric = {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  finishedAt: number;
};

type ApiEnvelope<T = unknown> = { success: true; data: T } | { success: false; error: { message: string; code?: string; details?: unknown } };

export function createApp() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, { cors: { origin: config.APP_ORIGIN, credentials: true } });

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: config.APP_ORIGIN, credentials: true }));
  app.use(express.json({ limit: unsafeJsonLimit }));
  app.use(cookieParser());
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));

  io.use((socket, next) => {
    const token = typeof socket.handshake.auth.token === "string" ? socket.handshake.auth.token : undefined;
    const user = token ? decodeAuthToken(token) : null;
    if (!user) return next(new Error("Authentication required"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    if (socket.data.user?.role === "superadmin") {
      socket.join("whatsapp:admins");
    }
    socket.emit("session:update", { sessionName: "local", status: getWhatsappRuntime().status });
  });

  ensureConfiguredWebhookEndpoint().catch((error) => console.error("Webhook endpoint configuration failed", error));
  loadPolicies().then(() => startBackupScheduler()).catch((error) => console.error("Policy/bootstrap failed", error));
  startWebhookWorker(io);
  startMessageQueueWorker(io);

  const api = Router();
  app.use("/api", api);
  api.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (body && typeof body === "object" && "success" in (body as Record<string, unknown>)) {
        return originalJson(body);
      }
      if (res.statusCode >= 400) {
        const source = typeof body === "object" && body ? body as Record<string, unknown> : {};
        const message = typeof source.error === "string" ? source.error : typeof source.message === "string" ? source.message : "Request failed";
        const code = typeof source.code === "string" ? source.code : undefined;
        const details = source.details;
        return originalJson({ success: false, error: { message, code, details } } satisfies ApiEnvelope);
      }
      return originalJson({ success: true, data: body } satisfies ApiEnvelope);
    }) as typeof res.json;
    next();
  });
  api.use(recordRequestMetric);

  api.get("/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: "jokitugasku-wa-bot", time: new Date().toISOString() });
  });

  api.post("/auth/login", async (req, res) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !(await bcrypt.compare(body.password, user.passwordHash))) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
    const sessionId = crypto.randomUUID();
    const token = signAuthToken({ id: user.id, sessionId, email: user.email, name: user.name, role: user.role });
    const decoded = decodeAuthToken(token)!;
    const expiresAt = new Date(Date.now() + parseExpiresInMilliseconds(config.JWT_EXPIRES_IN));
    await prisma.adminSession.create({ data: { sessionId, userId: user.id, expiresAt } });
    res.cookie("auth_token", token, authCookieOptions());
    await audit({ action: "auth_login", actorId: user.id, targetType: "user", targetId: user.id, meta: {} });
    res.json({ token, csrfToken: decoded.csrfToken, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  });

  api.post("/auth/logout", requireAuth, requireCsrf, async (req, res) => {
    const user = (req as unknown as AuthedRequest).user;
    await prisma.adminSession.updateMany({ where: { sessionId: user.sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
    res.clearCookie("auth_token", { path: "/" });
    await audit({ action: "auth_logout", actorId: user.id, targetType: "user", targetId: user.id, meta: {} });
    res.json({ ok: true });
  });

  api.get("/auth/me", requireAuth, (req, res) => {
    const user = (req as unknown as AuthedRequest).user;
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, csrfToken: user.csrfToken });
  });

  api.get("/csrf", requireAuth, (req, res) => {
    res.json({ csrfToken: (req as unknown as AuthedRequest).user.csrfToken });
  });

  api.use(requireAuth);
  api.use(requireCsrf);

  api.get("/status", async (_req, res) => {
    const [users, contacts, conversations, messages, aiGenerations, backups] = await Promise.all([
      prisma.user.count(), prisma.contact.count(), prisma.conversation.count(), prisma.message.count(), prisma.aiGeneration.count(), prisma.backupRun.count()
    ]);
    const whatsapp = getWhatsappRuntime();
    res.json({
      database: "ok",
      whatsapp: {
        status: whatsapp.status,
        hasQr: Boolean(whatsapp.lastQr),
        hasError: Boolean(whatsapp.error)
      },
      counts: { users, contacts, conversations, messages, aiGenerations, backups }
    });
  });

  api.get("/metrics", async (_req, res) => {
    const since24h = new Date(Date.now() - 86_400_000);
    const since1h = new Date(Date.now() - 3_600_000);
    const [messagesByType, aiCount, openOrders, messagesLast24h, messagesLastHour, auditLast24h, latestBackup] = await Promise.all([
      prisma.message.groupBy({ by: ["generatedBy"], _count: true }),
      prisma.aiGeneration.count(),
      prisma.order.count({ where: { status: { not: "completed" } } }),
      prisma.message.count({ where: { createdAt: { gte: since24h } } }),
      prisma.message.count({ where: { createdAt: { gte: since1h } } }),
      prisma.auditLog.count({ where: { createdAt: { gte: since24h } } }),
      prisma.backupRun.findFirst({ orderBy: { createdAt: "desc" } })
    ]);
    res.json({
      messagesByType,
      aiCount,
      openOrders,
      throughput: {
        api: summarizeRequestMetrics(),
        messagesLastHour,
        messagesLast24h,
        auditEventsLast24h: auditLast24h
      },
      backups: { latest: latestBackup },
      rateLimits: rateLimitStatus()
    });
  });

  api.get("/rate-limits/status", (_req, res) => res.json({ buckets: rateLimitStatus() }));

  api.get("/admin/users", requireRole(["superadmin"]), async (_req, res) => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, email: true, name: true, role: true, createdAt: true, lastActiveAt: true } });
    res.json({ users });
  });

  api.get("/admin/auth-sessions", requireRole(["superadmin"]), async (_req, res) => {
    const sessions = await prisma.adminSession.findMany({ include: { user: { select: { id: true, email: true, name: true, role: true } } }, orderBy: { createdAt: "desc" } });
    res.json({ sessions });
  });

  api.post("/admin/auth-sessions/:id/revoke", requireRole(["superadmin"]), async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const session = await prisma.adminSession.update({ where: { id }, data: { revokedAt: new Date() }, include: { user: { select: { id: true, email: true, name: true, role: true } } } });
    await audit({ action: "admin_session_revoked", actorId: (req as unknown as AuthedRequest).user.id, targetType: "admin_session", targetId: id, meta: { sessionId: session.sessionId, userId: session.userId } });
    res.json({ session });
  });

  api.post("/admin/users", requireRole(["superadmin"]), async (req, res) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(8), name: z.string().min(1), role: z.enum(["superadmin", "agent"]).default("agent") }).parse(req.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.create({ data: { email: body.email, passwordHash, name: body.name, role: body.role }, select: { id: true, email: true, name: true, role: true, createdAt: true, lastActiveAt: true } });
    await audit({ action: "user_created", actorId: (req as unknown as AuthedRequest).user.id, targetType: "user", targetId: user.id, meta: { email: user.email, role: user.role } });
    res.status(201).json({ user });
  });

  api.patch("/admin/users/:id", requireRole(["superadmin"]), async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ email: z.string().email().optional(), password: z.string().min(8).optional(), name: z.string().min(1).optional(), role: z.enum(["superadmin", "agent"]).optional() }).parse(req.body);
    if (body.role && body.role !== "superadmin") {
      const [target, superadmins] = await Promise.all([prisma.user.findUnique({ where: { id } }), prisma.user.count({ where: { role: "superadmin" } })]);
      if (target?.role === "superadmin" && superadmins <= 1) return res.status(400).json({ error: "Cannot remove the last superadmin" });
    }
    const { password, ...safeBody } = body;
    const data = { ...safeBody, ...(password ? { passwordHash: await bcrypt.hash(password, 12) } : {}) };
    const user = await prisma.user.update({ where: { id }, data, select: { id: true, email: true, name: true, role: true, createdAt: true, lastActiveAt: true } });
    await audit({ action: "user_updated", actorId: (req as unknown as AuthedRequest).user.id, targetType: "user", targetId: user.id, meta: safeBody });
    res.json({ user });
  });

  api.get("/admin/sessions", requireRole(["superadmin"]), async (_req, res) => {
    const sessions = await prisma.whatsappSession.findMany({ orderBy: { createdAt: "desc" } });
    res.json({ sessions: sessions.map((session) => ({
      id: session.id,
      sessionName: session.sessionName,
      connected: session.connected,
      encryptionEnabled: session.encryptionEnabled,
      revokedAt: session.revokedAt,
      rotatedAt: session.rotatedAt,
      createdAt: session.createdAt,
      lastConnectedAt: session.lastConnectedAt
    })), runtime: { status: getWhatsappRuntime().status } });
  });

  api.get("/admin/sessions/:id/download", requireRole(["superadmin"]), async (req, res, next) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const session = await prisma.whatsappSession.findUnique({ where: { id } });
    if (!session) return res.status(404).json({ error: "Session not found" });
    try {
      const archive = await createWhatsappSessionArchive(session.sessionName, session.filePath, (req as unknown as AuthedRequest).user.id);
      res.download(archive.filePath, path.basename(archive.filePath), (error) => {
        if (error && !res.headersSent) next(error);
      });
    } catch (error) {
      next(error);
    }
  });

  api.post("/whatsapp/connect", requireRole(["superadmin"]), async (req, res) => {
    const result = await connectWhatsapp(io, (req as unknown as AuthedRequest).user.id);
    res.json(result);
  });

  api.get("/whatsapp/qr", requireRole(["superadmin"]), (_req, res) => {
    const runtime = getWhatsappRuntime();
    res.json({ status: runtime.status, qr: runtime.lastQr ?? null });
  });

  api.post("/whatsapp/disconnect", requireRole(["superadmin"]), async (req, res) => {
    const result = await disconnectWhatsapp(io, (req as unknown as AuthedRequest).user.id);
    res.json(result);
  });

  api.post("/whatsapp/session/rotate", requireRole(["superadmin"]), async (req, res) => {
    const result = await rotateWhatsappSession(io, (req as unknown as AuthedRequest).user.id);
    res.json(result);
  });

  api.post("/whatsapp/session/revoke", requireRole(["superadmin"]), async (req, res) => {
    const result = await revokeWhatsappSession(io, (req as unknown as AuthedRequest).user.id);
    res.json(result);
  });

  api.delete("/whatsapp/session-files", requireRole(["superadmin"]), async (req, res) => {
    removeWhatsappSessionFiles();
    await audit({ action: "whatsapp_session_files_removed", actorId: (req as unknown as AuthedRequest).user.id, targetType: "whatsapp_session", targetId: null, meta: {} });
    res.json({ ok: true });
  });

  api.get("/contacts", async (_req, res) => {
    res.json({ contacts: await prisma.contact.findMany({ orderBy: { createdAt: "desc" } }) });
  });

  api.patch("/contacts/:id", async (req, res) => {
    const params = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ name: z.string().optional(), tags: z.string().optional(), aiEnabled: z.boolean().optional(), optOut: z.boolean().optional() }).parse(req.body);
    const contact = await prisma.contact.update({ where: { id: params.id }, data: body });
    await audit({ action: "contact_updated", actorId: (req as unknown as AuthedRequest).user.id, targetType: "contact", targetId: contact.id, meta: body });
    res.json({ contact });
  });

  api.get("/conversations", async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const orderId = req.query.orderId ? z.coerce.number().parse(req.query.orderId) : undefined;
    const orderRef = typeof req.query.orderRef === "string" ? req.query.orderRef : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const filters: Prisma.ConversationWhereInput[] = [];
    if (search) filters.push({ OR: [{ contact: { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { waId: { contains: search } }, { tags: { contains: search } }] } }, { messages: { some: { content: { contains: search } } } }, { contact: { orders: { some: { orderRef: { contains: search } } } } }] });
    if (tag) filters.push({ contact: { tags: { contains: tag } } });
    if (orderId) filters.push({ contact: { orders: { some: { id: orderId } } } });
    if (orderRef) filters.push({ contact: { orders: { some: { orderRef: { contains: orderRef } } } } });
    if (status) filters.push({ messages: { some: { status } } });
    const conversations = await prisma.conversation.findMany({
      where: filters.length ? { AND: filters } : undefined,
      include: { contact: true, messages: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { lastMessageAt: "desc" }
    });
    res.json({ conversations });
  });

  api.get("/conversations/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      include: { contact: true, messages: { orderBy: { createdAt: "asc" } } }
    });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const [orders, knowledgeBase, suggestions] = await Promise.all([
      prisma.order.findMany({ where: { contactId: conversation.contactId }, orderBy: { createdAt: "desc" } }),
      prisma.knowledgeBase.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
      buildKeywordSuggestions(id)
    ]);
    res.json({ conversation, orders, knowledgeBase, suggestions });
  });

  api.get("/conversations/:id/suggestions", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const suggestions = await buildKeywordSuggestions(id);
    res.json({ suggestions });
  });

  api.post("/conversations/:id/message", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ text: z.string().min(1), type: z.enum(["manual", "template", "ai", "automation"]).default("manual"), mediaPath: z.string().optional(), mediaMimeType: z.string().optional(), mediaFileName: z.string().optional(), meta: z.record(z.unknown()).optional() }).parse(req.body);
    const conversation = await prisma.conversation.findUnique({ where: { id }, include: { contact: true } });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    if (conversation.contact.optOut && body.type !== "manual") return res.status(403).json({ error: "Contact opted out of automation" });
    const rate = checkMessageRate(conversation.contactId);
    if (!rate.allowed) return res.status(429).json({ error: "Message rate limit exceeded", resetAt: new Date(rate.resetAt).toISOString() });
    const media = body.mediaPath ? resolveLocalMedia(body.mediaPath) : null;
    const message = await queueOutboundMessage({ conversationId: id, authorId: (req as unknown as AuthedRequest).user.id, content: body.text, generatedBy: body.type, messageType: media ? "media" : "text", mediaPath: media, mediaMimeType: body.mediaMimeType, mediaFileName: body.mediaFileName, mediaSizeBytes: media ? fs.statSync(media).size : null, meta: body.meta }, io);
    await prisma.conversation.update({ where: { id }, data: { lastMessageAt: new Date(), unreadCount: 0 } });
    res.status(202).json({ message });
  });

  api.get("/conversations/:id/messages/queue", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const messages = await prisma.message.findMany({ where: { conversationId: id, from: "admin", status: { in: ["queued", "retrying", "sending", "failed"] } }, orderBy: { createdAt: "asc" } });
    res.json({ messages });
  });

  api.post("/messages/:id/replay", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const message = await replayMessage(id, (req as unknown as AuthedRequest).user.id, io);
    res.json({ message });
  });

  registerCrud(api, io);
  registerAi(api, io);
  registerBackupAndAudit(api);

  app.use(apiErrorHandler);

  app.use(express.static(paths.public));
  app.get("*", (_req, res, next) => {
    const indexPath = path.join(paths.public, "index.html");
    res.sendFile(indexPath, (error) => (error ? next() : undefined));
  });

  return { app, httpServer, io };
}

function registerCrud(api: Router, io: Server) {
  api.get("/templates", async (_req, res) => res.json({ templates: await prisma.template.findMany({ orderBy: { createdAt: "desc" } }) }));
  api.post("/templates", async (req, res) => {
    const body = z.object({ name: z.string().min(1), body: z.string().min(1), tags: z.string().default("") }).parse(req.body);
    const template = await prisma.template.create({ data: { ...body, createdBy: (req as unknown as AuthedRequest).user.id } });
    await audit({ action: "template_created", actorId: (req as unknown as AuthedRequest).user.id, targetType: "template", targetId: template.id, meta: {} });
    res.status(201).json({ template });
  });
  api.put("/templates/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ name: z.string().min(1), body: z.string().min(1), tags: z.string().default("") }).parse(req.body);
    const template = await prisma.template.update({ where: { id }, data: body });
    res.json({ template });
  });
  api.delete("/templates/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    await prisma.template.delete({ where: { id } });
    await audit({ action: "template_deleted", actorId: (req as unknown as AuthedRequest).user.id, targetType: "template", targetId: id, meta: {} });
    res.json({ ok: true });
  });

  api.get("/automations/macros", async (_req, res) => res.json({ macros: await prisma.automationMacro.findMany({ orderBy: { updatedAt: "desc" } }) }));
  api.post("/automations/macros", async (req, res) => {
    const body = z.object({ name: z.string().min(1), keywords: z.string().min(1), body: z.string().min(1), enabled: z.boolean().default(true), tags: z.string().default("") }).parse(req.body);
    const macro = await prisma.automationMacro.create({ data: { ...body, createdBy: (req as unknown as AuthedRequest).user.id } });
    await audit({ action: "automation_macro_created", actorId: (req as unknown as AuthedRequest).user.id, targetType: "automation_macro", targetId: macro.id, meta: { keywords: macro.keywords, enabled: macro.enabled } });
    res.status(201).json({ macro });
  });
  api.put("/automations/macros/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ name: z.string().min(1), keywords: z.string().min(1), body: z.string().min(1), enabled: z.boolean(), tags: z.string().default("") }).parse(req.body);
    const macro = await prisma.automationMacro.update({ where: { id }, data: body });
    await audit({ action: "automation_macro_updated", actorId: (req as unknown as AuthedRequest).user.id, targetType: "automation_macro", targetId: macro.id, meta: { enabled: macro.enabled } });
    res.json({ macro });
  });
  api.delete("/automations/macros/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    await prisma.automationMacro.delete({ where: { id } });
    await audit({ action: "automation_macro_deleted", actorId: (req as unknown as AuthedRequest).user.id, targetType: "automation_macro", targetId: id, meta: {} });
    res.json({ ok: true });
  });
  api.post("/automations/macros/:id/run", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ conversationId: z.number() }).parse(req.body);
    const [macro, conversation] = await Promise.all([
      prisma.automationMacro.findUnique({ where: { id } }),
      prisma.conversation.findUnique({ where: { id: body.conversationId }, include: { contact: true } })
    ]);
    if (!macro) return res.status(404).json({ error: "Macro not found" });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    if (conversation.contact.optOut) return res.status(403).json({ error: "Contact opted out of automation" });
    const message = await queueOutboundMessage({ conversationId: conversation.id, authorId: (req as unknown as AuthedRequest).user.id, content: personalizeTemplate(macro.body, conversation.contact.name), generatedBy: "automation", meta: { macroId: macro.id } }, io);
    await audit({ action: "automation_macro_run", actorId: (req as unknown as AuthedRequest).user.id, targetType: "automation_macro", targetId: macro.id, meta: { conversationId: conversation.id, messageId: message.id } });
    res.status(202).json({ message });
  });

  api.get("/kb", async (_req, res) => res.json({ entries: await prisma.knowledgeBase.findMany({ orderBy: { createdAt: "desc" } }) }));
  api.post("/kb", async (req, res) => {
    const body = z.object({ title: z.string().min(1), snippet: z.string().min(1), content: z.string().min(1), tags: z.string().default("") }).parse(req.body);
    const entry = await prisma.knowledgeBase.create({ data: body });
    await audit({ action: "kb_created", actorId: (req as unknown as AuthedRequest).user.id, targetType: "knowledge_base", targetId: entry.id, meta: {} });
    res.status(201).json({ entry });
  });
  api.put("/kb/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ title: z.string().min(1), snippet: z.string().min(1), content: z.string().min(1), tags: z.string().default("") }).parse(req.body);
    res.json({ entry: await prisma.knowledgeBase.update({ where: { id }, data: body }) });
  });
  api.delete("/kb/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    await prisma.knowledgeBase.delete({ where: { id } });
    res.json({ ok: true });
  });

  api.get("/orders", async (req, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const contactId = req.query.contactId ? z.coerce.number().parse(req.query.contactId) : undefined;
    res.json({ orders: await prisma.order.findMany({ where: { ...(status ? { status } : {}), ...(contactId ? { contactId } : {}), ...(search ? { OR: [{ orderRef: { contains: search } }, { attributes: { contains: search } }, { contact: { OR: [{ name: { contains: search } }, { phone: { contains: search } }, { tags: { contains: search } }] } }] } : {}) }, include: { contact: true }, orderBy: { createdAt: "desc" } }) });
  });
  api.get("/orders/export.csv", async (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const orders = await prisma.order.findMany({ where: status ? { status } : undefined, include: { contact: true }, orderBy: { createdAt: "desc" }, take: 5000 });
    const rows = orders.map((order) => [order.id, order.orderRef, order.status, order.total ?? "", order.contact.name, order.contact.phone, order.attributes, order.createdAt.toISOString()]);
    const csv = [["id", "order_ref", "status", "total", "contact_name", "contact_phone", "attributes", "created_at"], ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    await audit({ action: "orders_csv_exported", actorId: (req as unknown as AuthedRequest).user.id, targetType: "order", targetId: null, meta: { rows: orders.length } });
    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment(`orders-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    res.send(`${csv}\n`);
  });
  api.get("/orders/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const order = await prisma.order.findUnique({ where: { id }, include: { contact: true, webhookDeliveries: { include: { endpoint: true }, orderBy: { createdAt: "desc" } } } });
    if (!order) return res.status(404).json({ error: "Order not found" });
    res.json({ order });
  });
  api.post("/orders", async (req, res) => {
    const body = z.object({ contactId: z.number(), orderRef: z.string().optional(), status: z.string().default("draft"), total: z.number().int().optional(), attributes: z.record(z.unknown()).default({}) }).parse(req.body);
    const order = await prisma.order.create({ data: { ...body, attributes: JSON.stringify(body.attributes), orderRef: body.orderRef ?? `DRAFT-${Date.now()}`, createdBy: (req as unknown as AuthedRequest).user.id } });
    await audit({ action: "order_created", actorId: (req as unknown as AuthedRequest).user.id, targetType: "order", targetId: order.id, meta: { status: order.status } });
    const webhookDeliveries = await queueOrderWebhook(order.id, "order.created", (req as unknown as AuthedRequest).user.id);
    io.emit("conversation:update", { contactId: order.contactId });
    res.status(201).json({ order, webhookDeliveries });
  });
  api.patch("/orders/:id", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ status: z.string().optional(), total: z.number().int().nullable().optional(), attributes: z.record(z.unknown()).optional() }).parse(req.body);
    const order = await prisma.order.update({ where: { id }, data: { ...(body.status ? { status: body.status } : {}), ...(body.total !== undefined ? { total: body.total } : {}), ...(body.attributes ? { attributes: JSON.stringify(body.attributes) } : {}) } });
    await audit({ action: "order_updated", actorId: (req as unknown as AuthedRequest).user.id, targetType: "order", targetId: order.id, meta: { status: order.status } });
    const webhookDeliveries = await queueOrderWebhook(order.id, "order.updated", (req as unknown as AuthedRequest).user.id);
    io.emit("conversation:update", { contactId: order.contactId });
    res.json({ order, webhookDeliveries });
  });
  api.post("/orders/:id/integrations/webhook", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ event: z.string().min(1).default("order.sync") }).parse(req.body ?? {});
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) return res.status(404).json({ error: "Order not found" });
    const webhookDeliveries = await queueOrderWebhook(order.id, body.event, (req as unknown as AuthedRequest).user.id);
    res.status(202).json({ webhookDeliveries });
  });
  api.post("/conversations/:id/order-draft", async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ create: z.boolean().default(false) }).parse(req.body ?? {});
    const conversation = await prisma.conversation.findUnique({ where: { id }, include: { contact: true, messages: { orderBy: { createdAt: "desc" }, take: 12 } } });
    if (!conversation) return res.status(404).json({ error: "Conversation not found" });
    const draft = extractOrderDraft(conversation.messages.map((message) => message.content).join("\n"));
    if (!body.create) return res.json({ draft });
    const order = await prisma.order.create({ data: { contactId: conversation.contactId, orderRef: draft.orderRef, status: "draft", total: draft.total, attributes: JSON.stringify(draft.attributes), createdBy: (req as unknown as AuthedRequest).user.id } });
    await audit({ action: "order_draft_extracted", actorId: (req as unknown as AuthedRequest).user.id, targetType: "order", targetId: order.id, meta: draft.attributes });
    res.status(201).json({ draft, order });
  });
}

function registerAi(api: Router, io: Server) {
  const aiRequestSchema = z.object({ conversationId: z.number(), model: z.string().optional(), temperature: z.number().min(0).max(1).default(0.3), maxTokens: z.number().int().min(1).max(800).default(200) });

  api.post("/ai/generate", async (req, res) => {
    const body = aiRequestSchema.parse(req.body);
    const user = (req as unknown as AuthedRequest).user;
    const result = await createAiGeneration(body, user.id, false, io);
    if (result.error) return res.status(result.status).json(result.body);
    res.json(result.body);
  });

  api.post("/ai/generate/stream", async (req, res) => {
    const body = aiRequestSchema.parse(req.body);
    const user = (req as unknown as AuthedRequest).user;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });
    const result = await createAiGeneration(body, user.id, true, io, (event, payload) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });
    if (result.error) {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify(result.body)}\n\n`);
    } else {
      res.write(`event: complete\n`);
      res.write(`data: ${JSON.stringify(result.body)}\n\n`);
    }
    res.end();
  });

  api.get("/ai/generations", requireRole(["superadmin"]), async (req, res) => {
    const limit = z.coerce.number().min(1).max(200).default(50).parse(req.query.limit ?? 50);
    res.json({ generations: await prisma.aiGeneration.findMany({ orderBy: { createdAt: "desc" }, take: limit }) });
  });

  api.get("/ai/models", async (_req, res) => {
    if (!config.OPENROUTER_API_KEY) return res.json({ models: [{ id: currentPolicies().defaultModel, name: "Default local config" }], source: "local" });
    const response = await fetch(`${config.OPENROUTER_BASE_URL}/models`, { headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` } });
    const data = await response.json();
    res.status(response.ok ? 200 : 502).json(data);
  });
}

type OpenRouterResponse = {
  choices?: Array<{ message?: { content?: string }; delta?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type AiGenerationInput = { conversationId: number; model?: string; temperature: number; maxTokens: number };
type StreamWriter = (event: string, payload: Record<string, unknown>) => void;

async function createAiGeneration(body: AiGenerationInput, userId: number, stream: boolean, io: Server, writeStream?: StreamWriter) {
  const conversation = await prisma.conversation.findUnique({ where: { id: body.conversationId }, include: { contact: true, messages: { orderBy: { createdAt: "desc" }, take: 8 } } });
  if (!conversation) return { error: true as const, status: 404, body: { error: "Conversation not found" } };
  if (!conversation.contact.aiEnabled) return { error: true as const, status: 403, body: { error: "AI is disabled for this contact" } };
  if (conversation.contact.optOut) return { error: true as const, status: 403, body: { error: "Contact opted out of automation" } };
  const rate = checkAiQuota(userId, conversation.contactId);
  if (!rate.allowed) return { error: true as const, status: 429, body: { error: "AI rate limit exceeded", resetAt: new Date(rate.resetAt).toISOString(), scope: rate.scope } };

  const [kb, orders] = await Promise.all([
    prisma.knowledgeBase.findMany({ orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.order.findMany({ where: { contactId: conversation.contactId }, orderBy: { createdAt: "desc" }, take: 3 })
  ]);
  const model = body.model ?? currentPolicies().defaultModel;
  const prompt = composeAiPrompt(conversation, kb, orders);
  const startedAt = Date.now();
  let suggestion = "";
  let provider: OpenRouterResponse | Record<string, unknown> | null = null;
  let usage: OpenRouterResponse["usage"] | undefined;

  const emitChunk = (chunk: string) => {
    if (!chunk) return;
    io.emit("ai:generation:chunk", { conversationId: conversation.id, contactId: conversation.contactId, chunk });
    writeStream?.("chunk", { conversationId: conversation.id, chunk });
  };

  if (config.OPENROUTER_API_KEY) {
    const response = await fetch(`${config.OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.OPENROUTER_REFERER ?? config.APP_ORIGIN,
        "X-Title": config.OPENROUTER_TITLE
      },
      body: JSON.stringify({ model, messages: prompt, temperature: body.temperature, max_tokens: body.maxTokens, stream })
    });
    if (!response.ok) {
      provider = await response.json().catch(() => ({ status: response.status })) as OpenRouterResponse | Record<string, unknown>;
      return { error: true as const, status: 502, body: { error: "OpenRouter request failed", provider } };
    }
    if (stream && response.body) {
      const streamed = await readOpenRouterStream(response, emitChunk);
      suggestion = streamed.text;
      usage = streamed.usage;
      provider = { streamed: true, usage };
    } else {
      provider = await response.json() as OpenRouterResponse | Record<string, unknown>;
      suggestion = readOpenRouterSuggestion(provider);
      usage = "usage" in provider ? provider.usage as OpenRouterResponse["usage"] : undefined;
    }
  } else {
    suggestion = "AI belum dikonfigurasi. Aktifkan OPENROUTER_API_KEY untuk saran langsung. Untuk saat ini, minta detail tugas, deadline, dan rubrik agar admin bisa memberi estimasi.";
    if (stream) {
      for (const chunk of chunkText(suggestion)) emitChunk(chunk);
    }
    provider = { localFallback: true };
  }

  const confidence = estimateConfidence(suggestion);
  const generation = await prisma.aiGeneration.create({
    data: {
      conversationId: conversation.id,
      contactId: conversation.contactId,
      model,
      prompt: JSON.stringify(prompt),
      suggestion,
      confidence,
      status: "completed",
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens: usage?.completion_tokens ?? null,
      totalTokens: usage?.total_tokens ?? null,
      latencyMs: Date.now() - startedAt,
      rateLimitScope: rate.scope,
      providerMeta: JSON.stringify(provider ?? {}),
      createdBy: userId
    }
  });
  await audit({ action: stream ? "ai_stream_generated" : "ai_generated", actorId: userId, targetType: "conversation", targetId: conversation.id, meta: { generationId: generation.id, model, confidence, rateLimitScope: rate.scope } });
  const responseBody = { suggestion, confidence, model, generationId: generation.id, requiresAdminReview: confidence < currentPolicies().aiConfidenceThreshold, usage, rateLimit: { remaining: rate.remaining, resetAt: new Date(rate.resetAt).toISOString(), scope: rate.scope }, provider: config.OPENROUTER_API_KEY ? provider : undefined };
  io.emit("ai:generation:complete", { conversationId: conversation.id, contactId: conversation.contactId, generation: responseBody });
  return { error: false as const, body: responseBody };
}

async function readOpenRouterStream(response: globalThis.Response, onChunk: (chunk: string) => void) {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: OpenRouterResponse["usage"] | undefined;
  if (!reader) return { text, usage };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data) as OpenRouterResponse;
      usage = parsed.usage ?? usage;
      const chunk = parsed.choices?.[0]?.delta?.content ?? parsed.choices?.[0]?.message?.content ?? "";
      text += chunk;
      onChunk(chunk);
    }
  }
  return { text, usage };
}

function chunkText(text: string) {
  return text.match(/.{1,48}(\s|$)/g) ?? [text];
}

function readOpenRouterSuggestion(provider: OpenRouterResponse | Record<string, unknown> | null) {
  if (!provider || !("choices" in provider) || !Array.isArray(provider.choices)) return "";
  const first = provider.choices[0] as { message?: { content?: unknown } } | undefined;
  return typeof first?.message?.content === "string" ? first.message.content : "";
}

function recordRequestMetric(req: Request, res: Response, next: NextFunction) {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    requestMetrics.push({
      method: req.method,
      path: req.route?.path && typeof req.route.path === "string" ? req.route.path : req.path,
      statusCode: res.statusCode,
      durationMs,
      finishedAt: Date.now()
    });
    if (requestMetrics.length > maxRequestMetricSamples) requestMetrics.splice(0, requestMetrics.length - maxRequestMetricSamples);
  });
  next();
}

function summarizeRequestMetrics() {
  const now = Date.now();
  const recent = requestMetrics.filter((metric) => metric.finishedAt >= now - 300_000);
  const durations = recent.map((metric) => metric.durationMs).sort((a, b) => a - b);
  const byRoute = new Map<string, { requests: number; errors: number; totalMs: number }>();

  for (const metric of recent) {
    const key = `${metric.method} ${metric.path}`;
    const current = byRoute.get(key) ?? { requests: 0, errors: 0, totalMs: 0 };
    current.requests += 1;
    current.totalMs += metric.durationMs;
    if (metric.statusCode >= 500) current.errors += 1;
    byRoute.set(key, current);
  }

  return {
    sampleWindowSeconds: 300,
    requests: recent.length,
    requestsPerMinute: recent.length / 5,
    averageResponseMs: durations.length ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length) : 0,
    p95ResponseMs: percentile(durations, 0.95),
    errorCount: recent.filter((metric) => metric.statusCode >= 500).length,
    byRoute: [...byRoute.entries()].map(([route, value]) => ({
      route,
      requests: value.requests,
      errors: value.errors,
      averageResponseMs: Math.round(value.totalMs / value.requests)
    })).sort((left, right) => right.requests - left.requests).slice(0, 10)
  };
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * percentileValue) - 1);
  return Math.round(sortedValues[index]);
}

const apiErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof z.ZodError) {
    res.status(400).json({ error: "Invalid request", details: error.flatten() });
    return;
  }
  if (typeof error?.statusCode === "number") {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
};

function registerBackupAndAudit(api: Router) {
  api.get("/audit", async (req, res) => {
    const limit = z.coerce.number().min(1).max(200).default(50).parse(req.query.limit ?? 50);
    res.json({ logs: await prisma.auditLog.findMany({ include: { actor: { select: { id: true, email: true, name: true } } }, orderBy: { createdAt: "desc" }, take: limit }) });
  });
  api.get("/audit/export.csv", requireRole(["superadmin"]), async (req, res) => {
    const limit = z.coerce.number().min(1).max(5000).default(1000).parse(req.query.limit ?? 1000);
    const logs = await prisma.auditLog.findMany({ include: { actor: { select: { email: true, name: true } } }, orderBy: { createdAt: "desc" }, take: limit });
    const rows = logs.map((log) => [log.id, log.createdAt.toISOString(), log.action, log.actorId ?? "", log.actor?.email ?? "", log.targetType, log.targetId ?? "", log.meta]);
    const csv = [["id", "created_at", "action", "actor_id", "actor_email", "target_type", "target_id", "meta"], ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
    await audit({ action: "audit_csv_exported", actorId: (req as unknown as AuthedRequest).user.id, targetType: "audit_log", targetId: null, meta: { rows: logs.length } });
    res.header("Content-Type", "text/csv; charset=utf-8");
    res.attachment(`audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    res.send(`${csv}\n`);
  });
  api.get("/audit/verify", requireRole(["superadmin"]), async (_req, res) => {
    res.json({ integrity: await verifyAuditChain() });
  });
  api.post("/backups", requireRole(["superadmin"]), async (req, res) => {
    const backup = await runBackup((req as unknown as AuthedRequest).user.id);
    res.status(201).json({ backup });
  });
  api.get("/backups", requireRole(["superadmin"]), async (_req, res) => res.json({ backups: await prisma.backupRun.findMany({ orderBy: { createdAt: "desc" } }) }));
  api.get("/backups/status", requireRole(["superadmin"]), async (_req, res) => res.json({ status: await getBackupStatus() }));
  api.post("/backups/:id/validate", requireRole(["superadmin"]), async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    res.json(await validateBackup(id, (req as unknown as AuthedRequest).user.id));
  });
  api.post("/backups/:id/restore", requireRole(["superadmin"]), async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = z.object({ confirm: z.string() }).parse(req.body);
    try {
      const result = await restoreBackup(id, (req as unknown as AuthedRequest).user.id, body.confirm);
      res.json({ restore: result });
    } catch (error) {
      if (typeof (error as { statusCode?: unknown }).statusCode === "number") return res.status((error as { statusCode: number }).statusCode).json({ error: (error as Error).message });
      throw error;
    }
  });
  api.get("/admin/webhooks/settings", requireRole(["superadmin"]), async (_req, res) => {
    await ensureConfiguredWebhookEndpoint();
    res.json({ endpoints: await prisma.webhookEndpoint.findMany({ orderBy: { name: "asc" } }) });
  });
  api.put("/admin/webhooks/settings", requireRole(["superadmin"]), async (req, res) => {
    const body = z.object({ name: z.string().min(1).default("order_default"), url: z.string().url(), secret: z.string().optional().nullable(), enabled: z.boolean().default(true), maxAttempts: z.number().int().min(1).max(10).default(5), backoffSeconds: z.number().int().min(1).max(3600).default(30) }).parse(req.body);
    const endpoint = await upsertWebhookEndpoint(body);
    await audit({ action: "webhook_endpoint_updated", actorId: (req as unknown as AuthedRequest).user.id, targetType: "webhook_endpoint", targetId: endpoint.id, meta: { name: endpoint.name, url: endpoint.url, enabled: endpoint.enabled } });
    res.json({ endpoint });
  });
  api.post("/admin/webhooks/settings/:id/test", requireRole(["superadmin"]), async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const result = await testWebhookEndpoint(id);
    await audit({ action: "webhook_endpoint_tested", actorId: (req as unknown as AuthedRequest).user.id, targetType: "webhook_endpoint", targetId: id, meta: { ok: result.ok, status: result.status } });
    res.json({ result });
  });
  api.get("/admin/webhooks/deliveries", requireRole(["superadmin"]), async (req, res) => {
    const limit = z.coerce.number().min(1).max(200).default(50).parse(req.query.limit ?? 50);
    res.json({ deliveries: await prisma.webhookDelivery.findMany({ include: { endpoint: true, order: true }, orderBy: { createdAt: "desc" }, take: limit }) });
  });
  api.post("/admin/webhooks/deliveries/:id/retry", requireRole(["superadmin"]), async (req, res) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const delivery = await retryWebhookDelivery(id);
    await processDueWebhookDeliveries();
    await audit({ action: "webhook_delivery_retry_requested", actorId: (req as unknown as AuthedRequest).user.id, targetType: "webhook_delivery", targetId: id, meta: {} });
    res.json({ delivery });
  });
  api.get("/settings/policies", async (_req, res) => {
    res.json({ policies: await loadPolicies(), webhookConfigured: Boolean(config.ORDER_WEBHOOK_URL), backupScheduler: await getBackupStatus().then((status) => status.scheduler) });
  });
  api.put("/settings/policies", requireRole(["superadmin"]), async (req, res) => {
    const policies = policyUpdateSchema.parse(req.body);
    const updated = await updatePolicies(policies, (req as unknown as AuthedRequest).user.id);
    await restartBackupScheduler();
    await audit({ action: "policies_updated", actorId: (req as unknown as AuthedRequest).user.id, targetType: "settings", targetId: null, meta: policies });
    res.json({ policies: updated });
  });
}

const rateLimitPolicySchema = z.object({ limit: z.number().int().min(1).max(100_000), windowSeconds: z.number().int().min(1).max(86_400) });

const policyUpdateSchema: z.ZodType<RuntimePolicyUpdate> = z.object({
  aiConfidenceThreshold: z.number().min(0).max(1).optional(),
  aiDefaultEnabled: z.boolean().optional(),
  defaultModel: z.string().min(1).max(200).optional(),
  backupIntervalMinutes: z.number().int().min(0).max(525_600).optional(),
  backupRetentionDays: z.number().int().min(0).max(3650).optional(),
  messageQueueMaxAttempts: z.number().int().min(1).max(20).optional(),
  messageQueueRetrySeconds: z.number().int().min(1).max(3600).optional(),
  auditRedactionKeys: z.array(z.string().min(1).max(80)).max(50).optional(),
  rateLimits: z.object({
    globalMessages: rateLimitPolicySchema.optional(),
    aiGeneration: rateLimitPolicySchema.optional(),
    aiDaily: rateLimitPolicySchema.optional(),
    aiContactDaily: rateLimitPolicySchema.optional()
  }).optional()
});

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function parseExpiresInMilliseconds(value: string) {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/i);
  if (!match) return 8 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  if (unit === "d") return amount * 24 * 60 * 60 * 1000;
  if (unit === "h") return amount * 60 * 60 * 1000;
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "s") return amount * 1000;
  return amount;
}

function resolveLocalMedia(mediaPath: string) {
  const resolved = path.resolve(mediaPath);
  const mediaRoot = path.resolve(paths.media);
  if (!resolved.startsWith(`${mediaRoot}${path.sep}`) || !fs.existsSync(resolved)) {
    throw Object.assign(new Error("Media path must point to an existing local media file"), { statusCode: 400 });
  }
  return resolved;
}

function extractOrderDraft(text: string) {
  const normalized = text.replace(/\s+/g, " ");
  const rupiah = normalized.match(/(?:rp\.?\s*)?([0-9][0-9.]{3,})(?:\s*(?:rb|ribu))?/i);
  const deadline = normalized.match(/deadline\s*[:\-]?\s*([^.,;\n]+)/i);
  const subject = normalized.match(/(?:mapel|mata kuliah|subject|tugas)\s*[:\-]?\s*([^.,;\n]+)/i);
  const orderRef = `DRAFT-${Date.now()}`;
  return {
    orderRef,
    total: rupiah ? Number(rupiah[1].replace(/\./g, "")) : null,
    attributes: {
      extractedFromChat: true,
      subject: subject?.[1]?.trim() ?? null,
      deadline: deadline?.[1]?.trim() ?? null,
      sourceSnippet: normalized.slice(0, 500)
    }
  };
}

async function buildKeywordSuggestions(conversationId: number) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true, messages: { orderBy: { createdAt: "desc" }, take: 6 } }
  });
  if (!conversation) return [];

  const sourceText = [conversation.contact.name, conversation.contact.phone, ...conversation.messages.map((message) => message.content)].join(" ");
  const tokens = keywordTokens(sourceText);
  const [templates, knowledgeBase, macros] = await Promise.all([
    prisma.template.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.knowledgeBase.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.automationMacro.findMany({ where: { enabled: true }, orderBy: { updatedAt: "desc" } })
  ]);

  const templateSuggestions = templates.map((template) => {
    const score = keywordScore(tokens, [template.name, template.body, template.tags]);
    return score > 0 ? {
      type: "template" as const,
      id: template.id,
      title: template.name,
      body: personalizeTemplate(template.body, conversation.contact.name),
      tags: splitTags(template.tags),
      score
    } : null;
  }).filter(Boolean);

  const kbSuggestions = knowledgeBase.map((entry) => {
    const score = keywordScore(tokens, [entry.title, entry.snippet, entry.content, entry.tags]);
    return score > 0 ? {
      type: "knowledge_base" as const,
      id: entry.id,
      title: entry.title,
      body: entry.snippet,
      tags: splitTags(entry.tags),
      score
    } : null;
  }).filter(Boolean);

  const macroSuggestions = macros.map((macro) => {
    const score = keywordScore(tokens, [macro.name, macro.body, macro.tags, macro.keywords]);
    return score > 0 ? {
      type: "automation_macro" as const,
      id: macro.id,
      title: macro.name,
      body: personalizeTemplate(macro.body, conversation.contact.name),
      tags: splitTags(macro.tags),
      score
    } : null;
  }).filter(Boolean);

  return [...templateSuggestions, ...kbSuggestions, ...macroSuggestions]
    .sort((left, right) => (right?.score ?? 0) - (left?.score ?? 0))
    .slice(0, 5);
}

function keywordTokens(text: string) {
  const stopWords = new Set(["yang", "dan", "atau", "untuk", "dengan", "saya", "kamu", "halo", "admin", "mau", "ingin", "the", "and", "for", "you"]);
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !stopWords.has(token)));
}

function keywordScore(tokens: Set<string>, fields: string[]) {
  let score = 0;
  for (const field of fields) {
    const lower = field.toLowerCase();
    for (const token of tokens) {
      if (lower.includes(token)) score += field === fields[fields.length - 1] ? 2 : 1;
    }
  }
  return score;
}

function splitTags(tags: string) {
  return tags.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function personalizeTemplate(body: string, contactName: string) {
  return body.replace(/{{\s*name\s*}}/g, contactName);
}

function composeAiPrompt(conversation: { contact: { name: string }; messages: { from: string; content: string }[] }, kb: { title: string; snippet: string }[], orders: { orderRef: string; status: string; total: number | null; attributes: unknown }[]) {
  return [
    { role: "system", content: `You are a suggestion-only support assistant for JokiTugasKu.online. Be concise and friendly in Indonesian unless the customer used English. Never claim a final price without admin confirmation. KB: ${kb.map((entry) => `${entry.title}: ${entry.snippet}`).join(" | ") || "No KB available"}. End with 'Admin akan lanjutkan jika diperlukan.'` },
    { role: "user", content: `Customer: ${conversation.contact.name}. Recent chat: ${conversation.messages.reverse().map((message) => `${message.from}: ${message.content}`).join("\n")}. Order context: ${orders.length ? JSON.stringify(orders) : "No order yet"}. Confidence threshold: 0.8.` }
  ];
}

function estimateConfidence(text: string) {
  if (!text.trim()) return 0.2;
  const lower = text.toLowerCase();
  const hedges = ["tidak yakin", "mungkin", "kurang tahu", "not sure", "maybe"];
  return hedges.some((hedge) => lower.includes(hedge)) ? 0.55 : 0.82;
}
