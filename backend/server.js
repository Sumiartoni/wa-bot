require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const EventEmitter = require('events');
const { authMiddleware, adminOnly, verifyCredentials, generateToken } = require('./auth');
const db = require('./database');
const bot = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;
const eventEmitter = new EventEmitter();
bot.setEventEmitter(eventEmitter);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Create uploads directory and serve it
const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, 'qris' + path.extname(file.originalname))
  })
});

// ======================== AUTH ========================
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  const agent = verifyCredentials(username, password);
  if (!agent) return res.status(401).json({ error: 'Username atau password salah' });
  db.updateAgentStatus(agent.id, 'online');
  const token = generateToken(agent);
  res.json({ success: true, token, user: { id: agent.id, username: agent.username, name: agent.name, role: agent.role, avatar_color: agent.avatar_color } });
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, user: req.user });
});

app.post('/api/auth/logout', authMiddleware, (req, res) => {
  db.updateAgentStatus(req.user.id, 'offline');
  res.json({ success: true });
});

// ======================== BOT ========================
app.get('/api/bot/status', authMiddleware, (req, res) => res.json(bot.getStatus()));

app.post('/api/bot/start', authMiddleware, async (req, res) => {
  try {
    const st = bot.getStatus();
    if (st.status === 'connected') return res.json({ message: 'Bot sudah terhubung' });
    await bot.startBot();
    res.json({ message: 'Bot sedang dimulai...' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot/logout', authMiddleware, adminOnly, async (req, res) => {
  try { await bot.logout(); res.json({ message: 'Berhasil logout dari WhatsApp' }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ======================== CHATS ========================
app.get('/api/chats', authMiddleware, (req, res) => {
  const { status, agentId, priority, unassigned } = req.query;
  res.json(db.getUsers({ status, agentId: agentId ? parseInt(agentId) : null, priority, unassigned: unassigned === 'true' }));
});

app.get('/api/chats/search', authMiddleware, (req, res) => {
  const { q } = req.query;
  res.json(q ? db.searchUsers(q) : []);
});

app.get('/api/chats/:jid', authMiddleware, (req, res) => {
  const user = db.getUser(req.params.jid);
  if (!user) return res.status(404).json({ error: 'Chat tidak ditemukan' });
  const labels = db.getChatLabels(req.params.jid);
  res.json({ ...user, labels });
});

app.get('/api/chats/:jid/messages', authMiddleware, (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  res.json(db.getMessages(req.params.jid, parseInt(limit), parseInt(offset)));
});

app.post('/api/chats/:jid/send', authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
  try {
    await bot.sendMessage(req.params.jid, message);
    // Re-save with agent_id (bot.sendMessage already saves without agent)
    // Update: modify the last saved message to include agent_id
    db.saveMessage(req.params.jid, 'outgoing', message, 'text', false, req.user.id);
    res.json({ success: true, message: 'Pesan terkirim' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/chats/:jid/status', authMiddleware, (req, res) => {
  db.updateChatStatus(req.params.jid, req.body.status);
  res.json({ success: true });
});

app.put('/api/chats/:jid/assign', authMiddleware, (req, res) => {
  db.assignChat(req.params.jid, req.body.agentId);
  res.json({ success: true });
});

app.put('/api/chats/:jid/priority', authMiddleware, (req, res) => {
  db.setChatPriority(req.params.jid, req.body.priority);
  res.json({ success: true });
});

app.put('/api/chats/:jid/ai', authMiddleware, (req, res) => {
  db.toggleUserAI(req.params.jid, req.body.enabled);
  res.json({ success: true });
});

// ======================== LABELS ========================
app.get('/api/labels', authMiddleware, (req, res) => res.json(db.getLabels()));

app.post('/api/labels', authMiddleware, (req, res) => {
  const { name, color } = req.body;
  db.createLabel(name, color);
  res.json({ success: true, labels: db.getLabels() });
});

// ======================== PRODUCTS ========================
app.get('/api/products', authMiddleware, (req, res) => res.json(db.getProducts()));

app.post('/api/products', authMiddleware, (req, res) => {
  const { name, price, description } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nama dan harga produk wajib diisi' });
  db.createProduct(name, price, description);
  res.json({ success: true });
});

app.put('/api/products/:id', authMiddleware, (req, res) => {
  const { name, price, description } = req.body;
  if (!name || !price) return res.status(400).json({ error: 'Nama dan harga produk wajib diisi' });
  db.updateProduct(parseInt(req.params.id), name, price, description);
  res.json({ success: true });
});

app.delete('/api/products/:id', authMiddleware, (req, res) => {
  db.deleteProduct(parseInt(req.params.id));
  res.json({ success: true });
});

// ======================== UPLOAD ========================
app.post('/api/upload-qris', authMiddleware, upload.single('qris_image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file yang diunggah' });
  const relativeUrl = '/uploads/' + req.file.filename;
  res.json({ success: true, url: relativeUrl });
});

app.delete('/api/labels/:id', authMiddleware, adminOnly, (req, res) => {
  db.deleteLabel(parseInt(req.params.id));
  res.json({ success: true });
});

app.get('/api/chats/:jid/labels', authMiddleware, (req, res) => res.json(db.getChatLabels(req.params.jid)));

app.post('/api/chats/:jid/labels', authMiddleware, (req, res) => {
  db.addChatLabel(req.params.jid, req.body.labelId);
  res.json({ success: true });
});

app.delete('/api/chats/:jid/labels/:labelId', authMiddleware, (req, res) => {
  db.removeChatLabel(req.params.jid, parseInt(req.params.labelId));
  res.json({ success: true });
});

// ======================== NOTES ========================
app.get('/api/chats/:jid/notes', authMiddleware, (req, res) => res.json(db.getChatNotes(req.params.jid)));

app.post('/api/chats/:jid/notes', authMiddleware, (req, res) => {
  db.addChatNote(req.params.jid, req.user.id, req.body.content);
  res.json({ success: true, notes: db.getChatNotes(req.params.jid) });
});

app.delete('/api/notes/:id', authMiddleware, (req, res) => {
  db.deleteChatNote(parseInt(req.params.id));
  res.json({ success: true });
});

// ======================== QUICK REPLIES ========================
app.get('/api/quick-replies', authMiddleware, (req, res) => res.json(db.getQuickReplies()));

app.post('/api/quick-replies', authMiddleware, (req, res) => {
  const { shortcut, title, content } = req.body;
  db.createQuickReply(shortcut, title, content, req.user.id);
  res.json({ success: true, data: db.getQuickReplies() });
});

app.put('/api/quick-replies/:id', authMiddleware, (req, res) => {
  const { shortcut, title, content } = req.body;
  db.updateQuickReply(parseInt(req.params.id), shortcut, title, content);
  res.json({ success: true });
});

app.delete('/api/quick-replies/:id', authMiddleware, (req, res) => {
  db.deleteQuickReply(parseInt(req.params.id));
  res.json({ success: true });
});

// ======================== AGENTS ========================
app.get('/api/agents', authMiddleware, (req, res) => res.json(db.getAgents()));

app.post('/api/agents', authMiddleware, adminOnly, (req, res) => {
  const { username, password, name, role, avatar_color } = req.body;
  try {
    db.createAgent(username, password, name, role || 'agent', avatar_color || '#6366f1');
    res.json({ success: true, agents: db.getAgents() });
  } catch (e) { res.status(400).json({ error: 'Username sudah dipakai' }); }
});

app.delete('/api/agents/:id', authMiddleware, adminOnly, (req, res) => {
  db.deleteAgent(parseInt(req.params.id));
  res.json({ success: true, agents: db.getAgents() });
});

// ======================== SETTINGS ========================
app.get('/api/settings', authMiddleware, (req, res) => res.json(db.getAllSettings()));

app.put('/api/settings', authMiddleware, adminOnly, (req, res) => {
  for (const [key, value] of Object.entries(req.body)) db.setSetting(key, value);
  res.json({ success: true, settings: db.getAllSettings() });
});

// ======================== STATS ========================
app.get('/api/stats', authMiddleware, (req, res) => res.json(db.getStats()));
app.get('/api/stats/messages', authMiddleware, (req, res) => res.json(db.getMessageStats(parseInt(req.query.days || 7))));
app.get('/api/stats/agents', authMiddleware, (req, res) => res.json(db.getAgentStats()));

// ======================== SSE ========================
app.get('/api/events', authMiddleware, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = (evt, data) => res.write(`event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`);
  send('status', bot.getStatus());
  const onMsg = (d) => send('message', d);
  const onSt = (d) => send('status', d);
  const onQR = (d) => send('qr', { qrCode: d });
  eventEmitter.on('message', onMsg);
  eventEmitter.on('status', onSt);
  eventEmitter.on('qr', onQR);
  req.on('close', () => { eventEmitter.off('message', onMsg); eventEmitter.off('status', onSt); eventEmitter.off('qr', onQR); });
});

// ======================== FRONTEND ========================
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

// ======================== START ========================
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║   🎧 WA CS Bot - Customer Service        ║
  ║   Dashboard: http://localhost:${PORT}          ║
  ╚═══════════════════════════════════════════╝`);
  bot.startBot().catch(e => console.error('[SERVER] Bot error:', e.message));
});
