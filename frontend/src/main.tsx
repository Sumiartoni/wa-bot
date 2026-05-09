import React from "react";
import ReactDOM from "react-dom/client";
import { io, type Socket } from "socket.io-client";
import * as QRCode from "qrcode/lib/browser";
import "./styles.css";

type User = { id: number; email: string; name: string; role: string };
type AdminUser = User & { createdAt: string; lastActiveAt?: string | null };
type AuthState = { token: string; csrfToken: string; user: User };
type Contact = { id: number; waId: string; name: string; phone: string; tags?: string; aiEnabled: boolean; optOut: boolean; createdAt: string };
type Message = { id: number; conversationId: number; from: string; content: string; generatedBy: string; messageType?: string; mediaPath?: string | null; mediaMimeType?: string | null; mediaFileName?: string | null; mediaSizeBytes?: number | null; createdAt: string; waId?: string | null; aiModel?: string | null; aiConfidence?: number | null; status?: string; attempts?: number; queuedAt?: string | null; nextAttemptAt?: string | null; lastAttemptAt?: string | null; failureReason?: string | null; deliveredAt?: string | null };
type Conversation = { id: number; contactId: number; contact: Contact; messages: Message[]; lastMessageAt: string; unreadCount: number; createdAt: string };
type Template = { id: number; name: string; body: string; tags: string; createdAt: string };
type KnowledgeEntry = { id: number; title: string; snippet: string; content: string; tags: string; createdAt: string };
type AutomationMacro = { id: number; name: string; keywords: string; body: string; enabled: boolean; tags: string; createdAt: string; updatedAt: string };
type Order = { id: number; contactId: number; contact?: Contact; orderRef: string; status: string; total?: number | null; attributes: string | Record<string, unknown>; createdAt: string; webhookDeliveries?: WebhookDelivery[] };
type AuditLog = { id: number; action: string; targetType: string; targetId?: number | null; meta: string; createdAt: string; actor?: Pick<User, "id" | "email" | "name"> | null };
type KeywordSuggestion = { type: "template" | "knowledge_base"; id: number; title: string; body: string; tags: string[]; score: number };
type Metrics = { messagesByType: Array<{ generatedBy: string; _count: number }>; aiCount: number; openOrders: number; throughput: { api: { requests: number; requestsPerMinute: number; averageResponseMs: number; p95ResponseMs: number; errorCount: number; byRoute: Array<{ route: string; requests: number; errors: number; averageResponseMs: number }> }; messagesLastHour: number; messagesLast24h: number; auditEventsLast24h: number }; backups: { latest?: BackupRun | null }; rateLimits: Record<string, unknown> };
type BackupRun = { id: number; filePath: string; sizeBytes: number; status: string; createdAt: string };
type BackupStatus = { database: { path: string | null; exists: boolean; sizeBytes: number; updatedAt: string | null }; whatsappSession: { path: string; exists: boolean; fileCount: number; sizeBytes: number; updatedAt: string | null }; backupDirectory: string; scheduler: { enabled: boolean; intervalMinutes: number; retentionDays: number }; latestBackups: BackupRun[] };
type BackupValidation = { validation: { ok: boolean; filePath: string; sizeBytes: number; readable?: boolean; sqlite?: boolean; message?: string } };
type BackupRestore = { restore: { restoredFrom?: string; restoredTo?: string; sizeBytes?: number; restoredAt?: string } };
type SessionInfo = { id: number; sessionName: string; connected: boolean; encryptionEnabled: boolean; revokedAt?: string | null; rotatedAt?: string | null; createdAt: string; lastConnectedAt?: string | null };
type AiGenerationResponse = { suggestion: string; confidence: number; model: string; generationId: number; requiresAdminReview: boolean; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }; rateLimit?: { remaining: number; resetAt: string; scope: string } };
type WebhookEndpoint = { id: number; name: string; url: string; enabled: boolean; maxAttempts: number; backoffSeconds: number; secret?: string | null };
type WebhookDelivery = { id: number; event: string; status: string; attempts: number; nextAttemptAt?: string | null; lastAttemptAt?: string | null; responseStatus?: number | null; responseBody?: string | null; error?: string | null; endpoint: WebhookEndpoint; order?: { id: number; orderRef: string; status: string } | null; createdAt: string };
type RuntimePolicies = { aiConfidenceThreshold: number; aiDefaultEnabled: boolean; defaultModel: string; backupIntervalMinutes: number; backupRetentionDays: number; messageQueueMaxAttempts: number; messageQueueRetrySeconds: number; auditRedactionKeys: string[]; rateLimits: Record<string, { limit: number; windowSeconds: number }> };
type SettingsResponse = { policies: RuntimePolicies; webhookConfigured: boolean; backupScheduler: { enabled: boolean; intervalMinutes: number; retentionDays: number } };
type AiGeneration = { id: number; conversationId: number; contactId: number; model: string; suggestion: string; confidence: number; status: string; promptTokens?: number | null; completionTokens?: number | null; totalTokens?: number | null; latencyMs?: number | null; rateLimitScope?: string | null; createdAt: string };
type AiModelsResponse = { models?: Array<{ id: string; name?: string }>; data?: Array<{ id: string; name?: string }>; source?: string };
type AuditIntegrity = { ok: boolean; checked: number; legacyCount?: number; failedAt?: number };
type OrderDraft = { orderRef: string; total: number | null; attributes: Record<string, unknown> };
type Toast = { type: "ok" | "error"; text: string };

const storageKey = "wa-admin-auth";
const pages = ["dashboard", "conversations", "whatsapp", "users", "templates", "kb", "automation", "orders", "audit", "operations"] as const;
type Page = (typeof pages)[number];

function readStoredAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as AuthState) : null;
  } catch {
    return null;
  }
}

function ApiError({ message }: { message?: string | null }) {
  if (!message) return null;
  return <div className="border border-danger/30 bg-red-50 px-3 py-2 text-sm text-danger">{message}</div>;
}

async function request<T>(path: string, auth?: AuthState | null, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (auth?.token) headers.set("Authorization", `Bearer ${auth.token}`);
  if (auth?.csrfToken && options.method && !["GET", "HEAD", "OPTIONS"].includes(options.method)) headers.set("X-CSRF-Token", auth.csrfToken);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: "include" });
  const data = await response.json().catch(() => ({})) as { success?: boolean; data?: T; error?: string | { message?: string } } | T;
  if (!response.ok) {
    const message = typeof (data as { error?: unknown }).error === "string"
      ? (data as { error: string }).error
      : typeof (data as { error?: { message?: string } }).error?.message === "string"
        ? (data as { error: { message: string } }).error.message
        : "Request failed";
    throw new Error(message);
  }
  if (typeof data === "object" && data && "success" in data) {
    return ((data as { data?: T }).data ?? ({} as T));
  }
  return data as T;
}

async function download(path: string, auth: AuthState) {
  const response = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${auth.token}` }, credentials: "include" });
  if (!response.ok) throw new Error("Download failed");
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="?([^";]+)"?/);
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = match?.[1] ?? "download";
  anchor.click();
  URL.revokeObjectURL(href);
}

function App() {
  const [auth, setAuth] = React.useState<AuthState | null>(() => readStoredAuth());
  const [page, setPage] = React.useState<Page>("dashboard");
  const [socketStatus, setSocketStatus] = React.useState("offline");
  const [events, setEvents] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (!auth) return undefined;
    let socket: Socket | null = io({ auth: { token: auth.token } });
    const track = (name: string) => setEvents((items) => [name, ...items].slice(0, 8));
    socket.on("connect", () => setSocketStatus("live"));
    socket.on("disconnect", () => setSocketStatus("offline"));
    ["message:new", "conversation:update", "session:update", "session:qr", "ai:generation:chunk", "ai:generation:complete", "webhook:delivery", "webhook:update", "message:status"].forEach((event) => socket?.on(event, () => track(event)));
    return () => {
      socket?.disconnect();
      socket = null;
    };
  }, [auth]);

  async function logout() {
    await request("/auth/logout", auth, { method: "POST", body: JSON.stringify({}) }).catch(() => undefined);
    localStorage.removeItem(storageKey);
    setAuth(null);
  }

  if (!auth) return <Login onLogin={setAuth} />;

  return (
    <div className="min-h-screen bg-slate-100 text-ink">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-line bg-slate-950 text-slate-100 lg:block">
        <div className="border-b border-slate-800 p-5">
          <div className="text-xs uppercase tracking-[0.25em] text-teal-300">WA Console</div>
          <div className="mt-2 font-semibold">JokiTugasKu Admin</div>
        </div>
        <nav className="space-y-1 p-3">{pages.map((item) => <button key={item} onClick={() => setPage(item)} className={`nav-item ${page === item ? "nav-active" : ""}`}>{label(item)}</button>)}</nav>
      </aside>
      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-line bg-white/95 px-4 py-3 backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><div className="text-xs uppercase tracking-[0.2em] text-slate-500">{label(page)}</div><h1 className="text-xl font-semibold">Private support operations</h1></div>
            <div className="flex flex-wrap items-center gap-2 text-sm"><span className={`status-pill ${socketStatus === "live" ? "bg-teal-50 text-teal-800" : "bg-slate-50 text-slate-600"}`}>socket {socketStatus}</span><span className="status-pill bg-white">{auth.user.email} · {auth.user.role}</span><button className="btn-secondary" onClick={logout}>Log out</button></div>
          </div>
          <div className="mt-3 flex gap-2 overflow-x-auto lg:hidden">{pages.map((item) => <button key={item} onClick={() => setPage(item)} className={`mobile-tab ${page === item ? "mobile-active" : ""}`}>{label(item)}</button>)}</div>
        </header>
        <main className="p-4">
          {page === "dashboard" && <Dashboard auth={auth} events={events} />}
          {page === "conversations" && <Conversations auth={auth} events={events} />}
          {page === "whatsapp" && <Whatsapp auth={auth} />}
          {page === "users" && <AdminUsers auth={auth} />}
          {page === "templates" && <Templates auth={auth} />}
          {page === "kb" && <KnowledgeBase auth={auth} />}
          {page === "automation" && <Automation auth={auth} />}
          {page === "orders" && <Orders auth={auth} />}
          {page === "audit" && <Audit auth={auth} />}
          {page === "operations" && <Operations auth={auth} />}
        </main>
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (auth: AuthState) => void }) {
  const [email, setEmail] = React.useState("admin@example.com");
  const [password, setPassword] = React.useState("ChangeMe123!");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const data = await request<AuthState>("/auth/login", null, { method: "POST", body: JSON.stringify({ email, password }) });
      localStorage.setItem(storageKey, JSON.stringify(data));
      onLogin(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }
  return <div className="grid min-h-screen place-items-center bg-slate-950 p-4 text-slate-100"><form onSubmit={submit} className="w-full max-w-sm border border-slate-800 bg-slate-900 p-6 shadow-2xl"><div className="text-xs uppercase tracking-[0.3em] text-teal-300">Admin only</div><h1 className="mt-2 text-2xl font-semibold">JokiTugasKu WhatsApp Console</h1><p className="mt-2 text-sm text-slate-400">Use the seeded admin credentials or the values configured in `.env`.</p><div className="mt-6 space-y-4"><label className="field-label">Email<input className="input-dark" value={email} onChange={(event) => setEmail(event.target.value)} type="email" /></label><label className="field-label">Password<input className="input-dark" value={password} onChange={(event) => setPassword(event.target.value)} type="password" /></label><ApiError message={error} /><button className="btn-primary w-full" disabled={loading}>{loading ? "Checking..." : "Log in"}</button></div></form></div>;
}

function Dashboard({ auth, events }: { auth: AuthState; events: string[] }) {
  const { data: status } = useApi<{ database: string; whatsapp: { status: string; error?: string }; counts: Record<string, number> }>(auth, "/status", events);
  const { data: metrics } = useApi<Metrics>(auth, "/metrics", events);
  const { data: settings } = useApi<SettingsResponse>(auth, "/settings/policies");
  const policies = settings?.policies;
  return <div className="grid gap-4 xl:grid-cols-3"><Panel title="System counts" className="xl:col-span-2"><MetricGrid values={status?.counts ?? {}} /></Panel><Panel title="Live status"><KeyValue rows={{ database: status?.database ?? "loading", whatsapp: status?.whatsapp.status ?? "loading", openOrders: metrics?.openOrders ?? "-", aiGenerations: metrics?.aiCount ?? "-", latestBackup: metrics?.backups.latest ? `${metrics.backups.latest.status} · ${formatBytes(metrics.backups.latest.sizeBytes)} · ${formatDate(metrics.backups.latest.createdAt)}` : "-", webhookConfigured: settings?.webhookConfigured ? "yes" : "no", defaultModel: policies?.defaultModel ?? "-", aiConfidenceThreshold: policies?.aiConfidenceThreshold ?? "-", queueRetry: policies ? `${policies.messageQueueMaxAttempts} attempts / ${policies.messageQueueRetrySeconds}s` : "-" }} /></Panel><Panel title="Throughput" className="xl:col-span-2"><MetricGrid values={{ messagesLastHour: metrics?.throughput.messagesLastHour ?? 0, messagesLast24h: metrics?.throughput.messagesLast24h ?? 0, auditEvents24h: metrics?.throughput.auditEventsLast24h ?? 0, apiRequests5m: metrics?.throughput.api.requests ?? 0, apiErrors5m: metrics?.throughput.api.errorCount ?? 0, apiP95ms: metrics?.throughput.api.p95ResponseMs ?? 0 }} /></Panel><Panel title="Recent realtime events"><MiniSection title="Socket feed" rows={events.length ? events : ["No realtime events yet"]} /></Panel></div>;
}

function Conversations({ auth, events }: { auth: AuthState; events: string[] }) {
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [filters, setFilters] = React.useState({ search: "", tag: "", orderId: "", orderRef: "", status: "" });
  const query = buildQuery(filters);
  const { data, reload } = useApi<{ conversations: Conversation[] }>(auth, `/conversations${query}`, events);
  const conversations = data?.conversations ?? [];
  React.useEffect(() => { if (!selectedId && conversations[0]) setSelectedId(conversations[0].id); }, [conversations, selectedId]);
  function setFilter(key: keyof typeof filters, value: string) { setFilters((current) => ({ ...current, [key]: value })); }
  return <div className="grid gap-4 xl:grid-cols-[390px_1fr]"><Panel title="Inbox filters"><div className="grid gap-2"><input className="input" placeholder="Search name, phone, message, order" value={filters.search} onChange={(event) => setFilter("search", event.target.value)} /><input className="input" placeholder="Contact tag" value={filters.tag} onChange={(event) => setFilter("tag", event.target.value)} /><input className="input" placeholder="Order ID" value={filters.orderId} onChange={(event) => setFilter("orderId", event.target.value)} /><input className="input" placeholder="Order reference" value={filters.orderRef} onChange={(event) => setFilter("orderRef", event.target.value)} /><select className="input" value={filters.status} onChange={(event) => setFilter("status", event.target.value)}><option value="">Any message queue status</option>{["queued", "retrying", "sending", "failed", "sent", "delivered"].map((status) => <option key={status} value={status}>{status}</option>)}</select><button className="btn-secondary" onClick={() => setFilters({ search: "", tag: "", orderId: "", orderRef: "", status: "" })}>Clear filters</button></div><div className="mt-4 space-y-2">{conversations.map((conversation) => <button key={conversation.id} onClick={() => setSelectedId(conversation.id)} className={`list-card w-full text-left ${selectedId === conversation.id ? "ring-2 ring-teal-600" : ""}`}><div className="flex justify-between gap-2"><strong>{conversation.contact.name}</strong><span className="text-xs text-slate-500">{formatDate(conversation.lastMessageAt)}</span></div><div className="mt-1 text-sm text-slate-600">{conversation.messages[0]?.content ?? "No messages"}</div><div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500"><span>{conversation.contact.phone}</span>{conversation.unreadCount > 0 && <span className="font-semibold text-warn">{conversation.unreadCount} unread</span>}{conversation.contact.tags && <span>{conversation.contact.tags}</span>}</div></button>)}</div></Panel>{selectedId ? <ConversationDetail auth={auth} id={selectedId} onChanged={reload} events={events} /> : <Panel title="Conversation">No conversation selected.</Panel>}</div>;
}

function ConversationDetail({ auth, id, onChanged, events }: { auth: AuthState; id: number; onChanged: () => void; events: string[] }) {
  const { data, error, reload } = useApi<{ conversation: Conversation; orders: Order[]; knowledgeBase: KnowledgeEntry[]; suggestions: KeywordSuggestion[] }>(auth, `/conversations/${id}`, events);
  const { data: queueData, reload: reloadQueue } = useApi<{ messages: Message[] }>(auth, `/conversations/${id}/messages/queue`, events);
  const { data: templatesData } = useApi<{ templates: Template[] }>(auth, "/templates");
  const { data: macrosData } = useApi<{ macros: AutomationMacro[] }>(auth, "/automations/macros");
  const [draft, setDraft] = React.useState("");
  const [sendType, setSendType] = React.useState<"manual" | "template" | "ai" | "automation">("manual");
  const [media, setMedia] = React.useState({ mediaPath: "", mediaMimeType: "", mediaFileName: "" });
  const [busy, setBusy] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState("");
  const [aiMeta, setAiMeta] = React.useState<AiGenerationResponse | null>(null);
  const [streamStatus, setStreamStatus] = React.useState<string | null>(null);
  const [orderDraft, setOrderDraft] = React.useState<OrderDraft | null>(null);
  const [notice, setNotice] = React.useState<Toast | null>(null);
  const conversation = data?.conversation;

  async function submit() {
    if (!draft.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await request(`/conversations/${id}/message`, auth, { method: "POST", body: JSON.stringify({ text: draft, type: sendType, mediaPath: media.mediaPath || undefined, mediaMimeType: media.mediaMimeType || undefined, mediaFileName: media.mediaFileName || undefined, meta: sendType === "template" ? { source: "operator_template" } : undefined }) });
      setDraft("");
      setMedia({ mediaPath: "", mediaMimeType: "", mediaFileName: "" });
      reload();
      reloadQueue();
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function generateAi(stream = false) {
    setBusy(true);
    setSuggestion("");
    setAiMeta(null);
    setStreamStatus(stream ? "connecting" : null);
    try {
      if (!stream) {
        const result = await request<AiGenerationResponse>("/ai/generate", auth, { method: "POST", body: JSON.stringify({ conversationId: id }) });
        setSuggestion(result.suggestion);
        setDraft(result.suggestion);
        setSendType("ai");
        setAiMeta(result);
        return;
      }
      const response = await fetch("/api/ai/generate/stream", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}`, "X-CSRF-Token": auth.csrfToken }, credentials: "include", body: JSON.stringify({ conversationId: id }) });
      if (!response.ok || !response.body) throw new Error("Streaming failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let accumulated = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
            if (!line.startsWith("data:")) continue;
            const payload = JSON.parse(line.slice(5).trim()) as Partial<AiGenerationResponse> & { chunk?: string; error?: string };
            if (currentEvent === "chunk" && payload.chunk) {
              accumulated += payload.chunk;
              setSuggestion(accumulated);
              setDraft(accumulated);
              setSendType("ai");
              setStreamStatus("streaming");
            }
            if (currentEvent === "complete") {
              setAiMeta(payload as AiGenerationResponse);
              if (typeof payload.suggestion === "string") {
                setSuggestion(payload.suggestion);
                setDraft(payload.suggestion);
              }
              setSendType("ai");
              setStreamStatus("complete");
            }
            if (currentEvent === "error") throw new Error(payload.error ?? "Streaming failed");
          }
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function useTemplate(templateId: string) {
    const template = templatesData?.templates.find((item) => String(item.id) === templateId);
    if (template) {
      setDraft(personalizeTemplate(template.body, conversation?.contact.name ?? ""));
      setSendType("template");
    }
  }
  function useSuggestion(item: KeywordSuggestion) { setDraft(item.body); setSendType(item.type === "template" ? "template" : "manual"); }
  async function replay(messageId: number) { await request(`/messages/${messageId}/replay`, auth, { method: "POST", body: JSON.stringify({}) }); reload(); reloadQueue(); onChanged(); }
  async function runMacro(id: number) { await request(`/automations/macros/${id}/run`, auth, { method: "POST", body: JSON.stringify({ conversationId: conversation?.id }) }); reload(); reloadQueue(); onChanged(); setNotice({ type: "ok", text: "Automation macro queued" }); }
  async function extractOrder(create: boolean) { const result = await request<{ draft: OrderDraft; order?: Order }>(`/conversations/${id}/order-draft`, auth, { method: "POST", body: JSON.stringify({ create }) }); setOrderDraft(result.draft); if (result.order) { setNotice({ type: "ok", text: `Draft order ${result.order.orderRef} created` }); reload(); } }
  if (!conversation) return <Panel title="Conversation"><ApiError message={error} />Loading...</Panel>;
  return <Panel title={`${conversation.contact.name} · ${conversation.contact.phone}`}><ApiError message={error} />{notice && <div className={`mb-3 border px-3 py-2 text-sm ${notice.type === "ok" ? "border-teal-200 bg-teal-50 text-teal-800" : "border-red-200 bg-red-50 text-red-800"}`}>{notice.text}</div>}<div className="grid gap-4 xl:grid-cols-[1fr_340px]"><div><div className="mb-3 flex flex-wrap gap-2"><ContactToggle auth={auth} contact={conversation.contact} onChanged={reload} /></div><div className="max-h-[520px] space-y-3 overflow-y-auto border border-line bg-slate-50 p-3">{conversation.messages.map((message) => <div key={message.id} className={`message ${message.from === "admin" ? "message-admin" : "message-contact"}`}><div className="mb-1 flex flex-wrap justify-between gap-2 text-xs uppercase text-slate-500"><span>{message.from} · {message.generatedBy}</span><span>{formatDate(message.createdAt)}</span></div><div className="whitespace-pre-wrap text-sm">{message.content}</div>{message.messageType === "media" && <div className="mt-2 border border-line bg-white p-2 text-xs text-slate-600">media: {message.mediaFileName || message.mediaPath || "attached"} · {message.mediaMimeType || "type unknown"} · {formatBytes(message.mediaSizeBytes)}</div>}<div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500"><span>status {message.status ?? "stored"}</span>{message.attempts ? <span>{message.attempts} attempts</span> : null}{message.failureReason && <span className="text-danger">{message.failureReason}</span>}</div></div>)}</div><div className="mt-3 grid gap-2"><textarea className="input min-h-28" placeholder="Manual reply, template, AI suggestion, or automation body" value={draft} onChange={(event) => setDraft(event.target.value)} /><div className="grid gap-2 md:grid-cols-3"><input className="input" placeholder="Media path under configured media dir" value={media.mediaPath} onChange={(event) => setMedia((current) => ({ ...current, mediaPath: event.target.value }))} /><input className="input" placeholder="Media MIME type" value={media.mediaMimeType} onChange={(event) => setMedia((current) => ({ ...current, mediaMimeType: event.target.value }))} /><input className="input" placeholder="Media filename" value={media.mediaFileName} onChange={(event) => setMedia((current) => ({ ...current, mediaFileName: event.target.value }))} /></div><div className="flex flex-wrap gap-2"><select className="input max-w-44" value={sendType} onChange={(event) => setSendType(event.target.value as typeof sendType)}><option value="manual">manual</option><option value="template">template</option><option value="ai">ai</option><option value="automation">automation</option></select><select className="input max-w-64" onChange={(event) => useTemplate(event.target.value)} value=""><option value="">Use template...</option>{templatesData?.templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select><button className="btn-primary" disabled={busy || !draft.trim()} onClick={submit}>Queue reply</button><button className="btn-secondary" disabled={busy} onClick={() => generateAi(false)}>AI suggest</button><button className="btn-secondary" disabled={busy} onClick={() => generateAi(true)}>Stream AI</button></div>{aiMeta && <div className="border border-line bg-panel p-2 text-xs text-slate-600">AI {aiMeta.model} · confidence {aiMeta.confidence} · review {aiMeta.requiresAdminReview ? "required" : "not required"} · remaining {aiMeta.rateLimit?.remaining ?? "-"}</div>}{streamStatus && <div className="text-xs text-slate-500">stream {streamStatus}</div>}{suggestion && <div className="border border-line bg-slate-50 p-2 text-xs text-slate-600">Latest suggestion: {suggestion.slice(0, 240)}</div>}</div></div><div className="space-y-4"><MiniSection title="Orders" rows={(data?.orders ?? []).map((order) => `${order.orderRef} · ${order.status} · ${formatMoney(order.total)} · ${stringifyAttributes(order.attributes)}`)} /><div><div className="mb-2 flex flex-wrap gap-2"><button className="btn-secondary" onClick={() => extractOrder(false)}>Extract draft</button><button className="btn-secondary" onClick={() => extractOrder(true)}>Create draft order</button></div>{orderDraft && <div className="border border-line bg-panel p-2 text-xs text-slate-600">{orderDraft.orderRef} · {formatMoney(orderDraft.total)} · {JSON.stringify(orderDraft.attributes)}</div>}</div><SuggestionList suggestions={data?.suggestions ?? []} onUse={useSuggestion} /><div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Automation macros</div><div className="space-y-2">{(macrosData?.macros ?? []).map((macro) => <div key={macro.id} className="border border-line bg-slate-50 p-2 text-xs"><div className="flex justify-between gap-2"><strong>{macro.name}</strong><button className="link" onClick={() => runMacro(macro.id)} disabled={!macro.enabled}>run</button></div><div className="text-slate-500">{macro.keywords} · {macro.enabled ? "enabled" : "disabled"}</div></div>)}</div></div><div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Queue / replay</div><div className="space-y-2">{(queueData?.messages ?? []).length ? queueData!.messages.map((message) => <div key={message.id} className="border border-line bg-slate-50 p-2 text-xs"><div className="flex justify-between gap-2"><strong>#{message.id} · {message.status}</strong><button className="link" onClick={() => replay(message.id)}>replay</button></div><div>{message.content.slice(0, 120)}</div><div className="text-slate-500">attempts {message.attempts ?? 0} · next {formatDate(message.nextAttemptAt)} · {message.failureReason ?? "no failure"}</div></div>) : <div className="text-sm text-slate-500">No queued, retrying, sending, or failed messages.</div>}</div></div><MiniSection title="Knowledge" rows={(data?.knowledgeBase ?? []).map((item) => `${item.title}: ${item.snippet}`)} /></div></div></Panel>;
}

function ContactToggle({ auth, contact, onChanged }: { auth: AuthState; contact: Contact; onChanged: () => void }) {
  async function patch(data: Partial<Contact>) { await request(`/contacts/${contact.id}`, auth, { method: "PATCH", body: JSON.stringify(data) }); onChanged(); }
  return <><button className="btn-secondary" onClick={() => patch({ aiEnabled: !contact.aiEnabled })}>AI {contact.aiEnabled ? "on" : "off"}</button><button className="btn-secondary" onClick={() => patch({ optOut: !contact.optOut })}>Opt-out {contact.optOut ? "yes" : "no"}</button></>;
}

function Whatsapp({ auth }: { auth: AuthState }) {
  const { data, reload } = useApi<{ sessions: SessionInfo[]; runtime: { status: string } }>(auth, "/admin/sessions");
  const { data: qr, reload: reloadQr } = useApi<{ status: string; qr: string | null }>(auth, "/whatsapp/qr");
  async function action(path: string, method = "POST") { await request(path, auth, { method, body: method === "DELETE" ? undefined : JSON.stringify({}) }); reload(); reloadQr(); }
  return <div className="grid gap-4 xl:grid-cols-2"><Panel title="Runtime"><KeyValue rows={{ runtime: data?.runtime.status ?? "loading", qrStatus: qr?.status ?? "loading", qrAvailable: qr?.qr ? "yes" : "no" }} /><div className="mt-3 flex flex-wrap gap-2"><button className="btn-primary" onClick={() => action("/whatsapp/connect")}>Connect</button><button className="btn-secondary" onClick={() => action("/whatsapp/disconnect")}>Disconnect</button><button className="btn-secondary" onClick={() => action("/whatsapp/session/rotate")}>Rotate session</button><button className="btn-danger" onClick={() => action("/whatsapp/session/revoke")}>Revoke session</button><button className="btn-danger" onClick={() => action("/whatsapp/session-files", "DELETE")}>Remove local files</button></div>{qr?.qr && <div className="mt-4"><QrCode value={qr.qr} /></div>}</Panel><Panel title="Local sessions"><DataTable headers={["Name", "Connected", "Encrypted", "Rotated", "Last connected", "Actions"]} rows={(data?.sessions ?? []).map((session) => [session.sessionName, session.connected ? "yes" : "no", session.encryptionEnabled ? "yes" : "no", formatDate(session.rotatedAt), formatDate(session.lastConnectedAt), <button className="link" onClick={() => download(`/admin/sessions/${session.id}/download`, auth)}>download archive</button>])} /></Panel></div>;
}

function Templates({ auth }: { auth: AuthState }) { return <CrudPanel auth={auth} title="Templates" path="/templates" listKey="templates" empty={{ name: "", body: "", tags: "" }} fields={["name", "tags", "body"]} />; }
function KnowledgeBase({ auth }: { auth: AuthState }) { return <CrudPanel auth={auth} title="Knowledge Base" path="/kb" listKey="entries" empty={{ title: "", snippet: "", content: "", tags: "" }} fields={["title", "tags", "snippet", "content"]} />; }

function CrudPanel<T extends { id?: number; [key: string]: unknown }>({ auth, title, path, listKey, empty, fields }: { auth: AuthState; title: string; path: string; listKey: string; empty: T; fields: string[] }) {
  const { data, reload } = useApi<Record<string, T[]>>(auth, path);
  const [form, setForm] = React.useState<T>(empty);
  async function save() { const id = form.id; await request(id ? `${path}/${id}` : path, auth, { method: id ? "PUT" : "POST", body: JSON.stringify(form) }); setForm(empty); reload(); }
  async function remove(id: number) { await request(`${path}/${id}`, auth, { method: "DELETE" }); reload(); }
  const rows = data?.[listKey] ?? [];
  return <Panel title={title}><div className="mb-4 grid gap-2 md:grid-cols-2">{fields.map((field) => <label key={field} className="label normal-case tracking-normal text-slate-600">{field}{field === "body" || field === "content" || field === "snippet" ? <textarea className="input mt-1 min-h-24" value={String(form[field] ?? "")} onChange={(event) => setForm({ ...form, [field]: event.target.value })} /> : <input className="input mt-1" value={String(form[field] ?? "")} onChange={(event) => setForm({ ...form, [field]: event.target.value })} />}</label>)}<div className="flex items-end gap-2"><button className="btn-primary" onClick={save}>Save</button><button className="btn-secondary" onClick={() => setForm(empty)}>New</button></div></div><DataTable headers={[...fields, "Actions"]} rows={rows.map((item) => [...fields.map((field) => String(item[field] ?? "").slice(0, 180)), <div className="flex gap-2"><button className="link" onClick={() => setForm(item)}>edit</button>{item.id && <button className="link-danger" onClick={() => remove(item.id!)}>delete</button>}</div>])} /></Panel>;
}

function Automation({ auth }: { auth: AuthState }) {
  const { data, reload } = useApi<{ macros: AutomationMacro[] }>(auth, "/automations/macros");
  const [form, setForm] = React.useState<Partial<AutomationMacro>>({ name: "", keywords: "", body: "", tags: "", enabled: true });
  async function save() { const id = form.id; await request(id ? `/automations/macros/${id}` : "/automations/macros", auth, { method: id ? "PUT" : "POST", body: JSON.stringify({ name: form.name, keywords: form.keywords, body: form.body, tags: form.tags ?? "", enabled: Boolean(form.enabled) }) }); setForm({ name: "", keywords: "", body: "", tags: "", enabled: true }); reload(); }
  async function remove(id: number) { await request(`/automations/macros/${id}`, auth, { method: "DELETE" }); reload(); }
  return <Panel title="Automation macros"><div className="mb-4 grid gap-2 md:grid-cols-2"><input className="input" placeholder="Name" value={form.name ?? ""} onChange={(event) => setForm({ ...form, name: event.target.value })} /><input className="input" placeholder="Comma keywords" value={form.keywords ?? ""} onChange={(event) => setForm({ ...form, keywords: event.target.value })} /><input className="input" placeholder="Tags" value={form.tags ?? ""} onChange={(event) => setForm({ ...form, tags: event.target.value })} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(form.enabled)} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Enabled</label><textarea className="input min-h-28 md:col-span-2" placeholder="Automation response body, supports {{name}}" value={form.body ?? ""} onChange={(event) => setForm({ ...form, body: event.target.value })} /><div className="flex gap-2"><button className="btn-primary" onClick={save}>Save macro</button><button className="btn-secondary" onClick={() => setForm({ name: "", keywords: "", body: "", tags: "", enabled: true })}>New</button></div></div><DataTable headers={["Name", "Keywords", "Enabled", "Tags", "Updated", "Actions"]} rows={(data?.macros ?? []).map((macro) => [macro.name, macro.keywords, macro.enabled ? "yes" : "no", macro.tags, formatDate(macro.updatedAt), <div className="flex gap-2"><button className="link" onClick={() => setForm(macro)}>edit</button><button className="link-danger" onClick={() => remove(macro.id)}>delete</button></div>])} /></Panel>;
}

function Orders({ auth }: { auth: AuthState }) {
  const [filters, setFilters] = React.useState({ search: "", status: "", contactId: "" });
  const query = buildQuery(filters);
  const { data, reload } = useApi<{ orders: Order[] }>(auth, `/orders${query}`);
  const [form, setForm] = React.useState({ contactId: "", orderRef: "", status: "draft", total: "", attributes: "{}" });
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const { data: detail, reload: reloadDetail } = useApi<{ order: Order }>(auth, selectedId ? `/orders/${selectedId}` : "/orders?status=__none__", [selectedId]);
  async function create() { await request("/orders", auth, { method: "POST", body: JSON.stringify({ contactId: Number(form.contactId), orderRef: form.orderRef || undefined, status: form.status, total: form.total ? Number(form.total) : undefined, attributes: JSON.parse(form.attributes || "{}") }) }); reload(); }
  async function update(order: Order) { await request(`/orders/${order.id}`, auth, { method: "PATCH", body: JSON.stringify({ status: order.status, total: order.total ?? null, attributes: parseAttributes(order.attributes) }) }); reload(); reloadDetail(); }
  async function webhook(orderId: number) { await request(`/orders/${orderId}/integrations/webhook`, auth, { method: "POST", body: JSON.stringify({ event: "order.sync" }) }); reloadDetail(); }
  return <div className="grid gap-4 xl:grid-cols-[1fr_420px]"><Panel title="Orders"><div className="mb-3 grid gap-2 md:grid-cols-4"><input className="input" placeholder="Search orders/contact" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /><input className="input" placeholder="Status" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })} /><input className="input" placeholder="Contact ID" value={filters.contactId} onChange={(event) => setFilters({ ...filters, contactId: event.target.value })} /><button className="btn-secondary" onClick={() => download(`/orders/export.csv${filters.status ? `?status=${encodeURIComponent(filters.status)}` : ""}`, auth)}>Export CSV</button></div><DataTable headers={["Ref", "Contact", "Status", "Total", "Attributes", "Actions"]} rows={(data?.orders ?? []).map((order) => [order.orderRef, order.contact ? `${order.contact.name} · ${order.contact.phone}` : order.contactId, <InlineText value={order.status} onSave={(value) => { order.status = value; update(order); }} />, <InlineText value={String(order.total ?? "")} onSave={(value) => { order.total = value ? Number(value) : null; update(order); }} />, stringifyAttributes(order.attributes).slice(0, 220), <div className="flex gap-2"><button className="link" onClick={() => setSelectedId(order.id)}>detail</button><button className="link" onClick={() => webhook(order.id)}>webhook</button></div>])} /></Panel><div className="space-y-4"><Panel title="Create order"><div className="grid gap-2"><input className="input" placeholder="Contact ID" value={form.contactId} onChange={(event) => setForm({ ...form, contactId: event.target.value })} /><input className="input" placeholder="Order ref (optional)" value={form.orderRef} onChange={(event) => setForm({ ...form, orderRef: event.target.value })} /><input className="input" placeholder="Status" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })} /><input className="input" placeholder="Total in IDR" value={form.total} onChange={(event) => setForm({ ...form, total: event.target.value })} /><textarea className="input min-h-28 font-mono" value={form.attributes} onChange={(event) => setForm({ ...form, attributes: event.target.value })} /><button className="btn-primary" onClick={create}>Create</button></div></Panel><Panel title="Order detail">{detail?.order && selectedId ? <div className="space-y-3"><KeyValue rows={{ ref: detail.order.orderRef, id: detail.order.id, status: detail.order.status, total: formatMoney(detail.order.total), contact: detail.order.contact ? `${detail.order.contact.name} · ${detail.order.contact.phone}` : "-", attributes: <pre className="whitespace-pre-wrap text-xs">{prettyAttributes(detail.order.attributes)}</pre> }} /><DataTable headers={["Event", "Status", "Attempts", "Endpoint", "Last", "Error"]} rows={(detail.order.webhookDeliveries ?? []).map((delivery) => [delivery.event, delivery.status, delivery.attempts, delivery.endpoint?.name ?? "-", formatDate(delivery.lastAttemptAt), delivery.error ?? delivery.responseBody ?? "-"])} /></div> : <div className="text-sm text-slate-500">Select an order for webhook delivery history and full attributes.</div>}</Panel></div></div>;
}

function Audit({ auth }: { auth: AuthState }) {
  const { data, error } = useApi<{ logs: AuditLog[] }>(auth, "/audit?limit=100");
  return <Panel title="Audit log"><ApiError message={error} /><div className="mb-3 flex justify-end"><button className="btn-secondary" onClick={() => download("/audit/export.csv?limit=1000", auth)}>Export CSV</button></div><DataTable headers={["Time", "Action", "Actor", "Target", "Meta"]} rows={(data?.logs ?? []).map((log) => [formatDate(log.createdAt), log.action, log.actor?.email ?? "system", `${log.targetType} ${log.targetId ?? ""}`, <code className="text-xs">{String(log.meta).slice(0, 260)}</code>])} /></Panel>;
}

function AdminUsers({ auth }: { auth: AuthState }) {
  const { data, reload } = useApi<{ users: AdminUser[] }>(auth, "/admin/users");
  const [form, setForm] = React.useState({ id: "", email: "", password: "", name: "", role: "agent" });
  async function save() { const id = form.id; const body: Record<string, string> = { email: form.email, name: form.name, role: form.role }; if (form.password) body.password = form.password; await request(id ? `/admin/users/${id}` : "/admin/users", auth, { method: id ? "PATCH" : "POST", body: JSON.stringify(body) }); setForm({ id: "", email: "", password: "", name: "", role: "agent" }); reload(); }
  return <Panel title="Admin users"><div className="mb-4 grid gap-2 md:grid-cols-5"><input className="input" placeholder="Email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /><input className="input" placeholder="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /><input className="input" placeholder="Password" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /><select className="input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}><option value="agent">agent</option><option value="superadmin">superadmin</option></select><button className="btn-primary" onClick={save}>Save</button></div><DataTable headers={["Email", "Name", "Role", "Created", "Last active", "Actions"]} rows={(data?.users ?? []).map((user) => [user.email, user.name, user.role, formatDate(user.createdAt), formatDate(user.lastActiveAt), <button className="link" onClick={() => setForm({ id: String(user.id), email: user.email, password: "", name: user.name, role: user.role })}>edit</button>])} /></Panel>;
}

function Operations({ auth }: { auth: AuthState }) {
  const { data: backups, reload } = useApi<{ backups: BackupRun[] }>(auth, "/backups");
  const { data: backupStatus, reload: reloadBackupStatus } = useApi<{ status: BackupStatus }>(auth, "/backups/status");
  const { data: settingsData, reload: reloadSettings } = useApi<SettingsResponse>(auth, "/settings/policies");
  const { data: webhookSettings, reload: reloadWebhookSettings } = useApi<{ endpoints: WebhookEndpoint[] }>(auth, "/admin/webhooks/settings");
  const { data: webhookDeliveries, reload: reloadWebhookDeliveries } = useApi<{ deliveries: WebhookDelivery[] }>(auth, "/admin/webhooks/deliveries?limit=50");
  const { data: health } = useApi<{ ok: boolean; service: string; time: string }>(auth, "/health");
  const { data: auditCheck, reload: reloadAuditCheck } = useApi<{ integrity: AuditIntegrity }>(auth, "/audit/verify");
  const { data: aiGenerations } = useApi<{ generations: AiGeneration[] }>(auth, "/ai/generations?limit=25");
  const { data: aiModels, error: aiModelsError } = useApi<AiModelsResponse>(auth, "/ai/models");
  const [backupValidation, setBackupValidation] = React.useState<string | null>(null);
  const [restoreResult, setRestoreResult] = React.useState<string | null>(null);
  const [webhookTest, setWebhookTest] = React.useState<string | null>(null);
  async function backup() { await request("/backups", auth, { method: "POST" }); reload(); reloadBackupStatus(); }
  async function validateBackup(id: number) { const result = await request<BackupValidation>(`/backups/${id}/validate`, auth, { method: "POST", body: JSON.stringify({}) }); setBackupValidation(`${result.validation.ok ? "valid" : "invalid"} · ${formatBytes(result.validation.sizeBytes)} · ${result.validation.filePath}`); reload(); reloadBackupStatus(); }
  async function restoreBackup(id: number) { const confirm = window.prompt("Type RESTORE to replace the current SQLite database with this backup."); if (confirm !== "RESTORE") return; const result = await request<BackupRestore>(`/backups/${id}/restore`, auth, { method: "POST", body: JSON.stringify({ confirm }) }); setRestoreResult(JSON.stringify(result.restore)); reloadBackupStatus(); }
  async function retryDelivery(id: number) { await request(`/admin/webhooks/deliveries/${id}/retry`, auth, { method: "POST", body: JSON.stringify({}) }); reloadWebhookDeliveries(); }
  async function testEndpoint(id: number) { const result = await request<{ result: { ok: boolean; status: number; body: string } }>(`/admin/webhooks/settings/${id}/test`, auth, { method: "POST", body: JSON.stringify({}) }); setWebhookTest(`${result.result.ok ? "ok" : "failed"} · HTTP ${result.result.status} · ${result.result.body || "empty body"}`); }
  const settings = settingsData?.policies;
  const scheduler = settingsData?.backupScheduler ?? backupStatus?.status.scheduler;
  const modelRows = (aiModels?.models ?? aiModels?.data ?? []).slice(0, 10);
  return <div className="grid gap-4 xl:grid-cols-2"><Panel title="Backups"><div className="mb-3 flex flex-wrap gap-2"><button className="btn-primary" onClick={backup}>Trigger backup</button></div><KeyValue rows={{ database: backupStatus?.status.database.exists ? `${formatBytes(backupStatus.status.database.sizeBytes)} · ${formatDate(backupStatus.status.database.updatedAt)}` : "missing", whatsappSession: backupStatus?.status.whatsappSession.exists ? `${backupStatus.status.whatsappSession.fileCount} files · ${formatBytes(backupStatus.status.whatsappSession.sizeBytes)}` : "missing", backupDirectory: backupStatus?.status.backupDirectory ?? "-", scheduler: scheduler ? `${scheduler.enabled ? "enabled" : "disabled"} · ${scheduler.intervalMinutes}m · ${scheduler.retentionDays}d` : "-", validation: backupValidation ?? "not run", restore: restoreResult ?? "not run" }} /><DataTable headers={["ID", "Status", "Size", "Created", "File", "Actions"]} rows={(backups?.backups ?? []).map((item) => [item.id, item.status, formatBytes(item.sizeBytes), formatDate(item.createdAt), item.filePath, <div className="flex gap-2"><button className="link" onClick={() => validateBackup(item.id)}>validate</button><button className="link-danger" onClick={() => restoreBackup(item.id)}>restore</button></div>])} /></Panel><Panel title="Settings and policies"><PolicySettings auth={auth} settings={settingsData ?? null} onSaved={reloadSettings} /></Panel><Panel title="Health and audit"><KeyValue rows={{ health: health?.ok ? `${health.service} · ${formatDate(health.time)}` : "loading", auditChain: auditCheck?.integrity.ok ? `ok · ${auditCheck.integrity.checked} checked` : auditCheck?.integrity ? `failed at ${auditCheck.integrity.failedAt}` : "loading", legacyAuditRows: auditCheck?.integrity.legacyCount ?? 0 }} /><div className="mt-3 flex gap-2"><button className="btn-secondary" onClick={reloadAuditCheck}>Verify audit chain</button></div></Panel><Panel title="Webhook operations"><WebhookSettings auth={auth} endpoints={webhookSettings?.endpoints ?? []} onSaved={reloadWebhookSettings} onTest={testEndpoint} /><div className="mt-2 text-sm text-slate-600">{webhookTest}</div><DataTable headers={["Event", "Status", "Attempts", "Order", "Endpoint", "Next", "Actions"]} rows={(webhookDeliveries?.deliveries ?? []).map((delivery) => [delivery.event, delivery.status, delivery.attempts, delivery.order?.orderRef ?? "-", delivery.endpoint.name, formatDate(delivery.nextAttemptAt), <button className="link" onClick={() => retryDelivery(delivery.id)}>retry</button>])} /></Panel><Panel title="AI operations"><ApiError message={aiModelsError} /><MiniSection title="Available models" rows={modelRows.map((model) => `${model.id}${model.name ? ` · ${model.name}` : ""}`)} /><DataTable headers={["Time", "Conversation", "Model", "Confidence", "Status", "Latency"]} rows={(aiGenerations?.generations ?? []).map((generation) => [formatDate(generation.createdAt), generation.conversationId, generation.model, generation.confidence, generation.status, generation.latencyMs ?? "-"])} /></Panel></div>;
}

function PolicySettings({ auth, settings, onSaved }: { auth: AuthState; settings: SettingsResponse | null; onSaved: () => void }) {
  const policies = settings?.policies;
  const [form, setForm] = React.useState<RuntimePolicies | null>(policies ?? null);
  React.useEffect(() => { if (policies) setForm(policies); }, [policies]);
  if (!form) return <div className="text-sm text-slate-500">Loading policy settings...</div>;
  async function save() { await request("/settings/policies", auth, { method: "PUT", body: JSON.stringify(form) }); onSaved(); }
  function setRate(scope: string, key: "limit" | "windowSeconds", value: number) { setForm((current) => current ? { ...current, rateLimits: { ...current.rateLimits, [scope]: { ...current.rateLimits[scope], [key]: value } } } : current); }
  return <div className="space-y-3"><div className="grid gap-2 md:grid-cols-2"><label className="label normal-case tracking-normal text-slate-600">Default model<input className="input mt-1" value={form.defaultModel} onChange={(event) => setForm({ ...form, defaultModel: event.target.value })} /></label><label className="label normal-case tracking-normal text-slate-600">AI confidence threshold<input className="input mt-1" type="number" step="0.01" min="0" max="1" value={form.aiConfidenceThreshold} onChange={(event) => setForm({ ...form, aiConfidenceThreshold: Number(event.target.value) })} /></label><label className="label normal-case tracking-normal text-slate-600">Backup interval minutes<input className="input mt-1" type="number" value={form.backupIntervalMinutes} onChange={(event) => setForm({ ...form, backupIntervalMinutes: Number(event.target.value) })} /></label><label className="label normal-case tracking-normal text-slate-600">Backup retention days<input className="input mt-1" type="number" value={form.backupRetentionDays} onChange={(event) => setForm({ ...form, backupRetentionDays: Number(event.target.value) })} /></label><label className="label normal-case tracking-normal text-slate-600">Queue max attempts<input className="input mt-1" type="number" value={form.messageQueueMaxAttempts} onChange={(event) => setForm({ ...form, messageQueueMaxAttempts: Number(event.target.value) })} /></label><label className="label normal-case tracking-normal text-slate-600">Queue retry seconds<input className="input mt-1" type="number" value={form.messageQueueRetrySeconds} onChange={(event) => setForm({ ...form, messageQueueRetrySeconds: Number(event.target.value) })} /></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.aiDefaultEnabled} onChange={(event) => setForm({ ...form, aiDefaultEnabled: event.target.checked })} />AI default enabled for new contacts</label><label className="label normal-case tracking-normal text-slate-600">Audit redaction keys<input className="input mt-1" value={form.auditRedactionKeys.join(",")} onChange={(event) => setForm({ ...form, auditRedactionKeys: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label></div><DataTable headers={["Scope", "Limit", "Window seconds"]} rows={Object.entries(form.rateLimits).map(([scope, value]) => [scope, <input className="input max-w-32" type="number" value={value.limit} onChange={(event) => setRate(scope, "limit", Number(event.target.value))} />, <input className="input max-w-32" type="number" value={value.windowSeconds} onChange={(event) => setRate(scope, "windowSeconds", Number(event.target.value))} />])} /><button className="btn-primary" onClick={save}>Save runtime policies</button></div>;
}

function WebhookSettings({ auth, endpoints, onSaved, onTest }: { auth: AuthState; endpoints: WebhookEndpoint[]; onSaved: () => void; onTest: (id: number) => void }) {
  const [form, setForm] = React.useState({ name: "order_default", url: "", secret: "", enabled: true, maxAttempts: 5, backoffSeconds: 30 });
  React.useEffect(() => { if (endpoints[0]) setForm({ name: endpoints[0].name, url: endpoints[0].url, secret: endpoints[0].secret ?? "", enabled: endpoints[0].enabled, maxAttempts: endpoints[0].maxAttempts, backoffSeconds: endpoints[0].backoffSeconds }); }, [endpoints]);
  async function save() { await request("/admin/webhooks/settings", auth, { method: "PUT", body: JSON.stringify({ ...form, secret: form.secret || null }) }); onSaved(); }
  return <div className="mb-4 grid gap-2"><input className="input" placeholder="Webhook name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /><input className="input" placeholder="Webhook URL" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} /><input className="input" placeholder="Secret" value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} /><div className="grid grid-cols-2 gap-2"><input className="input" type="number" value={form.maxAttempts} onChange={(event) => setForm({ ...form, maxAttempts: Number(event.target.value) })} /><input className="input" type="number" value={form.backoffSeconds} onChange={(event) => setForm({ ...form, backoffSeconds: Number(event.target.value) })} /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />Enabled</label><div className="flex gap-2"><button className="btn-primary" onClick={save}>Save webhook</button>{endpoints.map((endpoint) => <button key={endpoint.id} className="btn-secondary" onClick={() => onTest(endpoint.id)}>Test {endpoint.name}</button>)}</div></div>;
}

function useApi<T>(auth: AuthState, path: string, deps: React.DependencyList = []) {
  const [data, setData] = React.useState<T | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [tick, setTick] = React.useState(0);
  const reload = React.useCallback(() => setTick((value) => value + 1), []);
  React.useEffect(() => {
    let active = true;
    request<T>(path, auth).then((result) => { if (active) { setData(result); setError(null); } }).catch((err) => { if (active) setError(err instanceof Error ? err.message : "Request failed"); });
    return () => { active = false; };
  }, [auth, path, tick, ...deps]);
  return { data, error, reload };
}

function InlineText({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return <div className="flex min-w-32 gap-1"><input className="input py-1" value={draft} onChange={(event) => setDraft(event.target.value)} /><button className="link" onClick={() => onSave(draft)}>save</button></div>;
}

function QrCode({ value }: { value: string }) {
  const [src, setSrc] = React.useState("");
  React.useEffect(() => { (QRCode as unknown as { toDataURL: (value: string) => Promise<string> }).toDataURL(value).then(setSrc).catch(() => setSrc("")); }, [value]);
  return src ? <img className="border border-line bg-white p-2" src={src} alt="WhatsApp login QR" /> : <div className="text-sm text-slate-500">QR unavailable</div>;
}

function SuggestionList({ suggestions, onUse }: { suggestions: KeywordSuggestion[]; onUse: (suggestion: KeywordSuggestion) => void }) {
  return <div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Keyword suggestions</div><div className="space-y-2">{suggestions.length ? suggestions.map((item) => <button key={`${item.type}-${item.id}`} className="list-card w-full text-left" onClick={() => onUse(item)}><div className="flex justify-between gap-2"><strong className="text-sm">{item.title}</strong><span className="text-xs uppercase text-slate-500">{item.type.replace("_", " ")} · {item.score}</span></div><p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-slate-600">{item.body}</p><div className="mt-2 text-xs text-slate-500">{item.tags.join(", ") || "no tags"}</div></button>) : <div className="border border-line bg-slate-50 p-3 text-sm text-slate-500">No deterministic keyword matches.</div>}</div></div>;
}

function Panel({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) { return <section className={`border border-line bg-white p-4 shadow-sm ${className}`}><h2 className="mb-3 border-b border-line pb-2 text-sm font-semibold uppercase tracking-[0.16em] text-slate-600">{title}</h2>{children}</section>; }
function MetricGrid({ values }: { values: Record<string, number> }) { return <div className="grid grid-cols-2 gap-3 md:grid-cols-3">{Object.entries(values).map(([key, value]) => <div key={key} className="border border-line bg-panel p-3"><div className="text-xs uppercase text-slate-500">{key}</div><div className="mt-1 text-2xl font-semibold">{value}</div></div>)}</div>; }
function KeyValue({ rows }: { rows: Record<string, React.ReactNode> }) { return <dl className="divide-y divide-line border border-line">{Object.entries(rows).map(([key, value]) => <div key={key} className="grid grid-cols-2 gap-3 px-3 py-2 text-sm"><dt className="text-slate-500">{key}</dt><dd className="font-medium break-words">{value}</dd></div>)}</dl>; }
function DataTable({ headers, rows }: { headers: string[]; rows: Array<Array<React.ReactNode>> }) { return <div className="overflow-auto border border-line"><table className="min-w-full text-left text-sm"><thead className="bg-slate-100 text-xs uppercase text-slate-500"><tr>{headers.map((header) => <th key={header} className="px-3 py-2 font-semibold">{header}</th>)}</tr></thead><tbody className="divide-y divide-line bg-white">{rows.length ? rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className="max-w-md px-3 py-2 align-top">{cell}</td>)}</tr>) : <tr><td className="px-3 py-4 text-slate-500" colSpan={headers.length}>No records.</td></tr>}</tbody></table></div>; }
function MiniSection({ title, rows }: { title: string; rows: string[] }) { return <div><div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div><div className="space-y-2">{rows.length ? rows.map((row, index) => <div key={index} className="border border-line bg-slate-50 p-2 text-xs text-slate-700">{row}</div>) : <div className="text-sm text-slate-500">None</div>}</div></div>; }
function label(page: Page) { return page === "kb" ? "Knowledge Base" : page === "users" ? "Users" : page[0].toUpperCase() + page.slice(1); }
function formatDate(value?: string | null) { return value ? new Date(value).toLocaleString() : "-"; }
function formatMoney(value?: number | null) { return typeof value === "number" ? new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 }).format(value) : "-"; }
function formatBytes(value?: number | null) { return typeof value === "number" ? `${new Intl.NumberFormat("id-ID").format(value)} bytes` : "-"; }
function stringifyAttributes(value: Order["attributes"]) { return typeof value === "string" ? value : JSON.stringify(value); }
function prettyAttributes(value: Order["attributes"]) { try { return JSON.stringify(parseAttributes(value), null, 2); } catch { return stringifyAttributes(value); } }
function parseAttributes(value: Order["attributes"]) { return typeof value === "string" ? JSON.parse(value || "{}") as Record<string, unknown> : value; }
function personalizeTemplate(body: string, contactName: string) { return body.replace(/{{\s*name\s*}}/g, contactName); }
function buildQuery(values: Record<string, string>) { const params = new URLSearchParams(); Object.entries(values).forEach(([key, value]) => { if (value.trim()) params.set(key, value.trim()); }); const query = params.toString(); return query ? `?${query}` : ""; }

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
