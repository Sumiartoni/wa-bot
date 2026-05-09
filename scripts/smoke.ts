import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createApp } from "../src/app.js";
import { config, ensureRuntimeDirs, paths } from "../src/config.js";
import { closePrisma } from "../src/db.js";

ensureRuntimeDirs();

const { httpServer } = createApp();
const server = httpServer.listen(0);

function unwrap<T>(value: unknown): T {
  if (value && typeof value === "object" && "success" in (value as Record<string, unknown>)) {
    return ((value as { data?: T }).data ?? ({} as T));
  }
  return value as T;
}

async function main() {
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD })
  });
  assert.equal(login.status, 200);
  const loginBody = unwrap<{ token: string; csrfToken: string }>(await login.json());
  assert.ok(loginBody.token);
  assert.ok(loginBody.csrfToken);

  const conversations = await fetch(`${baseUrl}/api/conversations`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(conversations.status, 200);
  const conversationsBody = unwrap<{ conversations: Array<{ id: number }> }>(await conversations.json());
  assert.ok(conversationsBody.conversations.length > 0);

  const conversationId = conversationsBody.conversations[0].id;
  const conversationDetail = await fetch(`${baseUrl}/api/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(conversationDetail.status, 200);
  const conversationDetailBody = unwrap<{ conversation: { contact: { id: number } }; suggestions: unknown[] }>(await conversationDetail.json());
  assert.ok(Array.isArray(conversationDetailBody.suggestions));

  const aiContact = await fetch(`${baseUrl}/api/contacts/${conversationDetailBody.conversation.contact.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ aiEnabled: true })
  });
  assert.equal(aiContact.status, 200);

  const aiStream = await fetch(`${baseUrl}/api/ai/generate/stream`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId })
  });
  assert.equal(aiStream.status, 200);
  assert.match(await aiStream.text(), /event: complete/);

  const suggestionEndpoint = await fetch(`${baseUrl}/api/conversations/${conversationId}/suggestions`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(suggestionEndpoint.status, 200);

  const metrics = await fetch(`${baseUrl}/api/metrics`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(metrics.status, 200);
  const metricsBody = unwrap<{ throughput?: { api?: { requests: number } } }>(await metrics.json());
  assert.ok(metricsBody.throughput?.api);

  const auditCsv = await fetch(`${baseUrl}/api/audit/export.csv`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(auditCsv.status, 200);
  assert.match(await auditCsv.text(), /^id,created_at,action/m);

  const backupStatus = await fetch(`${baseUrl}/api/backups/status`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(backupStatus.status, 200);
  const backup = await fetch(`${baseUrl}/api/backups`, { method: "POST", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken } });
  assert.equal(backup.status, 201);
  const backupBody = unwrap<{ backup: { id: number } }>(await backup.json());
  const backupValidation = await fetch(`${baseUrl}/api/backups/${backupBody.backup.id}/validate`, { method: "POST", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken } });
  assert.equal(backupValidation.status, 200);
  const backupValidationBody = unwrap<{ validation: { ok: boolean } }>(await backupValidation.json());
  assert.equal(backupValidationBody.validation.ok, true);
  const rejectedRestore = await fetch(`${baseUrl}/api/backups/${backupBody.backup.id}/restore`, { method: "POST", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "RESTORE wrong" }) });
  assert.equal(rejectedRestore.status, 400);

  const auditVerify = await fetch(`${baseUrl}/api/audit/verify`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(auditVerify.status, 200);

  const sessions = await fetch(`${baseUrl}/api/admin/sessions`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(sessions.status, 200);
  const sessionsBody = unwrap<{ sessions: Array<{ id: number }> }>(await sessions.json());
  assert.ok(sessionsBody.sessions.length > 0);

  const webhookSettings = await fetch(`${baseUrl}/api/admin/webhooks/settings`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(webhookSettings.status, 200);

  const users = await fetch(`${baseUrl}/api/admin/users`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(users.status, 200);

  const policies = await fetch(`${baseUrl}/api/settings/policies`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(policies.status, 200);
  const policiesBody = unwrap<{ policies: { aiConfidenceThreshold: number; messageQueueMaxAttempts: number } }>(await policies.json());
  const policyUpdate = await fetch(`${baseUrl}/api/settings/policies`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ aiConfidenceThreshold: policiesBody.policies.aiConfidenceThreshold, messageQueueMaxAttempts: policiesBody.policies.messageQueueMaxAttempts })
  });
  assert.equal(policyUpdate.status, 200);

  const webhookDeliveries = await fetch(`${baseUrl}/api/admin/webhooks/deliveries`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(webhookDeliveries.status, 200);

  const sessionArchive = await fetch(`${baseUrl}/api/admin/sessions/${sessionsBody.sessions[0].id}/download`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(sessionArchive.status, 200);
  assert.ok((await sessionArchive.arrayBuffer()).byteLength > 0);

  const forbidden = await fetch(`${baseUrl}/api/templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "No CSRF", body: "Should fail", tags: "test" })
  });
  assert.equal(forbidden.status, 403);

  const created = await fetch(`${baseUrl}/api/templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Smoke ${Date.now()}`, body: "Smoke template", tags: "test" })
  });
  assert.equal(created.status, 201);

  const macro = await fetch(`${baseUrl}/api/automations/macros`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Smoke Macro ${Date.now()}`, keywords: "smoke,harga", body: "Halo {{name}}, ini balasan automation smoke.", tags: "smoke" })
  });
  assert.equal(macro.status, 201);
  const macroBody = unwrap<{ macro: { id: number } }>(await macro.json());
  const macroRun = await fetch(`${baseUrl}/api/automations/macros/${macroBody.macro.id}/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId })
  });
  assert.equal(macroRun.status, 202);

  const orderDraft = await fetch(`${baseUrl}/api/conversations/${conversationId}/order-draft`, { method: "POST", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ create: true }) });
  assert.equal(orderDraft.status, 201);
  const orderDraftBody = unwrap<{ order: { id: number; orderRef: string } }>(await orderDraft.json());
  const orderDetail = await fetch(`${baseUrl}/api/orders/${orderDraftBody.order.id}`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(orderDetail.status, 200);
  const orderPatch = await fetch(`${baseUrl}/api/orders/${orderDraftBody.order.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ status: "quoted", attributes: { smoke: true } }) });
  assert.equal(orderPatch.status, 200);
  const orderExport = await fetch(`${baseUrl}/api/orders/export.csv`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(orderExport.status, 200);
  assert.match(await orderExport.text(), /^id,order_ref,status/m);
  const orderSync = await fetch(`${baseUrl}/api/orders/${orderDraftBody.order.id}/integrations/webhook`, { method: "POST", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ event: "order.smoke" }) });
  assert.equal(orderSync.status, 202);
  const filteredByOrder = await fetch(`${baseUrl}/api/conversations?orderId=${orderDraftBody.order.id}`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(filteredByOrder.status, 200);
  const tagUpdate = await fetch(`${baseUrl}/api/contacts/${conversationDetailBody.conversation.contact.id}`, { method: "PATCH", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ tags: "smoke,vip" }) });
  assert.equal(tagUpdate.status, 200);
  const filteredByTag = await fetch(`${baseUrl}/api/conversations?tag=vip`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(filteredByTag.status, 200);

  const queuedMessage = await fetch(`${baseUrl}/api/conversations/${conversationId}/message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Smoke queued outbound message", type: "manual" })
  });
  assert.equal(queuedMessage.status, 202);
  fs.mkdirSync(paths.media, { recursive: true });
  const smokeMediaPath = path.join(paths.media, `smoke-${Date.now()}.txt`);
  fs.writeFileSync(smokeMediaPath, "smoke attachment");
  const queuedMediaMessage = await fetch(`${baseUrl}/api/conversations/${conversationId}/message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Smoke queued media message", type: "manual", mediaPath: smokeMediaPath, mediaMimeType: "text/plain", mediaFileName: "smoke.txt" })
  });
  assert.equal(queuedMediaMessage.status, 202);
  const queue = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages/queue`, { headers: { Authorization: `Bearer ${loginBody.token}` } });
  assert.equal(queue.status, 200);

  const restore = await fetch(`${baseUrl}/api/backups/${backupBody.backup.id}/restore`, { method: "POST", headers: { Authorization: `Bearer ${loginBody.token}`, "X-CSRF-Token": loginBody.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: `RESTORE ${backupBody.backup.id}` }) });
  assert.equal(restore.status, 200);

  console.log("Smoke test passed: health, login, protected reads, AI stream, metrics, audit integrity, backup validate/restore, policies write path, users, queue/media, macros, order workflow, inbox filters, session archive, webhook reads, CSRF.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    server.close();
    await closePrisma();
  });
