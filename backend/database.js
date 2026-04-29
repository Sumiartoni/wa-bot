const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'wa-bot.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ========================
// Schema
// ========================
db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'agent' CHECK(role IN ('admin','agent')),
    avatar_color TEXT DEFAULT '#6366f1',
    status TEXT DEFAULT 'offline' CHECK(status IN ('online','offline','away')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    ai_enabled INTEGER DEFAULT 1,
    chat_status TEXT DEFAULT 'open' CHECK(chat_status IN ('open','in_progress','resolved')),
    assigned_agent_id INTEGER,
    priority TEXT DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_messages INTEGER DEFAULT 0,
    FOREIGN KEY (assigned_agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    is_ai_response INTEGER DEFAULT 0,
    agent_id INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_jid) REFERENCES users(jid),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shortcut TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS labels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#6366f1'
  );

  CREATE TABLE IF NOT EXISTS chat_labels (
    user_jid TEXT NOT NULL,
    label_id INTEGER NOT NULL,
    PRIMARY KEY (user_jid, label_id),
    FOREIGN KEY (user_jid) REFERENCES users(jid),
    FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS chat_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL,
    agent_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_jid) REFERENCES users(jid),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user_jid ON messages(user_jid);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen DESC);
  CREATE INDEX IF NOT EXISTS idx_users_status ON users(chat_status);
  CREATE INDEX IF NOT EXISTS idx_users_agent ON users(assigned_agent_id);
`);

// ========================
// Helpers
// ========================
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'wa-bot-salt').digest('hex');
}

// ========================
// Init defaults
// ========================
const initSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
initSetting.run('global_ai_enabled', 'true');
initSetting.run('ai_model', process.env.AI_MODEL || 'llama-3.3-70b-versatile');
initSetting.run('ai_system_prompt', process.env.AI_SYSTEM_PROMPT || 'Kamu adalah asisten AI yang ramah dan membantu.');
initSetting.run('ai_provider', 'groq');

// Create default admin if not exists
const adminExists = db.prepare('SELECT id FROM agents WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');
if (!adminExists) {
  db.prepare('INSERT INTO agents (username, password_hash, name, role, avatar_color) VALUES (?, ?, ?, ?, ?)').run(
    process.env.ADMIN_USERNAME || 'admin',
    hashPassword(process.env.ADMIN_PASSWORD || 'admin123'),
    'Administrator',
    'admin',
    '#6366f1'
  );
}

// Default quick replies
const qrExists = db.prepare('SELECT id FROM quick_replies LIMIT 1').get();
if (!qrExists) {
  const insertQR = db.prepare('INSERT OR IGNORE INTO quick_replies (shortcut, title, content) VALUES (?, ?, ?)');
  insertQR.run('/salam', 'Salam Pembuka', 'Halo! Terima kasih sudah menghubungi kami. Ada yang bisa kami bantu? 😊');
  insertQR.run('/tunggu', 'Mohon Tunggu', 'Mohon tunggu sebentar ya, kami sedang mengecek data Anda. 🙏');
  insertQR.run('/terima', 'Terima Kasih', 'Terima kasih sudah menghubungi kami! Jika ada pertanyaan lain, jangan ragu untuk menghubungi kembali. 🙏');
  insertQR.run('/selesai', 'Chat Selesai', 'Baik, jika sudah tidak ada pertanyaan lagi, kami akan menutup sesi chat ini. Terima kasih! ✅');
}

// Default labels
const lblExists = db.prepare('SELECT id FROM labels LIMIT 1').get();
if (!lblExists) {
  const insertLbl = db.prepare('INSERT OR IGNORE INTO labels (name, color) VALUES (?, ?)');
  insertLbl.run('Complaint', '#ef4444');
  insertLbl.run('Order', '#f59e0b');
  insertLbl.run('Info', '#3b82f6');
  insertLbl.run('VIP', '#a855f7');
  insertLbl.run('Follow Up', '#10b981');
}

// ========================
// Agent Operations
// ========================
function createAgent(username, password, name, role = 'agent', avatarColor = '#6366f1') {
  return db.prepare('INSERT INTO agents (username, password_hash, name, role, avatar_color) VALUES (?, ?, ?, ?, ?)').run(username, hashPassword(password), name, role, avatarColor);
}

function getAgentByCredentials(username, password) {
  return db.prepare('SELECT * FROM agents WHERE username = ? AND password_hash = ?').get(username, hashPassword(password));
}

function getAgentById(id) {
  return db.prepare('SELECT id, username, name, role, avatar_color, status, created_at FROM agents WHERE id = ?').get(id);
}

function getAgents() {
  return db.prepare('SELECT id, username, name, role, avatar_color, status, created_at FROM agents ORDER BY name').all();
}

function updateAgentStatus(id, status) {
  db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
}

function deleteAgent(id) {
  db.prepare('UPDATE users SET assigned_agent_id = NULL WHERE assigned_agent_id = ?').run(id);
  db.prepare('DELETE FROM agents WHERE id = ? AND role != ?').run(id, 'admin');
}

// ========================
// User / Chat Operations
// ========================
function upsertUser(jid, name = '') {
  const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
  db.prepare(`
    INSERT INTO users (jid, name, phone, last_seen, total_messages)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(jid) DO UPDATE SET
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
      last_seen = CURRENT_TIMESTAMP,
      total_messages = users.total_messages + 1
  `).run(jid, name, phone);
}

function getUsers(filters = {}) {
  let where = '1=1';
  const params = [];

  if (filters.status) { where += ' AND u.chat_status = ?'; params.push(filters.status); }
  if (filters.agentId) { where += ' AND u.assigned_agent_id = ?'; params.push(filters.agentId); }
  if (filters.priority) { where += ' AND u.priority = ?'; params.push(filters.priority); }
  if (filters.unassigned) { where += ' AND u.assigned_agent_id IS NULL'; }

  return db.prepare(`
    SELECT u.*,
      a.name as agent_name,
      (SELECT content FROM messages WHERE user_jid = u.jid ORDER BY timestamp DESC LIMIT 1) as last_message,
      (SELECT timestamp FROM messages WHERE user_jid = u.jid ORDER BY timestamp DESC LIMIT 1) as last_message_time,
      (SELECT COUNT(*) FROM messages WHERE user_jid = u.jid AND direction = 'incoming') as incoming_count,
      (SELECT COUNT(*) FROM messages WHERE user_jid = u.jid AND direction = 'outgoing') as outgoing_count,
      (SELECT COUNT(*) FROM messages WHERE user_jid = u.jid AND direction = 'incoming' AND timestamp > COALESCE((SELECT MAX(timestamp) FROM messages WHERE user_jid = u.jid AND direction = 'outgoing'), '1970-01-01')) as unread_count
    FROM users u
    LEFT JOIN agents a ON u.assigned_agent_id = a.id
    WHERE ${where}
    ORDER BY u.last_seen DESC
  `).all(...params);
}

function getUser(jid) {
  return db.prepare(`
    SELECT u.*, a.name as agent_name
    FROM users u LEFT JOIN agents a ON u.assigned_agent_id = a.id
    WHERE u.jid = ?
  `).get(jid);
}

function updateChatStatus(jid, status) {
  db.prepare('UPDATE users SET chat_status = ? WHERE jid = ?').run(status, jid);
}

function assignChat(jid, agentId) {
  db.prepare('UPDATE users SET assigned_agent_id = ?, chat_status = ? WHERE jid = ?').run(agentId, 'in_progress', jid);
}

function setChatPriority(jid, priority) {
  db.prepare('UPDATE users SET priority = ? WHERE jid = ?').run(priority, jid);
}

function toggleUserAI(jid, enabled) {
  db.prepare('UPDATE users SET ai_enabled = ? WHERE jid = ?').run(enabled ? 1 : 0, jid);
}

function searchUsers(query) {
  return db.prepare(`
    SELECT u.*, a.name as agent_name,
      (SELECT content FROM messages WHERE user_jid = u.jid ORDER BY timestamp DESC LIMIT 1) as last_message
    FROM users u LEFT JOIN agents a ON u.assigned_agent_id = a.id
    WHERE u.name LIKE ? OR u.phone LIKE ? OR u.jid LIKE ?
    ORDER BY u.last_seen DESC
  `).all(`%${query}%`, `%${query}%`, `%${query}%`);
}

// ========================
// Message Operations
// ========================
function saveMessage(userJid, direction, content, messageType = 'text', isAiResponse = false, agentId = null) {
  return db.prepare('INSERT INTO messages (user_jid, direction, content, message_type, is_ai_response, agent_id) VALUES (?, ?, ?, ?, ?, ?)').run(userJid, direction, content, messageType, isAiResponse ? 1 : 0, agentId);
}

function getMessages(userJid, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT m.*, a.name as agent_name FROM messages m
    LEFT JOIN agents a ON m.agent_id = a.id
    WHERE m.user_jid = ? ORDER BY m.timestamp DESC LIMIT ? OFFSET ?
  `).all(userJid, limit, offset);
}

function getRecentMessages(userJid, limit = 10) {
  return db.prepare('SELECT * FROM messages WHERE user_jid = ? ORDER BY timestamp DESC LIMIT ?').all(userJid, limit).reverse();
}

// ========================
// Quick Replies
// ========================
function getQuickReplies() {
  return db.prepare('SELECT qr.*, a.name as author FROM quick_replies qr LEFT JOIN agents a ON qr.created_by = a.id ORDER BY qr.shortcut').all();
}

function createQuickReply(shortcut, title, content, createdBy = null) {
  return db.prepare('INSERT INTO quick_replies (shortcut, title, content, created_by) VALUES (?, ?, ?, ?)').run(shortcut, title, content, createdBy);
}

function updateQuickReply(id, shortcut, title, content) {
  return db.prepare('UPDATE quick_replies SET shortcut=?, title=?, content=? WHERE id=?').run(shortcut, title, content, id);
}

function deleteQuickReply(id) {
  return db.prepare('DELETE FROM quick_replies WHERE id = ?').run(id);
}

// ========================
// Labels
// ========================
function getLabels() {
  return db.prepare('SELECT * FROM labels ORDER BY name').all();
}

function createLabel(name, color) {
  return db.prepare('INSERT INTO labels (name, color) VALUES (?, ?)').run(name, color);
}

function deleteLabel(id) {
  db.prepare('DELETE FROM chat_labels WHERE label_id = ?').run(id);
  return db.prepare('DELETE FROM labels WHERE id = ?').run(id);
}

function getChatLabels(jid) {
  return db.prepare('SELECT l.* FROM labels l JOIN chat_labels cl ON l.id = cl.label_id WHERE cl.user_jid = ?').all(jid);
}

function addChatLabel(jid, labelId) {
  return db.prepare('INSERT OR IGNORE INTO chat_labels (user_jid, label_id) VALUES (?, ?)').run(jid, labelId);
}

function removeChatLabel(jid, labelId) {
  return db.prepare('DELETE FROM chat_labels WHERE user_jid = ? AND label_id = ?').run(jid, labelId);
}

// ========================
// Notes
// ========================
function getChatNotes(jid) {
  return db.prepare('SELECT n.*, a.name as agent_name FROM chat_notes n LEFT JOIN agents a ON n.agent_id = a.id WHERE n.user_jid = ? ORDER BY n.created_at DESC').all(jid);
}

function addChatNote(jid, agentId, content) {
  return db.prepare('INSERT INTO chat_notes (user_jid, agent_id, content) VALUES (?, ?, ?)').run(jid, agentId, content);
}

function deleteChatNote(id) {
  return db.prepare('DELETE FROM chat_notes WHERE id = ?').run(id);
}

// ========================
// Settings
// ========================
function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settings = {};
  for (const row of rows) settings[row.key] = row.value;
  return settings;
}

// ========================
// Stats
// ========================
function getStats() {
  return {
    totalUsers: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    totalMessages: db.prepare('SELECT COUNT(*) as c FROM messages').get().c,
    todayMessages: db.prepare("SELECT COUNT(*) as c FROM messages WHERE date(timestamp) = date('now')").get().c,
    aiResponses: db.prepare('SELECT COUNT(*) as c FROM messages WHERE is_ai_response = 1').get().c,
    activeUsers: db.prepare("SELECT COUNT(*) as c FROM users WHERE date(last_seen) >= date('now', '-7 days')").get().c,
    openChats: db.prepare("SELECT COUNT(*) as c FROM users WHERE chat_status = 'open'").get().c,
    inProgressChats: db.prepare("SELECT COUNT(*) as c FROM users WHERE chat_status = 'in_progress'").get().c,
    resolvedChats: db.prepare("SELECT COUNT(*) as c FROM users WHERE chat_status = 'resolved'").get().c,
    totalAgents: db.prepare('SELECT COUNT(*) as c FROM agents').get().c,
    onlineAgents: db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'online'").get().c,
  };
}

function getMessageStats(days = 7) {
  return db.prepare(`
    SELECT date(timestamp) as date,
      COUNT(*) as total,
      SUM(CASE WHEN direction='incoming' THEN 1 ELSE 0 END) as incoming,
      SUM(CASE WHEN direction='outgoing' THEN 1 ELSE 0 END) as outgoing
    FROM messages WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY date(timestamp) ORDER BY date ASC
  `).all(days);
}

function getAgentStats() {
  return db.prepare(`
    SELECT a.id, a.name, a.avatar_color,
      (SELECT COUNT(*) FROM users WHERE assigned_agent_id = a.id) as assigned_chats,
      (SELECT COUNT(*) FROM messages WHERE agent_id = a.id AND direction='outgoing') as total_replies
    FROM agents a ORDER BY total_replies DESC
  `).all();
}

module.exports = {
  db, hashPassword,
  createAgent, getAgentByCredentials, getAgentById, getAgents, updateAgentStatus, deleteAgent,
  upsertUser, getUsers, getUser, updateChatStatus, assignChat, setChatPriority, toggleUserAI, searchUsers,
  saveMessage, getMessages, getRecentMessages,
  getQuickReplies, createQuickReply, updateQuickReply, deleteQuickReply,
  getLabels, createLabel, deleteLabel, getChatLabels, addChatLabel, removeChatLabel,
  getChatNotes, addChatNote, deleteChatNote,
  getSetting, setSetting, getAllSettings,
  getStats, getMessageStats, getAgentStats
};
