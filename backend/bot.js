const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const QRCode = require('qrcode');
const { generateResponse } = require('./groq');
const db = require('./database');

const AUTH_DIR = path.join(__dirname, '..', 'data', 'auth');

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected'; // disconnected, connecting, qr, connected
let connectionInfo = null;
let eventEmitter = null;

function setEventEmitter(emitter) {
  eventEmitter = emitter;
}

function emitEvent(event, data) {
  if (eventEmitter) {
    eventEmitter.emit(event, data);
  }
}

function getStatus() {
  return {
    status: connectionStatus,
    qrCode: qrCodeData,
    info: connectionInfo
  };
}

function getSock() {
  return sock;
}

async function startBot() {
  const logger = pino({ level: 'silent' });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: true,
    generateHighQualityLinkPreview: true,
    defaultQueryTimeoutMs: undefined,
  });

  // Connection update handler
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'qr';
      try {
        qrCodeData = await QRCode.toDataURL(qr);
        emitEvent('qr', qrCodeData);
        console.log('[BOT] QR Code ready - scan from dashboard');
      } catch (err) {
        console.error('[BOT] QR generation error:', err);
      }
    }

    if (connection === 'close') {
      qrCodeData = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`[BOT] Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`);
      
      if (shouldReconnect) {
        connectionStatus = 'connecting';
        emitEvent('status', { status: 'connecting' });
        setTimeout(() => startBot(), 3000);
      } else {
        connectionStatus = 'disconnected';
        connectionInfo = null;
        emitEvent('status', { status: 'disconnected' });
        console.log('[BOT] Logged out. Delete auth folder and restart to re-login.');
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      qrCodeData = null;
      connectionInfo = {
        user: sock.user,
        connectedAt: new Date().toISOString()
      };
      emitEvent('status', { status: 'connected', info: connectionInfo });
      console.log('[BOT] ✅ Connected to WhatsApp as', sock.user?.name || sock.user?.id);
    }
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Message handler
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      await handleMessage(msg);
    }
  });

  return sock;
}

async function handleMessage(msg) {
  try {
    // Skip if no message content or from self
    if (!msg.message || msg.key.fromMe) return;

    // Skip status updates
    if (msg.key.remoteJid === 'status@broadcast') return;

    // Skip group messages (optional - remove this to enable group support)
    if (msg.key.remoteJid?.endsWith('@g.us')) return;

    const jid = msg.key.remoteJid;
    const pushName = msg.pushName || '';

    // Extract text content
    const textContent = 
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      '';

    if (!textContent) return;

    console.log(`[BOT] 📩 Message from ${pushName} (${jid}): ${textContent.substring(0, 50)}...`);

    // Save user and incoming message
    db.upsertUser(jid, pushName);
    db.saveMessage(jid, 'incoming', textContent, 'text', false);

    // Emit new message event for dashboard
    emitEvent('message', {
      jid,
      name: pushName,
      content: textContent,
      direction: 'incoming',
      timestamp: new Date().toISOString()
    });

    // Check if AI is enabled globally and per-user
    const globalAI = db.getSetting('global_ai_enabled') === 'true';
    const user = db.getUser(jid);
    const userAI = user ? user.ai_enabled === 1 : true;

    if (!globalAI || !userAI) {
      console.log(`[BOT] AI disabled for ${jid}. Skipping auto-reply.`);
      return;
    }

    // Get chat history for context
    const chatHistory = db.getRecentMessages(jid, 8);

    // Get AI settings
    const systemPrompt = db.getSetting('ai_system_prompt');
    const model = db.getSetting('ai_model');

    // Generate AI response
    const aiResponse = await generateResponse(textContent, chatHistory, systemPrompt, model);

    // Send response
    await sock.sendMessage(jid, { text: aiResponse });

    // Save outgoing message
    db.saveMessage(jid, 'outgoing', aiResponse, 'text', true);

    // Emit outgoing message event
    emitEvent('message', {
      jid,
      name: 'Bot',
      content: aiResponse,
      direction: 'outgoing',
      isAi: true,
      timestamp: new Date().toISOString()
    });

    console.log(`[BOT] 🤖 AI replied to ${pushName}: ${aiResponse.substring(0, 50)}...`);

  } catch (error) {
    console.error('[BOT] Error handling message:', error);
  }
}

/**
 * Send a manual message from admin dashboard
 */
async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') {
    throw new Error('WhatsApp belum terhubung');
  }

  await sock.sendMessage(jid, { text });
  db.saveMessage(jid, 'outgoing', text, 'text', false);

  emitEvent('message', {
    jid,
    name: 'Admin',
    content: text,
    direction: 'outgoing',
    isAi: false,
    timestamp: new Date().toISOString()
  });

  return true;
}

/**
 * Logout and clear auth data
 */
async function logout() {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (e) {
    console.error('[BOT] Logout error:', e);
  }
  
  // Clear auth directory
  const fs = require('fs');
  if (fs.existsSync(AUTH_DIR)) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  }
  
  connectionStatus = 'disconnected';
  connectionInfo = null;
  qrCodeData = null;
  sock = null;
}

module.exports = {
  startBot,
  getStatus,
  getSock,
  sendMessage,
  logout,
  setEventEmitter
};
