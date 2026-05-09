# JokiTugasKu WhatsApp Support Console

Runnable private admin-only WhatsApp support console for `docs/PRD.md`: Express, Socket.IO, Prisma/SQLite, JWT auth, CSRF protection, optional encrypted WhatsApp session storage, AI suggestions plus streaming, durable outbound message queue/replay, local backups with scheduler/validation, webhook delivery with retry tracking, audit integrity checks, persisted admin-editable policies, Docker Compose deployment, and a React/Vite/Tailwind private admin console.

## Quick Start

1. Copy env defaults and change secrets:

```bash
cp .env.example .env
```

Change `JWT_SECRET` and `ADMIN_PASSWORD` before any production deployment. The server now refuses to boot in `NODE_ENV=production` if those defaults are left unchanged.

2. Install dependencies and initialize SQLite:

```bash
npm install
npm run prisma:generate
npm run db:push
npm run prisma:seed
```

3. Start the API and admin console in development:

```bash
npm run dev
```

In another shell, run the Vite frontend:

```bash
npm run dev:frontend
```

The API listens on `http://localhost:3000`; Vite listens on `http://localhost:5173` and proxies API and Socket.IO traffic to the backend. The seeded admin comes from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`.

## Frontend Build

```bash
npm run build
```

The build compiles the backend to `dist/` and writes the admin console to `public/`. Express serves `public/index.html` and static assets after the API routes, and `npm start` launches `dist/src/server.js` so the bundled admin console is served from the backend process.

The console implements operator surfaces for login/logout, dashboard metrics/status, real-time inbox updates via Socket.IO, conversation detail with manual replies, AI suggestion requests and streaming, WhatsApp connect/disconnect/QR visibility plus rotate/revoke controls, template CRUD, knowledge-base CRUD, order list/create-draft, audit logs, backups, webhook delivery visibility, rate-limit/settings, and health panels.

## Docker Compose

```bash
cp .env.example .env
docker compose up --build
```

The app stores SQLite, WhatsApp session files, and backups under `./data`, which is ignored by Git. The Docker image builds the frontend into `public/` and serves it from the same backend container.

## Auth and CSRF Contract

- `POST /api/auth/login` with `{ "email": "...", "password": "..." }` returns `{ token, csrfToken, user }` and also sets an `httpOnly` `auth_token` cookie.
- Protected routes accept `Authorization: Bearer <token>` or the auth cookie.
- All unsafe protected routes require `X-CSRF-Token: <csrfToken>`.
- `superadmin` is required for WhatsApp session management and backup triggers.

## API Surface

- `GET /api/health`, `GET /api/status`, `GET /api/metrics`, `GET /api/rate-limits/status`
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/csrf`
- `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:id`
- `GET /api/admin/sessions`, `POST /api/whatsapp/connect`, `GET /api/whatsapp/qr`, `POST /api/whatsapp/disconnect`, `POST /api/whatsapp/session/rotate`, `POST /api/whatsapp/session/revoke`, `DELETE /api/whatsapp/session-files`
- `GET /api/contacts`, `PATCH /api/contacts/:id`
- `GET /api/conversations` with `search`, `tag`, `orderId`, `orderRef`, and message `status` filters; `GET /api/conversations/:id`, `POST /api/conversations/:id/message`, `POST /api/conversations/:id/order-draft`, `GET /api/conversations/:id/messages/queue`, `POST /api/messages/:id/replay`
- `GET/POST/PUT/DELETE /api/templates`, `GET/POST/PUT/DELETE /api/automations/macros`, `POST /api/automations/macros/:id/run`
- `GET/POST/PUT/DELETE /api/kb`
- `GET /api/orders`, `GET /api/orders/export.csv`, `GET /api/orders/:id`, `POST /api/orders`, `PATCH /api/orders/:id`, `POST /api/orders/:id/integrations/webhook`
- `POST /api/ai/generate`, `POST /api/ai/generate/stream`, `GET /api/ai/generations`, `GET /api/ai/models`
- `GET /api/audit`, `GET /api/audit/verify`, `GET /api/backups`, `POST /api/backups`, `POST /api/backups/:id/validate`, `POST /api/backups/:id/restore`
- `GET /api/admin/webhooks/settings`, `PUT /api/admin/webhooks/settings`, `POST /api/admin/webhooks/settings/:id/test`, `GET /api/admin/webhooks/deliveries`, `POST /api/admin/webhooks/deliveries/:id/retry`
- `GET /api/settings/policies`, `PUT /api/settings/policies`

Socket.IO requires `auth: { token }` and emits `message:new`, `message:status`, `conversation:update`, `ai:generation:chunk`, `ai:generation:complete`, and `webhook:update`. Superadmins also receive protected `session:update` and `session:qr` events for QR pairing.

## WhatsApp Notes

`POST /api/whatsapp/connect` starts the real Baileys connection shell and stores credentials under `data/whatsapp-sessions`. Set `WHATSAPP_SESSION_ENCRYPTION_KEY` to encrypt Baileys JSON credential files at rest with local AES-256-GCM. Incoming media is stored locally under `MEDIA_DIR`/`data/media`, messages retain type/mime/file metadata, outbound media can be queued from an existing local media path, and WhatsApp receipt updates move messages through `sent`, `delivered`, and `read`. QR content is only available to authenticated superadmins through `GET /api/whatsapp/qr` and the protected `session:qr` Socket.IO event. Use `POST /api/whatsapp/session/rotate` to discard local credentials before reconnecting, or `POST /api/whatsapp/session/revoke` to logout, remove credentials, and mark the local session revoked.

## AI Notes

AI is suggestion-only. `POST /api/ai/generate` and `POST /api/ai/generate/stream` refuse calls unless the contact has `aiEnabled=true` and `optOut=false`. Streaming sends SSE chunks and matching Socket.IO `ai:generation:*` events. Every generation is persisted in `ai_generations` with prompt, suggestion, confidence, latency, usage when provided, and local rate-limit scope. If `OPENROUTER_API_KEY` is empty, the endpoint returns a low-confidence local placeholder so frontend integration can be developed without external services. Superadmins can update AI confidence, default model, AI default enablement, rate limits, backup cadence, queue retry policy, and audit redaction keys through `PUT /api/settings/policies`; values are persisted in SQLite and seeded from env defaults.

## Message Queue

Manual/template/AI/automation sends are first written to SQLite with `status=queued`, then the in-process worker sends them in conversation order. If WhatsApp is disconnected, messages move to `retrying` until `MESSAGE_QUEUE_MAX_ATTEMPTS` is exhausted, then `failed`; admins can replay an outbound message with `POST /api/messages/:id/replay`. Status changes emit `message:status`. Enabled automation macros match comma-separated keywords on incoming messages and queue a local template-style reply unless the contact has opted out.

## Order Webhooks

Set `ORDER_WEBHOOK_URL` to enable local order webhook delivery. New and updated orders queue deliveries in SQLite, manual sync can be triggered with `POST /api/orders/:id/integrations/webhook`, and the in-process worker retries failed deliveries with exponential backoff using `ORDER_WEBHOOK_MAX_ATTEMPTS` and `ORDER_WEBHOOK_BACKOFF_SECONDS`. Operators can filter orders, export CSV, inspect individual order delivery history, and draft an order from recent conversation text with `POST /api/conversations/:id/order-draft`.

## Backups

Run an on-demand SQLite copy backup:

```bash
npm run backup
```

Authenticated superadmins can also call `POST /api/backups`. Backup files are written to `data/backups` and audit logged. Set `BACKUP_INTERVAL_MINUTES` above `0` or update the persisted policy to enable the local scheduler; `BACKUP_RETENTION_DAYS` prunes old completed backup files. `POST /api/backups/:id/validate` checks that a backup file exists and, for SQLite copies, has a valid SQLite header. `POST /api/backups/:id/restore` requires `{ "confirm": "RESTORE <id>" }`, creates a pre-restore safety copy, restores the selected local SQLite `.db`, and audit logs the recovery path.

## Audit Integrity

Audit writes redact configured sensitive keys and chain each new row to the previous hashed row. `GET /api/audit/verify` reports whether the hashed append-only chain is intact for rows written after this feature was enabled; older rows are counted as legacy.

## Verification

After seeding, run:

```bash
npm run build
npm run test:smoke
```
