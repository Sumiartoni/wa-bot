require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const EventEmitter = require('events');
const { authMiddleware, verifyCredentials, generateToken } = require('./auth');
const db = require('./database');
const bot = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

// Event emitter for real-time updates
const eventEmitter = new EventEmitter();
bot.setEventEmitter(eventEmitter);

// Middleware
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ========================
// Auth Routes
// ========================

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username dan password wajib diisi' });
  }

  if (verifyCredentials(username, password)) {
    const token = generateToken(username);
    return res.json({ 
      success: true, 
      token, 
      user: { username, role: 'admin' } 
    });
  }

  return res.status(401).json({ error: 'Username atau password salah' });
});

app.get('/api/auth/verify', authMiddleware, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ========================
// WhatsApp Bot Routes
// ========================

app.get('/api/bot/status', authMiddleware, (req, res) => {
  res.json(bot.getStatus());
});

app.post('/api/bot/start', authMiddleware, async (req, res) => {
  try {
    const status = bot.getStatus();
    if (status.status === 'connected') {
      return res.json({ message: 'Bot sudah terhubung' });
    }
    await bot.startBot();
    res.json({ message: 'Bot sedang dimulai...' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bot/logout', authMiddleware, async (req, res) => {
  try {
    await bot.logout();
    res.json({ message: 'Berhasil logout dari WhatsApp' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// Chat Routes
// ========================

app.get('/api/chats', authMiddleware, (req, res) => {
  const users = db.getUsers();
  res.json(users);
});

app.get('/api/chats/search', authMiddleware, (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  const users = db.searchUsers(q);
  res.json(users);
});

app.get('/api/chats/:jid/messages', authMiddleware, (req, res) => {
  const { jid } = req.params;
  const { limit = 50, offset = 0 } = req.query;
  const messages = db.getMessages(jid, parseInt(limit), parseInt(offset));
  res.json(messages);
});

app.post('/api/chats/:jid/send', authMiddleware, async (req, res) => {
  const { jid } = req.params;
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Pesan tidak boleh kosong' });
  }

  try {
    await bot.sendMessage(jid, message);
    res.json({ success: true, message: 'Pesan terkirim' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========================
// User Routes
// ========================

app.get('/api/users', authMiddleware, (req, res) => {
  const users = db.getUsers();
  res.json(users);
});

app.get('/api/users/:jid', authMiddleware, (req, res) => {
  const user = db.getUser(req.params.jid);
  if (!user) {
    return res.status(404).json({ error: 'User tidak ditemukan' });
  }
  res.json(user);
});

app.put('/api/users/:jid/ai', authMiddleware, (req, res) => {
  const { jid } = req.params;
  const { enabled } = req.body;
  db.toggleUserAI(jid, enabled);
  res.json({ success: true, ai_enabled: enabled });
});

// ========================
// Settings Routes
// ========================

app.get('/api/settings', authMiddleware, (req, res) => {
  res.json(db.getAllSettings());
});

app.put('/api/settings', authMiddleware, (req, res) => {
  const settings = req.body;
  for (const [key, value] of Object.entries(settings)) {
    db.setSetting(key, value);
  }
  res.json({ success: true, settings: db.getAllSettings() });
});

// ========================
// Stats/Dashboard Routes
// ========================

app.get('/api/stats', authMiddleware, (req, res) => {
  const stats = db.getStats();
  res.json(stats);
});

app.get('/api/stats/messages', authMiddleware, (req, res) => {
  const { days = 7 } = req.query;
  const stats = db.getMessageStats(parseInt(days));
  res.json(stats);
});

// ========================
// SSE (Server-Sent Events) for real-time updates
// ========================

app.get('/api/events', authMiddleware, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send current status immediately
  sendEvent('status', bot.getStatus());

  // Listen for events
  const onMessage = (data) => sendEvent('message', data);
  const onStatus = (data) => sendEvent('status', data);
  const onQR = (data) => sendEvent('qr', { qrCode: data });

  eventEmitter.on('message', onMessage);
  eventEmitter.on('status', onStatus);
  eventEmitter.on('qr', onQR);

  // Cleanup on disconnect
  req.on('close', () => {
    eventEmitter.off('message', onMessage);
    eventEmitter.off('status', onStatus);
    eventEmitter.off('qr', onQR);
  });
});

// ========================
// Catch-all: serve frontend
// ========================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ========================
// Start Server
// ========================

app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════╗
  ║     🤖 WA AI Bot Dashboard Server        ║
  ║                                           ║
  ║  Dashboard: http://localhost:${PORT}          ║
  ║  API:       http://localhost:${PORT}/api      ║
  ║                                           ║
  ║  Login:     ${process.env.ADMIN_USERNAME || 'admin'} / ${(process.env.ADMIN_PASSWORD || 'admin123').replace(/./g, '*')}       ║
  ╚═══════════════════════════════════════════╝
  `);

  // Auto-start bot
  console.log('[SERVER] Starting WhatsApp bot...');
  bot.startBot().catch(err => {
    console.error('[SERVER] Failed to start bot:', err.message);
  });
});
