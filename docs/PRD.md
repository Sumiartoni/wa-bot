# PRD

## 1. Overview
A private, admin-only WhatsApp support console that links a JokiTugasKu.online account to a local WhatsApp session via Baileys. Provides a real-time inbox, manual replies, templates/keyword automations, and optional AI-assisted first-response and suggestions (via OpenRouter-compatible models). AI is an assistant — admins can take over any conversation instantly; per-customer AI toggles, confidence fallbacks, rate limiting, and local session storage ensure safe, business-compliant messaging. Built to run on a single VPS (Docker Compose) using Node.js/Express, React + Vite + Tailwind, Baileys, Socket.IO, and SQLite/Prisma.

Primary goals:
- Speed up first-touch responses while preserving human oversight
- Keep all secrets and WhatsApp sessions local and admin-restricted
- Provide order-aware replies and inline order capture from chats
- Low-resource, easy-to-deploy single-VPS solution for one private admin/team

## 2. Requirements

Functional
- Admin authentication (local users, hashed passwords)
- Connect a local WhatsApp account via Baileys (QR scanning restricted to authenticated admins)
- Real-time inbox (Socket.IO) showing incoming/outgoing messages, message type (manual/template/AI)
- Manual replies, templates, and keyword automations
- AI-assisted reply generation via OpenRouter (toggle per-customer; confidence thresholding)
- Inline order lookup and lightweight order-drafting from chat
- Per-message audit logs and message metadata (who/what generated reply)
- Rate limiting and opt-out controls to prevent uncontrolled automation
- Session management: view & revoke local WhatsApp sessions
- Local storage for WhatsApp session files (excluded from Git)

Non-functional
- All secrets in .env only; no external storage of keys
- Minimal RAM/CPU footprint (suitable for small VPS)
- Fast implementation and simple admin UX
- Secure by default: password hashing, CSRF protections, HTTPS recommended for VPS
- Single-tenant (not SaaS) — store all data locally in SQLite

Acceptance criteria (examples)
- Admin can generate an AI suggestion for a chat and send it in <5s (model dependent)
- AI suggestions are labeled and editable before sending
- Per-contact AI toggle prevents AI calls when disabled
- WhatsApp QR flow accessible only after admin login

## 3. Core Features

1. Authentication & Admin Console
   - Local admin accounts with hashed passwords (bcrypt)
   - Login screen, session timeout, session revoke
   - Admin role(s): SuperAdmin (config), SupportAgent (reply)

2. WhatsApp Connection (Baileys)
   - QR-based login visible only to admins
   - Local session file saved (encrypted optional) and excluded from repo
   - Session management UI (connect/disconnect, download session file)

3. Real-time Inbox
   - Socket.IO push of new messages, status updates, typing, delivered/read
   - Filter/search (contact name, phone, order id, tag)
   - Message metadata: source (WhatsApp), generated-by (Human/Template/AI), confidence

4. Manual Reply, Templates & Keyword Automation
   - One-click templates; editable before sending
   - Keyword triggers to suggest template/AI reply
   - Rate limiting per contact and per minute/hour global throttles

5. AI-Assisted Replies (OpenRouter)
   - On-demand AI suggestion generation (server proxies OpenRouter)
   - System prompt includes KB snippet and order context
   - Per-contact AI toggle; confidence thresholding with automatic admin fallback
   - UI shows AI suggestion, confidence indicator, and "Send as AI" vs "Send as Manual"
   - Model chooser (recommended default: openai/gpt-4o-mini for cost)

6. Knowledge Base & Order Context
   - Local KB entries (title, snippet, tags)
   - Inline order lookup (order status, price, ETA)
   - KB + order data injected into AI prompt for context-aware replies

7. Order Drafting from Chat
   - Capture order data via interactive messages or form
   - Attach draft to conversation, convert to real order in JokiTugasKu system (export or webhook)
   - Store minimal order snapshot locally for AI context

8. Audit & Metrics
   - Per-message audit trail (who created, timestamps, reason)
   - Basic metrics: response times, messages per contact, AI usage stats
   - Export logs (CSV)

9. Security & Compliance
   - All secrets in .env
   - WhatsApp session files local and restricted
   - Admin-only QR access
   - Clear UI labels: AI vs Template vs Manual

Acceptance tests for each feature should be defined during implementation phase.

## 4. User Flow

1. Admin onboarding
   - Admin registers locally (or seed user created)
   - Admin logs in using hashed credentials

2. Connect WhatsApp
   - Admin navigates to "WhatsApp > Connect"
   - Server generates Baileys QR; displayed only after auth
   - Scan QR in WhatsApp; session file saved locally; UI shows "Connected"

3. Inbox & conversation handling
   - Incoming message appears in Inbox via Socket.IO
   - Admin clicks conversation — conversation view loads chat, order snippets, KB suggestions
   - Admin can:
     - Type manual reply (send)
     - Choose a template (edit then send)
     - Request AI suggestion (server calls OpenRouter when per-contact AI toggle is ON)
       - AI returns suggestion + optional confidence heuristics
       - If below confidence threshold: UI flags and suggests admin takeover
     - Admin edits AI suggestion or selects "Send as AI" or "Send as Manual"

4. Convert chat to order
   - Admin clicks "Create Order" in conversation UI
   - Minimal form populates from chat-extracted fields; admin confirms
   - Order drafts saved locally and optionally exported/integrated to system

5. Session & audit management
   - Admin views session log, can revoke WhatsApp session (kills Baileys session)
   - Audit logs show message origination and any AI involvement

6. Admin toggles & policies
   - Per-contact AI toggle defaults to OFF unless explicitly enabled
   - Global rate limiting prevents >N automated messages per minute

Branching: If AI suggests "uncertain" (low-confidence), message is flagged, and system either refuses to auto-send or requires admin validation.

## 5. Architecture & Integrations

High-level stack
- Frontend: React + Vite + Tailwind (SPA)
- Backend: Node.js + Express
- WhatsApp: Baileys (local library)
- Realtime: Socket.IO (server + client)
- DB: SQLite via Prisma ORM
- AI: OpenRouter HTTP API (proxied through Express)
- Deployment: Docker Compose on single VPS
- Secrets: .env (DO NOT commit)

Server responsibilities (example REST/WebSocket endpoints)
- REST (Express)
  - POST /api/auth/login — authenticate admin (returns JWT/session cookie)
  - POST /api/auth/logout
  - GET /api/admin/sessions — list WhatsApp sessions
  - POST /api/whatsapp/connect — initiate QR streaming (requires auth)
  - POST /api/whatsapp/disconnect — revoke session
  - GET /api/conversations — list conversations
  - GET /api/conversations/:id — load conversation + order/KB context
  - POST /api/conversations/:id/message — send message (body: {text, type: manual|template|ai, meta})
  - POST /api/ai/generate — server-side proxy to OpenRouter (body includes model, messages, temperature)
  - GET /api/ai/models — optional proxy to OpenRouter /models
  - POST /api/orders — create order draft
  - GET /api/kb — KB CRUD
  - GET /api/templates — template CRUD
  - GET /api/audit — fetch audit logs
- WebSocket (Socket.IO)
  - Events: message:new, message:status, conversation:update, session:update

OpenRouter API (AI Models) — INTEGRATED DOCS (copy + usage)
- Base URL: https://openrouter.ai/api/v1
- Required header pattern (server must set Authorization from .env):
  {
    "Authorization": "Bearer YOUR_OPENROUTER_API_KEY",
    "Content-Type": "application/json",
    "HTTP-Referer": "https://your-app-domain.com",  // Optional
    "X-Title": "JokiTugasKu Support AI"  // Optional
  }

- Endpoint: POST /api/v1/chat/completions
  - Purpose: generate AI replies/suggestions
  - Example server request payload (proxy endpoint /api/ai/generate will forward to OpenRouter):
    {
      "model": "anthropic/claude-3.5-sonnet",
      "messages": [
        {
          "role": "system",
          "content": "You are a helpful support assistant for JokiTugasKu.online. Use concise, friendly Indonesian/English. Pull from knowledge base: [KB_SNIPPET: Pricing starts at Rp50k/task]. Reference order if available. Suggest fallback to human if low confidence. End with 'Admin akan lanjutkan jika diperlukan.'"
        },
        {
          "role": "user",
          "content": "Chat context: Customer: 'Saya mau joki tugas matematika kuliah, berapa harga?' Order data: No order yet. Confidence threshold: 0.8."
        }
      ],
      "temperature": 0.3,
      "max_tokens": 200,
      "stream": false
    }
  - Example response (truncated):
    {
      "id": "req_01j2k3l4m5n6o7p8",
      "object": "chat.completion",
      "model": "anthropic/claude-3.5-sonnet",
      "choices": [
        {
          "message": {
            "role": "assistant",
            "content": "Halo! Joki tugas matematika kuliah mulai dari Rp50.000 tergantung kesulitan. Bisa share detail tugasnya? Admin akan lanjutkan jika diperlukan."
          }
        }
      ],
      "usage": {
        "prompt_tokens": 120,
        "completion_tokens": 45,
        "total_tokens": 165
      }
    }
  - Notes:
    - Server must proxy requests so OpenRouter API key stays in .env.
    - Use cheap models by default (e.g., openai/gpt-4o-mini) and allow admin to change model.
    - Use low temperature (0.2–0.4) for deterministic replies.
    - Consider using response parsing or light heuristics to determine "confidence" (e.g., presence of hedging phrases, token usage) — but primary fallback is admin review.

- Endpoint: GET /api/v1/models
  - Usage: List available models and pricing; server may cache locally and expose to admin UI.

Integration patterns
- AI proxy (/api/ai/generate): server composes system prompt including KB snippets and order snapshot, then POSTs to OpenRouter. AI responses are returned to UI as suggestions (not auto-sent).
- Per-contact AI toggle: DB flag; server checks before calling OpenRouter. If disabled, /api/ai/generate returns 403 or bypasses call.
- Rate limiting: server-level throttle on calls to OpenRouter and on sending messages via Baileys (configurable limits).
- Streaming: optional stream=true param for real-time UI suggestions (requires streaming support and client-side handling).

Baileys integration
- Use Baileys library inside Node app to:
  - Create and manage local WhatsApp session
  - Send/receive messages, attachments, and message status updates
- Store Baileys session files under /data/whatsapp-sessions; add .gitignore rule
- QR flow only available via authenticated admin UI; server exposes a protected streaming endpoint to deliver QR frames via Socket.IO or SSE
- On reconnect, session file loads to restore connection

Socket.IO (Realtime)
- Push incoming messages and conversation updates to all connected admin clients
- Authenticate Socket.IO connections with admin session token

Storage & backups
- SQLite DB file stored under /data/sqlite/jokitugasku.db — include simple backup script (e.g., hourly cron to compress to /data/backups)
- WhatsApp session files and backups stored locally and must be backed up if needed

Deployment (Docker Compose)
- Containers:
  - app (Node/Express)
  - web (React static build served by Node or Nginx)
  - sqlite/data volume (host-mounted)
- .env for secrets: ADMIN_SEED, OPENROUTER_API_KEY, SESSION_SECRET, BAILEYS_CONFIG
- Resource constraints: keep images minimal, use node:alpine base, single CPU, target <1GB RAM on small VPS

Security controls
- All API calls to OpenRouter proxied server-side
- .env never committed; recommend server-level secret management
- HTTPS termination on VPS recommended (certbot + nginx)
- Password hashing with bcrypt; JWT/session cookie secure flags

## 6. Database Schema

Prisma-style models (concise table view). Use SQLite via Prisma.

Table: users
| Column | Type | Notes |
|---|---:|---|
| id | Int (PK, autoincrement) | admin id |
| email | String (unique) | login |
| password_hash | String | bcrypt hash |
| name | String | display name |
| role | String | 'superadmin' | 'agent' |
| created_at | DateTime | default now |
| last_active_at | DateTime | nullable |

Table: whatsapp_sessions
| Column | Type | Notes |
|---|---:|---|
| id | Int (PK) | |
|session_name| String | filename or label |
| file_path | String | local path to session file (restricted) |
| connected | Boolean | connected flag |
| created_at | DateTime | |
| last_connected_at | DateTime | |

Table: contacts
| Column | Type | Notes |
|---|---:|---|
| id | Int (PK) | |
| wa_id | String (unique) | WhatsApp jid (e.g., 6281...) |
| name | String | contact name if known |
| phone | String | normalized |
| ai_enabled | Boolean | per-contact AI toggle |
| opt_out | Boolean | customer opted out of automation |
| created_at | DateTime | |

Table: conversations
| Column | Type | Notes |
|---|---:|---|
| id | Int (PK) | |
| contact_id | Int (FK) | contacts.id |
| last_message_at | DateTime | index |
| unread_count | Int | |
| created_at | DateTime | |

Table: messages
| Column | Type | Notes |
|---|---:|---|
| id | Int (PK) | |
| conversation_id | Int (FK) | |
| wa_id | String | WhatsApp message id |
| from | String | 'contact' | 'admin' | 'system' |
| author_id | Int (FK users) | nullable |
| content | Text | message text |
| media_path | String | local path if media |
| generated_by | String | 'manual' | 'template' | 'ai' |
| ai_model | String | nullable |
| ai_confidence | Float | nullable (0..1) |
| created_at | DateTime | indexed |
| delivered_at | DateTime | nullable |
| read_at | DateTime | nullable |

Table: templates
| Column | Type | Notes |
|---|---:|---|
| id | Int | |
| name | String | |
| body | Text | supports placeholders like {{name}} |
| tags | String | CSV/tags |
| created_by | Int | users.id |
| created_at | DateTime | |

Table: knowledge_base
| Column | Type | Notes |
|---|---:|---|
| id | Int | |
| title | String | |
| snippet | Text | short excerpt used in prompts |
| content | Text | full content |
| tags | String | |
| created_at | DateTime | |

Table: orders
| Column | Type | Notes |
|---|---:|---|
| id | Int | |
| contact_id | Int | |
| order_ref | String | local reference |
| status | String | draft | open | completed |
| total | Int | in IDR (optional) |
| attributes | JSON | free-form (task details) |
| created_by | Int | admin id |
| created_at | DateTime | |

Table: audit_logs
| Column | Type | Notes |
|---|---:|---|
| id | Int | |
| action | String | e.g., message_sent, ai_generated |
| actor_id | Int | users.id nullable for system |
| target_type | String | message|conversation|order|
| target_id | Int | |
| meta | JSON | details |
| created_at | DateTime | indexed |

Table: rate_limits
| Column | Type | Notes |
|---|---:|---|
| id | Int | |
| scope | String | per_contact | global |
| limit | Int | messages per window |
| window_seconds | Int | e.g., 60 |
| created_at | DateTime | |

Indexes: messages.created_at, conversations.last_message_at, contacts.wa_id unique

Notes:
- Keep schema small and extend iteratively.
- Use Prisma migrations and seed admin user from environment variable on first run.

## 7. Constraints

Deployment & Operations
- Single-VPS constraint: design for limited CPU/RAM. Avoid heavy models or long-running processes in default config.
- Docker Compose only; no managed cloud services required.

Security & Privacy
- All secrets in .env (OPENROUTER_API_KEY, SESSION_SECRET, DB path); no external secret storage.
- WhatsApp session files stored locally with filesystem permissions. Add instructions to rotate/revoke sessions.
- QR scanning gated by admin authentication.
- Clear UI labeling for AI content; admins must approve low-confidence suggestions.
- Per-contact opt-out and AI toggle to prevent unwanted automation.

AI & Cost
- OpenRouter usage is pay-per-token. Default to low-cost models (gpt-4o-mini/openai/gpt-4o-mini) and low temperature.
- Implement safeguards: per-minute and daily cap on OpenRouter calls to control cost.
- Proxy all OpenRouter calls through server to keep API key private.

Operational & Legal
- This PRD assumes operator is responsible for compliance with WhatsApp terms and local regulations.
- No external analytics, email, or payment integrations in Phase 1.

Implementation priorities (Phase 1)
1. Admin auth + DB + Prisma seed
2. Baileys connection + protected QR flow + session storage
3. Real-time inbox with Socket.IO + message persistence
4. Manual replies + templates + KB CRUD
5. AI proxy to OpenRouter with per-contact toggle + confidence handling
6. Order draft flow + audit logs
7. Basic rate limiting, backups, and Docker Compose deployment

Security checklist for release
- .env present, never committed
- bcrypt password hashing
- HTTPS recommended for production
- Admin-only QR and session endpoints
- OpenRouter key only on server side

(End of PRD)

---

Business Requirements Document (BRD) — Phase 2
----------------------------------------------
Purpose
- Expand the Phase 1 private WhatsApp support console into a hardened, production-ready single-VPS deployment with additional operational controls, observability, durability, and safer AI workflows. Focus remains single-tenant, local storage, admin-only access, and minimal resource footprint.

Goals (Phase 2 scope)
- Harden security and operational controls: session encryption at rest, session rotation, admin session management, CSRF tokens, and strong defaults.
- Improve AI safety & cost control: streaming AI suggestions, confidence scoring improvements, backoff + quota enforcement, heuristics detection, and per-contact / per-team policies.
- Improve observability & backups: metrics, exportable CSVs, periodic SQLite backups, webhook delivery logs, and lightweight alerting for failures.
- Extend workflows: order webhook integration to JokiTugasKu, ordered message queueing (ordering guarantees), message replays, and admin macros.
- Provide admin-configurable policies: global & per-contact rate limits, AI quotas, model defaults, KB weighting, template categories, and retention policies.
- UX enhancements: streaming suggestion UI, selectable model with costs displayed, AI-suggestion history, template versioning, and message redaction/audit controls.

Acceptance Criteria (Phase 2)
- Admin can enable encrypted WhatsApp session storage; sessions decrypt/load and remain accessible only to authorized processes.
- Streaming AI suggestions available (<5s chunk latency typical for small models); UI receives streaming chunks via Socket.IO.
- Global and per-contact rate limits enforced, with admin-configurable thresholds; UI shows current usage and blocked events.
- Order webhook delivers draft to JokiTugasKu endpoint with retry/backoff and logs; admin can view delivery status.
- Backup scheduler creates hourly compressed DB and session snapshots to /data/backups and provides on-demand export via API.
- Audit logs are immutable (append-only) and exportable as CSV.

Detailed Tech Stack (Phase 2)
----------------------------
Runtime & Deployment
- Docker Compose (single VPS): minimal images, node:18-alpine base for server, nginx:alpine for optional TLS termination, static build for frontend.
- Resource target: <=1 vCPU, <=1GB RAM recommended for default config.

Backend
- Node.js 18+ (runtime)
- Express 4.x for REST endpoints and middleware
- Socket.IO for real-time events and streaming AI chunks
- Baileys (whatsapp-web.js alternative not used — Baileys per PRD)
- Prisma ORM (SQLite connector)
- SQLite (file: /data/sqlite/jokitugasku.db)
- BullMQ or a lightweight in-process queue (Phase 2: use BullMQ w/ Redis optional; but to keep single-VPS no external services — fallback in-memory queue with durable job persistence to disk)
  - Default: in-process persistent queue implemented via append-only journal to disk (lightweight)
- OpenRouter proxy integration (server-side only)
- Bcrypt for password hashing
- JSON Web Tokens (JWT) for API auth + secure, httpOnly cookie session support
- Helmet, csurf, rate-limiters, and input validation (zod or joi)

Frontend
- React + Vite
- Tailwind CSS
- Socket.IO-client for real-time
- SWR or React Query for server data fetching
- Tiny state management (zustand) for session + rate-limit UI
- File input & download helpers for session export

Storage & Files
- /data/sqlite/ — DB file
- /data/whatsapp-sessions/ — session files (optional encrypted)
- /data/backups/ — periodic compressed backups (gzip)
- .gitignore configured to exclude /data/* and .env

Security & Secrets
- .env variables (never committed):
  - SESSION_SECRET
  - ADMIN_SEED (seeding initial admin)
  - OPENROUTER_API_KEY
  - BAILEYS_KEY_PASSPHRASE (if using session encryption)
  - BACKUP_CRON (optional)
- HTTPS via optional Nginx + certbot outside container; server supports secure cookie flags and CSP headers.

Operational Tools
- Lightweight admin CLI script (node) to rotate secrets, create backup, and seed admin.
- Health endpoints and metrics: /api/status, /api/metrics (prometheus-lite JSON)
- Backup scheduler: cron inside container or supervisor process.

Phase 2 Trade-offs & Constraints
- No external managed services by default. Redis is optional only if operator wants higher throughput.
- Streaming AI uses Socket.IO to avoid SSE complexity.
- Avoid heavy models; default to low-cost OpenRouter models; admins explicitly opt into higher-cost models.

Internal API Documentation — Endpoints, Methods, and Exact JSON Payloads
-----------------------------------------------------------------------
Authentication & Security
- All API responses use JSON: { success: boolean, data?: any, error?: { code, message } }
- Auth:
  - JWT in Authorization header: Authorization: Bearer <JWT>
  - For browser clients, server sets secure, httpOnly cookie (token) and returns X-CSRF-Token in login response. All unsafe endpoints require X-CSRF-Token header.
  - Socket.IO connections pass token as auth payload.

Env variables (server must read on boot):
- SESSION_SECRET, OPENROUTER_API_KEY, ADMIN_SEED, BAILEYS_KEY_PASSPHRASE (opt), DB_PATH, BACKUP_DIR

1) POST /api/auth/login
- Purpose: Authenticate admin, return JWT + CSRF token.
- Headers: Content-Type: application/json
- Request JSON:
  {
    "email": "admin@example.com",
    "password": "plaintext-password"
  }
- Success 200:
  {
    "success": true,
    "data": {
      "token": "<JWT>",
      "csrfToken": "<CSRF_TOKEN>",
      "user": {
        "id": 1,
        "email": "admin@example.com",
        "name": "Admin Name",
        "role": "superadmin"
      }
    }
  }
- Errors: 401 invalid credentials

2) POST /api/auth/logout
- Purpose: Revoke session (server-side revocation)
- Headers: Authorization: Bearer <JWT>, X-CSRF-Token: <CSRF_TOKEN>
- Request JSON: {}
- Success 200:
  { "success": true, "data": { "loggedOut": true } }

3) GET /api/admin/users
- Purpose: List admin users (SuperAdmin only)
- Headers: Authorization, X-CSRF-Token
- Response 200:
  {
    "success": true,
    "data": [
      { "id":1, "email":"admin@x", "name":"A", "role":"superadmin", "last_active_at":"2026-05-01T..Z" },
      ...
    ]
  }

4) POST /api/admin/users (create admin)
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "email": "agent@example.com",
    "password": "StrongPass!23",
    "name": "Agent Name",
    "role": "agent"
  }
- Response:
  { "success": true, "data": { "id": 3, "email": "agent@example.com" } }

5) GET /api/whatsapp/sessions
- Purpose: List local WhatsApp sessions
- Headers: Authorization, X-CSRF-Token
- Response:
  {
    "success": true,
    "data": [
      {
        "id": 1,
        "session_name": "primary",
        "connected": true,
        "encrypted": true,
        "created_at": "2026-05-01T...",
        "last_connected_at": "2026-05-07T..."
      }
    ]
  }

6) POST /api/whatsapp/connect
- Purpose: Start QR streaming for new Baileys session
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "session_name": "primary",
    "encrypt": true  // optional; if true server will encrypt session file with BAILEYS_KEY_PASSPHRASE
  }
- Response: (200) initial handshake; QR frames are emitted via Socket.IO event 'whatsapp:qr' (see Socket.IO events).
  {
    "success": true,
    "data": { "session_id": 2, "qr_stream_token": "<short-lived-token>", "expires_in": 60 }
  }
- Notes: QR frames streamed to authenticated sockets only; server validates session.

7) POST /api/whatsapp/disconnect
- Purpose: Revoke/kill session
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "session_id": 1,
    "revoke_all_tokens": true
  }
- Response:
  { "success": true, "data": { "disconnected": true } }

8) GET /api/whatsapp/sessions/:id/download
- Purpose: Download session file (only superadmin)
- Headers: Authorization, X-CSRF-Token
- Response: application/octet-stream; Content-Disposition: attachment; filename=session_<id>.zip

9) GET /api/conversations
- Purpose: Paginated list of conversations with filters
- Headers: Authorization
- Query params:
  - page, limit, q (search), tag, ai_enabled, unread_only
- Response:
  {
    "success": true,
    "data": {
      "items": [
        {
          "id": 42,
          "contact": { "id": 10, "name":"Budi", "phone":"6281..." },
          "last_message_at": "2026-05-07T..Z",
          "unread_count": 1,
          "ai_enabled": true
        }
      ],
      "meta": { "page":1, "limit":20, "total":123 }
    }
  }

10) GET /api/conversations/:id
- Purpose: Load conversation + order/KB context
- Headers: Authorization
- Response:
  {
    "success": true,
    "data": {
      "conversation": {
        "id": 42,
        "contact_id": 10,
        "last_message_at":"...",
        "unread_count":0
      },
      "contact": {
        "id": 10,
        "wa_id": "62812345678@s.whatsapp.net",
        "name":"Budi",
        "phone":"62812345678",
        "ai_enabled": true,
        "opt_out": false
      },
      "messages": [
        {
          "id": 9001,
          "wa_id": "ABCD1234",
          "from": "contact",
          "author_id": null,
          "content": "Saya mau joki tugas...",
          "generated_by": "contact",
          "ai_model": null,
          "ai_confidence": null,
          "created_at": "..."
        }
      ],
      "orders": [
        { "id": 7, "order_ref":"DRAFT-001", "status":"draft", "attributes": { "task":"matematika" } }
      ],
      "kb_snippets": [
        { "id": 3, "title":"Pricing", "snippet":"Pricing starts at Rp50k/task" }
      ]
    }
  }

11) POST /api/conversations/:id/message
- Purpose: Send message (manual/template/ai)
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "type": "manual", // manual | template | ai
    "text": "Halo, harga mulai dari Rp50.000.",
    "template_id": null, // optional
    "attachments": [], // optional array of file ids (server-side upload flow)
    "meta": { "send_as": "manual", "client_msg_id": "local-uuid-123" }
  }
- Server behavior:
  - Validate rate limits for contact & global.
  - If type === 'ai' ensure last AI suggestion was approved and include ai_model & ai_confidence in audit.
  - Send via Baileys, persist message with generated_by set accordingly.
- Success 200:
  {
    "success": true,
    "data": {
      "message_id": 9002,
      "wa_id": "MSG_1234",
      "status": "queued"
    }
  }
- Error 429: rate limit exceeded
  { "success": false, "error": { "code": "rate_limited", "message": "Per-contact rate limit exceeded." } }

12) POST /api/templates
- Purpose: Create template
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "name": "Price Reply",
    "body": "Halo {{name}}, harga mulai dari Rp{{price}}. Kirim detail tugas.",
    "tags": ["pricing","reply"],
    "created_by": 1
  }
- Response:
  { "success": true, "data": { "id": 12, "name":"Price Reply" } }

13) GET /api/templates
- Response:
  { "success": true, "data": [ { id, name, body, tags, created_by, created_at } ] }

14) GET /api/kb
- Purpose: KB CRUD and search
- Headers: Authorization
- Query: q, tags
- Response:
  { "success": true, "data": [ { id, title, snippet, tags } ] }

15) POST /api/kb
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "title":"Pricing",
    "snippet":"Pricing starts at Rp50k/task",
    "content":"Full pricing policy ...",
    "tags":["pricing"]
  }
- Response 201 with created KB entry.

16) POST /api/ai/generate
- Purpose: Generate AI suggestion (non-streaming)
- Headers: Authorization, X-CSRF-Token
- Request (exact):
  {
    "conversation_id": 42,
    "model": "openai/gpt-4o-mini",
    "temperature": 0.3,
    "max_tokens": 200,
    "system_prompt_overrides": null, // optional string to append/replace
    "stream": false,
    "user_message": "Customer: 'Saya mau joki tugas...' ",
    "kb_ids": [3,4], // include KB snippets by id; server will fetch and inject
    "order_snapshot_id": 7 // optional
  }
- Server behavior:
  - Check contact.ai_enabled and contact.opt_out; if disabled -> 403 {code: ai_disabled}
  - Check AI quotas and rate limits; if exceeded -> 429 with quota info.
  - Compose system + user prompt (includes KB snippets and order snapshot).
  - Proxy request to OpenRouter with server-side API key.
  - Parse response and compute a lightweight confidence score:
    - Heuristics: presence of hedging words, token usage ratio, explicit uncertainty markers, fallback phrases; combine with model-provided metrics if available.
  - Persist ai_generation record with request/response, model, tokens usage.
- Success 200:
  {
    "success": true,
    "data": {
      "ai_id": "ai_gen_2026_0001",
      "model": "openai/gpt-4o-mini",
      "suggestion": "Halo! Harga mulai dari Rp50.000 ... Admin akan lanjutkan jika diperlukan.",
      "confidence": 0.86,
      "usage": { "prompt_tokens": 120, "completion_tokens": 45, "total_tokens": 165 }
    }
  }

17) POST /api/ai/generate/stream
- Purpose: Streaming AI suggestions (Socket.IO recommended)
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "conversation_id": 42,
    "model": "openai/gpt-4o-mini",
    "temperature": 0.2,
    "max_tokens": 500
  }
- Response: 202 Accepted
  {
    "success": true,
    "data": { "stream_id": "stream_abc123" }
  }
- Streaming mechanism:
  - Server emits Socket.IO events to the requesting socket: 'ai:stream:start' -> 'ai:stream:chunk' (payload { stream_id, text_chunk }) -> 'ai:stream:end' (payload with final confidence & metadata)
  - If interrupted or cancelled, server emits 'ai:stream:error'.

18) POST /api/orders
- Purpose: Create/update order draft from conversation
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "conversation_id": 42,
    "contact_id": 10,
    "status": "draft",
    "attributes": { "task_type":"matematika", "deadline":"2026-05-10", "price":50000 },
    "created_by": 1,
    "notify_customer": false
  }
- Response:
  {
    "success": true,
    "data": { "id": 201, "order_ref": "DRAFT-20260507-201", "status":"draft" }
  }
- Webhook integration:
  - If configured in admin settings, server will POST the order draft to configured JokiTugasKu endpoint with retries and log statuses. See /api/integrations/webhooks endpoints.

19) POST /api/integrations/webhooks/test
- Purpose: Test outbound webhook for orders
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "url": "https://jokitugasku.online/webhook/order",
    "payload": { "order_ref":"TEST-1", "attributes": { "task":"test" } },
    "headers": { "X-API-KEY": "secret" },
    "attempts": 3
  }
- Response: { "success": true, "data": { "status": "queued", "attempt_id":"..." } }

20) GET /api/audit
- Purpose: Fetch audit logs (paginated & filtered)
- Headers: Authorization
- Query: actor_id, action, target_type, since, until, page, limit
- Response:
  {
    "success": true,
    "data": {
      "items": [ { "id": 501, "action":"message_sent", "actor_id":1, "target_type":"message", "target_id":9002, "meta": {...}, "created_at":"..." } ],
      "meta": { "page":1, "limit":50, "total": 1234 }
    }
  }
- Export CSV:
  - GET /api/audit/export?since=...&until=... returns CSV file or presigned download.

21) GET /api/metrics
- Purpose: Basic metrics for admin dashboard
- Headers: Authorization
- Response:
  {
    "success": true,
    "data": {
      "messages_last_24h": 120,
      "ai_calls_last_24h": 18,
      "avg_response_time_minutes": 2.8,
      "open_conversations": 12
    }
  }

22) POST /api/backup
- Purpose: Trigger manual backup; scheduling runs automatically per BACKUP_CRON
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "include_sessions": true,
    "include_db": true
  }
- Response 202:
  {
    "success": true,
    "data": { "backup_id":"backup_2026_05_07_12_00", "status":"started", "download_path":"/data/backups/backup_..." }
  }

23) GET /api/ratelimit/status
- Purpose: Return rate limit policies and current usage
- Headers: Authorization
- Response:
  {
    "success": true,
    "data": {
      "policies": [
        { "scope":"per_contact", "limit":5, "window_seconds":60 },
        { "scope":"global_ai", "limit":100, "window_seconds":3600 }
      ],
      "usage": {
         "contact_10": { "count": 3, "window_expires_at": "..." }
      }
    }
  }

24) POST /api/settings/policies
- Purpose: Update admin policies (superadmin only)
- Headers: Authorization, X-CSRF-Token
- Request:
  {
    "default_ai_model": "openai/gpt-4o-mini",
    "ai_confidence_threshold": 0.8,
    "global_ai_hourly_limit": 100,
    "per_contact_min_interval_seconds": 30,
    "session_encryption_enabled": true
  }
- Response: 200 with updated settings.

Socket.IO Events (Realtime)
- Connection: clients must send auth token in socket auth: { token: "<JWT>" }
- Server-side auth validation and CSRF pairing for streams.
- Events emitted:
  - whatsapp:qr — { session_id, qr_base64, expires_at } (during connect flow)
  - message:new — { conversation_id, message: { id, wa_id, from, content, generated_by, ai_confidence, created_at } }
  - message:status — { wa_id, status: "sent"|"delivered"|"read", delivered_at, read_at }
  - conversation:update — { conversation_id, last_message_at, unread_count }
  - ai:stream:start — { stream_id, ai_id, model }
  - ai:stream:chunk — { stream_id, text_chunk }
  - ai:stream:end — { stream_id, suggestion, confidence, usage }
  - session:update — { session_id, connected, last_connected_at }
  - rate:blocked — { type: "per_contact"|"global", reason, policy }

Payload Examples (exact)
- Send message (POST /api/conversations/42/message):
  {
    "type": "template",
    "text": "Halo {{name}}, order anda sedang diproses.",
    "template_id": 12,
    "meta": { "placeholders": { "name": "Budi", "order_ref": "DRAFT-101" }, "send_as": "manual" }
  }

- AI generate (POST /api/ai/generate):
  {
    "conversation_id": 42,
    "model": "openai/gpt-4o-mini",
    "temperature": 0.2,
    "max_tokens": 200,
    "user_message": "Customer asked about price for university-level math task: 'berapa harga?'",
    "kb_ids": [3],
    "order_snapshot_id": 7,
    "stream": false
  }

- Order webhook payload sent to JokiTugasKu (server-side):
  {
    "order_ref": "DRAFT-20260507-201",
    "contact": {
      "name": "Budi",
      "phone": "62812345678",
      "wa_id": "62812345678@s.whatsapp.net"
    },
    "attributes": {
      "task_type": "matematika",
      "deadline": "2026-05-10",
      "price": 50000
    },
    "created_at": "2026-05-07T12:00:00Z"
  }

Error patterns (consistent)
- 400 Bad Request — validation errors; response includes errors array
- 401 Unauthorized — invalid token or missing auth
- 403 Forbidden — insufficient role or per-contact AI disabled
- 404 Not Found — resource missing
- 429 Too Many Requests — rate-limit exceeded; response includes retry_after seconds and policy id
- 500 Internal Server Error — server issue

Entity Relationship Diagram (ERD) — mermaid erDiagram
-----------------------------------------------------
erDiagram
  USERS ||--o{ MESSAGES : "author_of"
  USERS ||--o{ TEMPLATES : "created_by"
  USERS ||--o{ ORDERS : "created_by"
  USERS ||--o{ AUDIT_LOGS : "actor"
  WHATSAPP_SESSIONS ||--o{ CONVERSATIONS : "hosts"
  CONTACTS ||--o{ CONVERSATIONS : "has"
  CONVERSATIONS ||--o{ MESSAGES : "contains"
  CONTACTS ||--o{ ORDERS : "places"
  ORDERS ||--o{ AUDIT_LOGS : "target_orders"
  MESSAGES ||--o{ AUDIT_LOGS : "target_messages"
  TEMPLATES ||--o{ AUDIT_LOGS : "target_templates"
  KNOWLEDGE_BASE ||--o{ AI_GENERATIONS : "used_in"
  CONVERSATIONS ||--o{ AI_GENERATIONS : "generations_for"
  AI_GENERATIONS ||--o{ AUDIT_LOGS : "ai_actions"
  RATE_LIMITS ||--o{ AUDIT_LOGS : "rate_events"

Database Schema (Prisma-style tables + explanation)
--------------------------------------------------
users
- id             Int      @id @default(autoincrement())
- email          String   @unique
- password_hash  String
- name           String
- role           String   // 'superadmin' | 'agent'
- created_at     DateTime @default(now())
- last_active_at DateTime?

whatsapp_sessions
- id               Int      @id @default(autoincrement())
- session_name     String
- file_path        String
- encrypted        Boolean  @default(false)
- encryption_meta  Json?    // store algorithm/version non-secret
- connected        Boolean  @default(false)
- created_at       DateTime @default(now())
- last_connected_at DateTime?

contacts
- id         Int      @id @default(autoincrement())
- wa_id      String   @unique
- name       String?
- phone      String?
- ai_enabled Boolean  @default(false)
- opt_out    Boolean  @default(false)
- tags       String?  // CSV, for Phase 2 simple tagging
- created_at DateTime @default(now())

conversations
- id               Int      @id @default(autoincrement())
- contact_id       Int
- last_message_at  DateTime?
- unread_count     Int      @default(0)
- created_at       DateTime @default(now())
- FOREIGN KEY (contact_id) REFERENCES contacts(id)

messages
- id               Int      @id @default(autoincrement())
- conversation_id   Int
- wa_id            String?  // WhatsApp message id
- from             String   // 'contact' | 'admin' | 'system'
- author_id        Int?     // FK users.id nullable
- content          Text?
- media_path       String?  // local path
- generated_by     String   // 'manual' | 'template' | 'ai' | 'system'
- ai_model         String?
- ai_confidence    Float?
- created_at       DateTime @default(now())
- delivered_at     DateTime?
- read_at          DateTime?
- meta             Json?    // store custom meta (placeholders, client_msg_id)
- FOREIGN KEY (conversation_id) REFERENCES conversations(id)
- INDEX on created_at

templates
- id         Int      @id @default(autoincrement())
- name       String
- body       Text
- tags       String?  // CSV
- created_by Int
- created_at DateTime @default(now())
- FOREIGN KEY (created_by) REFERENCES users(id)

knowledge_base
- id         Int     @id @default(autoincrement())
- title      String
- snippet    Text
- content    Text
- tags       String? // CSV
- created_at DateTime @default(now())

orders
- id          Int      @id @default(autoincrement())
- contact_id  Int
- order_ref   String   @unique
- status      String   // 'draft' | 'open' | 'completed'
- total       Int?     // in IDR
- attributes  Json
- created_by  Int
- created_at  DateTime @default(now())
- FOREIGN KEY (contact_id) REFERENCES contacts(id)
- FOREIGN KEY (created_by) REFERENCES users(id)

audit_logs
- id         Int      @id @default(autoincrement())
- action     String   // message_sent, ai_generated, session_revoked, etc
- actor_id   Int?     // nullable for system
- target_type String
- target_id  Int?
- meta       Json
- created_at DateTime @default(now())
- FOREIGN KEY (actor_id) REFERENCES users(id)

ai_generations (new for Phase 2)
- id           Int      @id @default(autoincrement())
- ai_id        String   @unique // server generated id
- conversation_id Int?
- contact_id   Int?
- model        String
- prompt       Text
- response     Text
- confidence   Float?   // 0..1
- usage        Json?    // { prompt_tokens, completion_tokens, total_tokens }
- created_at   DateTime @default(now())
- FOREIGN KEY (conversation_id) REFERENCES conversations(id)
- FOREIGN KEY (contact_id) REFERENCES contacts(id)

rate_limits
- id             Int     @id @default(autoincrement())
- scope          String  // per_contact | global_ai | per_minute | custom
- limit          Int
- window_seconds Int
- created_at     DateTime @default(now())

webhook_logs (new)
- id           Int     @id @default(autoincrement())
- url          String
- payload      Json
- response_code Int
- response_body Text?
- attempts     Int     @default(0)
- last_attempt_at DateTime?
- created_at   DateTime @default(now())

backups (new)
- id           Int     @id @default(autoincrement())
- backup_id    String  @unique
- path         String
- include_sessions Boolean
- include_db   Boolean
- created_at   DateTime @default(now())
- status       String  // started|completed|failed

notes on schema & migration
- Use Prisma migrations; seed admin user from ADMIN_SEED env var during first run.
- Use DB indexes on contacts.wa_id, conversations.last_message_at, messages.created_at, audit_logs.created_at.
- Keep ai_generations content and response trimmed for storage quota; consider offloading raw responses to /data/backups if needed.
- For encryption of session files: do not store passphrase in DB; store encryption_meta only.

Phase 2 Operational & Safety Notes (tie-back to PRD)
----------------------------------------------------
- AI safety: per-contact AI toggles and opt-out enforced in /api/ai/* endpoints; confidence threshold enforced in UI and server-side policy. Low-confidence suggestions are never sent automatically.
- Cost control: server tracks ai_generations.usage and enforces global_ai_hourly_limit and daily caps; /api/ratelimit/status surfaces usage.
- Sessions: QR flow gated by JWT + CSRF; session files optionally encrypted with BAILEYS_KEY_PASSPHRASE; session revocation destroys local files and writes audit log.
- Backups: /api/backup triggers gzip of /data/sqlite and /data/whatsapp-sessions; backup files stored in /data/backups and admin can download.
- Messaging order: messages are queued per-conversation to preserve order; if Baileys send fails, server retries with exponential backoff and writes audit_log entries.
- Legal & compliance: all secrets remain in .env; operator is responsible for HTTPS and backups. Provide explicit UI labels for AI-generated content and store ai_generation records with confidence & prompt to assist audits.

Implementation Roadmap (Phase 2 — high level)
- Week 1: Session encryption at rest, session rotate/revoke flow, session download, and protected QR streaming via Socket.IO.
- Week 2: Streaming AI support (Socket.IO) + confidence heuristics + ai_generations persistence + rate-limit enforcements.
- Week 3: Webhook order delivery with retry/backoff + webhook_logs + admin UI for integration settings.
- Week 4: Backups, backup UI, metrics and audit CSV exports, and final security hardening (csrf, helmet, cookie flags).
- Testing: Acceptance tests per PRD expanded to include backup restore, webhook retry scenarios, AI low-confidence block, and rate-limit enforcement.

End of Phase 2 deliverables:
- BRD (this doc), updated tech stack, full internal API spec (above), mermaid ERD and database schema ready for Prisma implementation.

---

UI/UX Structure — Main Screens & Components

1) Auth
- Screens: Login
- Purpose: Local admin auth; returns JWT + csrf token; seed admin flow on first-run.
- Key components:
  - LoginForm (email, password) -> POST /api/auth/login
  - Error banner (401, network)
  - Seed notice (if ADMIN_SEED present)
- States: idle, submitting, error
- Edge cases: password expired/locked (future), display password strength for new admin creation.

2) Dashboard (Landing)
- Screens: Overview (metrics + quick actions)
- Purpose: Quick telemetry & shortcuts: Connect WhatsApp, Inbox, Create Order, Sessions, Backup
- Components:
  - MetricsCard -> GET /api/metrics
  - QuickAction buttons (Connect WhatsApp -> open Sessions screen; Inbox -> open conversation list)
- Permissions: visible to all admin roles; SuperAdmin sees policy quicklink.

3) Inbox (Conversations List)
- Screens: Conversations list (left column) + search/filter bar
- Purpose: Real-time list of conversations; quick scan of unread, AI-enabled, tags, order id
- Components:
  - ConversationList (virtualized)
    - Item: avatar, name, phone, snippet (last message), unread badge, ai_enabled pill, last_message_at
  - Filters: q (name/phone/order id), ai_enabled, unread_only, tags
  - Pagination / infinite scroll -> GET /api/conversations?page...
- Socket events:
  - message:new -> update conversation item & move to top
  - conversation:update -> update unread_count
- States: loading, empty, network error, offline mode (stale)
- Keyboard: up/down navigate, Enter open conversation
- Rate-limit indicator (if policy blocks): small banner

4) Conversation View (CRITICAL)
- Screens: Center chat pane + right context panel + top contact header + composer
- Purpose: Main support UI — read messages, send manual/template/AI, create order, see KB/order context
- Components:
  - ContactHeader
    - contact.name / phone
    - ai_enabled toggle (PUT /api/contacts/:id)
    - opt_out indicator
    - actions: Create Order, View Contact details, More -> (Export Chat, Block)
  - MessageList (virtualized)
    - message item: from, content, media preview, timestamp, status icons, generated_by badge (Human/Template/AI)
    - message context menu: Edit (draft), Redact (SuperAdmin), Copy, Audit trail (open audit modal)
  - Composer
    - textarea with markdown-lite, attachments upload (server -> /api/uploads), placeholders preview
    - buttons: Template -> open TemplatePicker, AI Suggest -> trigger AI flow, Send (manual)
    - quick-send templates dropdown
  - RightPanel (context)
    - Orders (inline order lookup; create draft button -> POST /api/orders)
    - KB suggestions (GET /api/kb?q=extracted_terms)
    - Templates suggestions
    - AI Suggestion Panel (when invoked) — shows suggestion, confidence, model selector, edit area, Send as AI / Send as Manual, Reject, Retry
- API usage:
  - GET /api/conversations/:id (initial load)
  - POST /api/conversations/:id/message (send)
  - POST /api/ai/generate or POST /api/ai/generate/stream (for streaming)
  - POST /api/orders (order draft)
  - GET /api/kb
- Socket events:
  - message:new -> append
  - message:status -> update delivering/delivered/read
  - ai:stream:* -> streaming chunks if using stream
- AI flow (state machine):
  - Idle -> Requesting (POST /api/ai/generate -> 202 or 200) -> Streaming (ai:stream:chunk) -> Final (ai:stream:end)
  - Post-Final: show confidence bar (value), heuristic explanation, suggest "Admin takeover if confidence < threshold"
  - Admin can Edit -> Choose "Send as AI" (persist generated_by=ai; include ai_model & ai_confidence) OR "Send as Manual" (author_id = admin, generated_by=manual)
  - If ai_enabled false => Disable AI button and tooltip: "AI disabled for this contact"
  - Rate-limit errors => display modal with policy info returned from /api/ratelimit/status
- UX safeguards:
  - Low confidence (< ai_confidence_threshold): send disabled until admin confirms (extra confirmation modal)
  - If contact.opt_out=true -> AI button hidden and any /api/ai/generate returns 403
- Accessibility: labels for AI badges; aria-live region for streaming chunks

5) WhatsApp Sessions (CRITICAL)
- Screens: Session List + Connect QR stream page/modal
- Purpose: Manage local Baileys sessions: connect via QR, revoke, download session file
- Components:
  - SessionsList -> GET /api/whatsapp/sessions
    - Each item: session_name, connected (green/red), encrypted badge, created_at, last_connected_at
    - Actions: Connect (if disconnected), Disconnect, Download (superadmin), Revoke
  - ConnectModal (protected)
    - Starts POST /api/whatsapp/connect {session_name, encrypt}
    - Server returns {session_id, qr_stream_token}
    - Open socket for events: whatsapp:qr (qr_base64) and whatsapp:session:update
    - QR area shows base64 image + countdown; fallback: "Copy pairing code" if available
    - Buttons: Cancel (closes & POST /api/whatsapp/disconnect if started)
- Security:
  - QR stream only available to authenticated sockets; ephemeral token expiry; CSRF required on start
- Error states:
  - Camera/scan failure (timeout) -> show retry
  - Disk write error (can't save session) -> show admin guidance (check permissions /data)
- UX notes:
  - Present clear label: "Scan QR using WhatsApp mobile app (admin-only access)", show small audit log link for session events

6) Templates & KB Management
- Screens: Templates list + Editor; KB list + Editor
- Purpose: Manage reusable replies & KB for AI context
- Components:
  - CRUD tables -> GET/POST/PUT/DELETE /api/templates, /api/kb
  - TemplateEditor: body supports placeholders preview, live insert of contact placeholders
  - KB Editor: snippet + content, tags
- Usage in Conversation:
  - TemplatePicker returns template, opens in composer pre-filled; track generated_by=template when sent

7) Orders & Order Drafting
- Screens: Orders list, Order draft modal (from conversation)
- Purpose: Create minimal order draft from chat, export via webhook
- Components:
  - OrderDraftForm (prefill from conversation extraction)
    - fields: task_type, deadline, price, notes
    - Actions: Save Draft (POST /api/orders), Notify Customer (optional)
  - OrderList -> GET /api/orders
  - Order Webhook logs view
- UX:
  - Inline create from Conversation header; confirmation toast & attach to conversation

8) Audit, Backup & Settings
- Screens: Audit list & export, Backups page, Admin settings/policies
- Purpose: Auditing, backups, and policy configuration (rate-limits, AI defaults)
- Components:
  - AuditTable -> GET /api/audit (filters)
  - Export CSV button -> triggers server export
  - Backup controls -> POST /api/backup
  - Settings form -> POST /api/settings/policies
- Permissions: SuperAdmin only for settings, backup download, session download

9) Notifications & Global UX
- Toast system for success/error
- Persistent banners for rate-limit blocks, connection status, AI cost warnings
- Global search (contacts, orders, KB) -> GET /api/conversations?q=...
- Offline handling: queue outgoing messages locally (client-side) with retry if connection lost

Critical Components (for devs)
- SocketManager (auths with JWT, reconnects, exposes events)
- API client wrapper (handles CSRF header, auto-refresh tokens if implemented)
- Virtualized MessageList (windowed rendering)
- AIFlowManager (wraps /api/ai/generate and streaming handlers; applies confidence heuristics and UI state)
- RateLimitGuard (client-side UI fallback using /api/ratelimit/status but server is source of truth)
- SessionStore (local in-memory minimal for outgoing queue + optimistic UI)

Keyboard & Shortcuts (recommended)
- Ctrl/Cmd+K -> Global search
- Up arrow in empty composer -> edit last sent message (quick edit)
- Ctrl+Enter -> Send
- Alt+A -> Request AI suggestion
- Esc -> Close modals/panels

State & Data Flow Summary (important for implementers)
- Persistent store: Conversation list & current conversation loaded via REST; live updates via Socket.IO
- Sending messages -> POST /api/conversations/:id/message; optimistic UI appends "queued" message; server returns wa_id and message:update via socket
- AI suggestions -> POST /api/ai/generate (or stream) -> server persists ai_generation and returns suggestion with confidence -> UI marks suggestion with ai_generation.id
- All destructive actions (revoke session, send low-confidence AI-as-AI) produce audit_log entries via server

ASCII Wireframes (2–3 critical screens)

Conversation View (Primary, critical)
```
+---------------------------------------------------------------------------------------+
| [<] Inbox   |                                Conversation                              |
|             | Contact: Budi (62812345678)         [AI: ON] [Opt-out: OFF] [CreateOrder] |
|             | Last seen: 12:03   | Tag: priority  |  ...more                            |
+-------------+-------------------------------------------------------------------------+
| Inbox list  |                                                                         |
|  - Budi     | 12:01  Customer: "Saya mau joki tugas matematika, berapa harga?"         |
|  - Siti     |                                                                         |
|  - ...      | 12:05  Admin (You): "Halo Budi, harga mulai dari Rp50.000..." [edited]    |
|  (filters)  |                                                                         |
|             | 12:07  AI Suggestion (0.86) -- "Halo! Harga mulai dari Rp50.000..."     |
|             |        [Confidence: ██████░░░ 86%]  [Edit] [Send as AI] [Send as Manual] |
|             |                                                                         |
|             | -------------------- Composer ------------------------------- [Send]    |
|             | [ Type your message here...                              ] [AI] [Tpl]    |
|             | [Attach] [{{placeholder}}]                                  [Ctrl+Enter]    |
+-------------+-------------------------------------------------------------------------+
|             | Right Panel:                                                         |
|             |  - Orders: (DRAFT-001) [Open] [Convert->Order]                      |
|             |  - KB Snippets: "Pricing starts at Rp50k/task"  [Insert in AI prompt]|
|             |  - Templates: "Price Reply" [Insert] [Preview]                     |
+---------------------------------------------------------------------------------------+
Notes for devs:
- Message items show generated_by badge (Human/Template/AI) and ai_confidence when present.
- Composer AI button triggers POST /api/ai/generate (or stream) with conversation_id, kb_ids, order_snapshot_id.
- Send as AI -> POST /api/conversations/:id/message { type: "ai", text, meta: { ai_id, ai_confidence, ai_model } }
- Send as Manual -> POST same endpoint with type: "manual", author_id set server-side.
```

WhatsApp Sessions / Connect (QR Flow)
```
+---------------------------------------------------------------------------------------+
| Sessions                                                                            |
+---------------------------------------------------------------------------------------+
| [Create New Session]  [Download All Sessions (superadmin)]                          |
+---------------------------------------------------------------------------------------+
| Session: primary             [Connected ✓]      Encrypted: yes                     |
|  created: 2026-05-01         last: 2026-05-07 12:03   [Disconnect] [Download]       |
+---------------------------------------------------------------------------------------+
| Session: staging             [Disconnected ✖]   Encrypted: no                      |
|  created: 2026-04-11         last: 2026-04-11 09:22   [Connect] [Delete]           |
+---------------------------------------------------------------------------------------+
| Connect Session: primary (Modal)                                                   |
|  - Choose: session_name [primary]  Encrypt? [x]                                     |
|  - Start -> POST /api/whatsapp/connect {session_name, encrypt}                      |
|  - QR area (socket: whatsapp:qr)                                                    |
|                                                                              [X]   |
|  +--------------------------------------+   QR expires in: 00:59                  |
|  |  [BASE64 PNG RENDERED HERE - scan]  |                                          |
|  +--------------------------------------+                                          |
|  Tips: QR stream gated to logged-in admins. Session saved to /data/whatsapp-sessions|
|  [Cancel]                                         [I scanned it]                    |
+---------------------------------------------------------------------------------------+
Notes:
- On start, server returns qr_stream_token; socket listens to whatsapp:qr events filtered by token.
- If server writes session file fails -> show modal with admin instructions (check disk perms /data).
- Disconnect -> POST /api/whatsapp/disconnect { session_id } and emits session:update socket event.
```

Inbox List (compact)
```
+---------------------------------------------------------------------------------------+
| Inbox (filter: unread, ai_enabled)                                                   |
+---------------------------------------------------------------------------------------+
| Search: [_____________] [ai: ON v] [unread only]                                     |
+---------------------------------------------------------------------------------------+
| [★] Budi                 Rp50k? (Customer)        12:01   [1 unread] [AI ON]         |
|     "Saya mau joki tugas..."                                                           |
| ------------------------------------------------------------------------------------- |
| [ ] Siti                 Order DRAFT-101           11:40   [0 unread]                 |
|     "Sudah transfer..."                                                                |
| ------------------------------------------------------------------------------------- |
| [ ] + Load more (infinite scroll)                                                      |
+---------------------------------------------------------------------------------------+
Notes:
- Clicking an item -> navigate to Conversation View; optimistically mark read (server via POST read endpoint or via socket)
- Filters map to GET /api/conversations?q=...&ai_enabled=true&unread_only=true
```

Implementation Hints & Developer Checklist (practical)
- Socket.IO: authenticate via auth token on connect; handle reconnection backoff; dedupe message:new events using wa_id
- AI streaming: prefer Socket.IO streaming (ai:stream:*). Provide fallback non-streaming endpoint.
- Composer: autosave draft locally per conversation key and load on open.
- Rate-limits: show server-provided retry_after in UI; disable AI/Send buttons appropriately
- Audit: call server endpoints create audit logs; avoid exposing raw prompts in UI except to SuperAdmin (for compliance)
- Files: enforce file upload size limit and store in /data/uploads; use signed URLs for downloads
- Tests: include acceptance tests:
  - AI suggestion generation <5s for small models (mocked)
  - Per-contact AI toggle blocks AI call
  - QR connect only accessible after auth (attempt endpoint without auth -> 401)
- Security:
  - Always show clear labels on any AI-generated content
  - Require an additional confirmation (modal) to "Send as AI" if confidence < configured threshold

End.