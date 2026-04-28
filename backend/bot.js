const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const QRCode = require('qrcode');
const { generateResponse } = require('./ai');
const db = require('./database');

const AUTH_DIR = path.join(__dirname, '..', 'data', 'auth');

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let connectionInfo = null;
let eventEmitter = null;

function setEventEmitter(emitter) {
  eventEmitter = emitter;
}

function emitEvent(event, data) {
  if (eventEmitter) eventEmitter.emit(event, data);
}

function getStatus() {
  return { status: connectionStatus, qrCode: qrCodeData, info: connectionInfo };
}

function getSock() { return sock; }

async function startBot() {
  const logger = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version, logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: true,
    generateHighQualityLinkPreview: true,
    defaultQueryTimeoutMs: undefined,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      connectionStatus = 'qr';
      try { qrCodeData = await QRCode.toDataURL(qr); emitEvent('qr', qrCodeData); console.log('[BOT] QR Code ready'); } catch(e) {}
    }
    if (connection === 'close') {
      qrCodeData = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      console.log(`[BOT] Closed. Code:${code} Reconnect:${reconnect}`);
      if (reconnect) { connectionStatus = 'connecting'; emitEvent('status',{status:'connecting'}); setTimeout(()=>startBot(),3000); }
      else { connectionStatus = 'disconnected'; connectionInfo = null; emitEvent('status',{status:'disconnected'}); }
    }
    if (connection === 'open') {
      connectionStatus = 'connected'; qrCodeData = null;
      connectionInfo = { user: sock.user, connectedAt: new Date().toISOString() };
      emitEvent('status', { status: 'connected', info: connectionInfo });
      console.log('[BOT] ✅ Connected as', sock.user?.name || sock.user?.id);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) await handleMessage(msg);
  });

  return sock;
}

async function handleMessage(msg) {
  try {
    if (!msg.message || msg.key.fromMe) return;
    if (msg.key.remoteJid === 'status@broadcast') return;
    if (msg.key.remoteJid?.endsWith('@g.us')) return;

    const jid = msg.key.remoteJid;
    const pushName = msg.pushName || '';
    const textContent = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || msg.message.videoMessage?.caption || '';
    if (!textContent) return;

    console.log(`[BOT] 📩 ${pushName} (${jid}): ${textContent.substring(0,50)}...`);

    db.upsertUser(jid, pushName);
    db.saveMessage(jid, 'incoming', textContent, 'text', false);
    emitEvent('message', { jid, name: pushName, content: textContent, direction: 'incoming', timestamp: new Date().toISOString() });

    const globalAI = db.getSetting('global_ai_enabled') === 'true';
    const user = db.getUser(jid);
    const userAI = user ? user.ai_enabled === 1 : true;
    if (!globalAI || !userAI) return;

    const chatHistory = db.getRecentMessages(jid, 8);
    const systemPrompt = db.getSetting('ai_system_prompt');
    const model = db.getSetting('ai_model');
    const provider = db.getSetting('ai_provider') || 'groq';

    const aiResponse = await generateResponse(textContent, chatHistory, systemPrompt, model, provider);
    await sock.sendMessage(jid, { text: aiResponse });
    db.saveMessage(jid, 'outgoing', aiResponse, 'text', true);
    emitEvent('message', { jid, name: 'Bot', content: aiResponse, direction: 'outgoing', isAi: true, timestamp: new Date().toISOString() });
    console.log(`[BOT] 🤖 Replied: ${aiResponse.substring(0,50)}...`);
  } catch (error) {
    console.error('[BOT] Error:', error);
  }
}

async function sendMessage(jid, text) {
  if (!sock || connectionStatus !== 'connected') throw new Error('WhatsApp belum terhubung');
  await sock.sendMessage(jid, { text });
  db.saveMessage(jid, 'outgoing', text, 'text', false);
  emitEvent('message', { jid, name: 'Admin', content: text, direction: 'outgoing', isAi: false, timestamp: new Date().toISOString() });
  return true;
}

async function logout() {
  try { if (sock) await sock.logout(); } catch(e) {}
  const fs = require('fs');
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  connectionStatus = 'disconnected'; connectionInfo = null; qrCodeData = null; sock = null;
}

module.exports = { startBot, getStatus, getSock, sendMessage, logout, setEventEmitter };
