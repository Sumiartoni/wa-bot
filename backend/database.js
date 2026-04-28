const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'wa-bot.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT UNIQUE NOT NULL,
    name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    ai_enabled INTEGER DEFAULT 1,
    first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_messages INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_jid TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
    content TEXT NOT NULL,
    message_type TEXT DEFAULT 'text',
    is_ai_response INTEGER DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_jid) REFERENCES users(jid)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_user_jid ON messages(user_jid);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen DESC);
`);

// Initialize default settings
const initSettings = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
initSettings.run('global_ai_enabled', 'true');
initSettings.run('ai_model', process.env.AI_MODEL || 'llama-3.3-70b-versatile');
initSettings.run('ai_system_prompt', process.env.AI_SYSTEM_PROMPT || 'Kamu adalah asisten AI yang ramah dan membantu.');

// ========================
// User Operations
// ========================

function upsertUser(jid, name = '') {
  const phone = jid.replace('@s.whatsapp.net', '').replace('@g.us', '');
  const stmt = db.prepare(`
    INSERT INTO users (jid, name, phone, last_seen, total_messages)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, 1)
    ON CONFLICT(jid) DO UPDATE SET
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
      last_seen = CURRENT_TIMESTAMP,
      total_messages = users.total_messages + 1
  `);
  stmt.run(jid, name, phone);
}

function getUsers() {
  return db.prepare(`
    SELECT u.*, 
      (SELECT content FROM messages WHERE user_jid = u.jid ORDER BY timestamp DESC LIMIT 1) as last_message,
      (SELECT COUNT(*) FROM messages WHERE user_jid = u.jid AND direction = 'incoming') as incoming_count,
      (SELECT COUNT(*) FROM messages WHERE user_jid = u.jid AND direction = 'outgoing') as outgoing_count
    FROM users u 
    ORDER BY u.last_seen DESC
  `).all();
}

function getUser(jid) {
  return db.prepare('SELECT * FROM users WHERE jid = ?').get(jid);
}

function toggleUserAI(jid, enabled) {
  db.prepare('UPDATE users SET ai_enabled = ? WHERE jid = ?').run(enabled ? 1 : 0, jid);
}

function searchUsers(query) {
  return db.prepare(`
    SELECT u.*, 
      (SELECT content FROM messages WHERE user_jid = u.jid ORDER BY timestamp DESC LIMIT 1) as last_message
    FROM users u 
    WHERE u.name LIKE ? OR u.phone LIKE ? OR u.jid LIKE ?
    ORDER BY u.last_seen DESC
  `).all(`%${query}%`, `%${query}%`, `%${query}%`);
}

// ========================
// Message Operations
// ========================

function saveMessage(userJid, direction, content, messageType = 'text', isAiResponse = false) {
  const stmt = db.prepare(`
    INSERT INTO messages (user_jid, direction, content, message_type, is_ai_response)
    VALUES (?, ?, ?, ?, ?)
  `);
  return stmt.run(userJid, direction, content, messageType, isAiResponse ? 1 : 0);
}

function getMessages(userJid, limit = 50, offset = 0) {
  return db.prepare(`
    SELECT * FROM messages 
    WHERE user_jid = ? 
    ORDER BY timestamp DESC 
    LIMIT ? OFFSET ?
  `).all(userJid, limit, offset);
}

function getRecentMessages(userJid, limit = 10) {
  return db.prepare(`
    SELECT * FROM messages 
    WHERE user_jid = ? 
    ORDER BY timestamp DESC 
    LIMIT ?
  `).all(userJid, limit).reverse();
}

function getAllMessages(limit = 100, offset = 0) {
  return db.prepare(`
    SELECT m.*, u.name as user_name, u.phone as user_phone
    FROM messages m
    LEFT JOIN users u ON m.user_jid = u.jid
    ORDER BY m.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
}

// ========================
// Settings Operations
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
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ========================
// Stats Operations
// ========================

function getStats() {
  const totalUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const totalMessages = db.prepare('SELECT COUNT(*) as count FROM messages').get().count;
  const todayMessages = db.prepare(`
    SELECT COUNT(*) as count FROM messages 
    WHERE date(timestamp) = date('now')
  `).get().count;
  const aiResponses = db.prepare(`
    SELECT COUNT(*) as count FROM messages WHERE is_ai_response = 1
  `).get().count;
  const activeUsers = db.prepare(`
    SELECT COUNT(*) as count FROM users 
    WHERE date(last_seen) >= date('now', '-7 days')
  `).get().count;

  return {
    totalUsers,
    totalMessages,
    todayMessages,
    aiResponses,
    activeUsers
  };
}

function getMessageStats(days = 7) {
  return db.prepare(`
    SELECT date(timestamp) as date, 
           COUNT(*) as total,
           SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
           SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing
    FROM messages 
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY date(timestamp)
    ORDER BY date ASC
  `).all(days);
}

module.exports = {
  db,
  upsertUser,
  getUsers,
  getUser,
  toggleUserAI,
  searchUsers,
  saveMessage,
  getMessages,
  getRecentMessages,
  getAllMessages,
  getSetting,
  setSetting,
  getAllSettings,
  getStats,
  getMessageStats
};
