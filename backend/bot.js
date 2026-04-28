const { generateResponse } = require('./groq');
const db = require('./database');

let connectionStatus = 'disconnected';
let connectionInfo = null;
let eventEmitter = null;

const WA_API_URL = 'https://graph.facebook.com/v21.0';

function setEventEmitter(emitter) {
  eventEmitter = emitter;
}

function emitEvent(event, data) {
  if (eventEmitter) {
    eventEmitter.emit(event, data);
  }
}

function getStatus() {
  const hasToken = !!process.env.WA_ACCESS_TOKEN;
  const hasPhone = !!process.env.WA_PHONE_NUMBER_ID;
  
  if (hasToken && hasPhone) {
    connectionStatus = 'connected';
    connectionInfo = {
      phoneId: process.env.WA_PHONE_NUMBER_ID,
      connectedAt: new Date().toISOString()
    };
  }

  return {
    status: connectionStatus,
    qrCode: null, // Official API tidak perlu QR
    info: connectionInfo
  };
}

/**
 * Kirim pesan via WhatsApp Cloud API
 */
async function sendMessage(to, text) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token = process.env.WA_ACCESS_TOKEN;

  if (!phoneId || !token) {
    throw new Error('WA_PHONE_NUMBER_ID atau WA_ACCESS_TOKEN belum diset di .env');
  }

  // Format nomor: hapus + dan spasi, pastikan format internasional
  const formattedNumber = to.replace(/[^0-9]/g, '');

  const response = await fetch(`${WA_API_URL}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: formattedNumber,
      type: 'text',
      text: { 
        preview_url: false,
        body: text 
      }
    })
  });

  const result = await response.json();

  if (result.error) {
    console.error('[BOT] Send error:', result.error);
    throw new Error(result.error.message || 'Gagal mengirim pesan');
  }

  // Simpan pesan keluar ke database
  const jid = formattedNumber;
  db.saveMessage(jid, 'outgoing', text, 'text', false);

  emitEvent('message', {
    jid,
    name: 'Admin',
    content: text,
    direction: 'outgoing',
    isAi: false,
    timestamp: new Date().toISOString()
  });

  console.log(`[BOT] ✅ Pesan terkirim ke ${formattedNumber}`);
  return result;
}

/**
 * Handle incoming webhook dari WhatsApp Cloud API
 */
async function handleWebhook(body) {
  try {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value || !value.messages) return;

    const message = value.messages[0];
    const contact = value.contacts?.[0];

    // Hanya handle pesan teks
    if (message.type !== 'text') {
      console.log(`[BOT] Pesan non-teks diterima: ${message.type}`);
      return;
    }

    const from = message.from; // Nomor pengirim (format: 6281xxx)
    const text = message.text?.body || '';
    const pushName = contact?.profile?.name || '';

    console.log(`[BOT] 📩 Pesan dari ${pushName} (${from}): ${text.substring(0, 50)}...`);

    // Simpan user dan pesan masuk
    db.upsertUser(from, pushName);
    db.saveMessage(from, 'incoming', text, 'text', false);

    // Emit event ke dashboard
    emitEvent('message', {
      jid: from,
      name: pushName,
      content: text,
      direction: 'incoming',
      timestamp: new Date().toISOString()
    });

    // Mark as read
    await markAsRead(message.id);

    // Cek apakah AI aktif
    const globalAI = db.getSetting('global_ai_enabled') === 'true';
    const user = db.getUser(from);
    const userAI = user ? user.ai_enabled === 1 : true;

    if (!globalAI || !userAI) {
      console.log(`[BOT] AI dinonaktifkan untuk ${from}. Skip auto-reply.`);
      return;
    }

    // Ambil riwayat chat untuk konteks
    const chatHistory = db.getRecentMessages(from, 8);
    const systemPrompt = db.getSetting('ai_system_prompt');
    const model = db.getSetting('ai_model');

    // Generate balasan AI
    const aiResponse = await generateResponse(text, chatHistory, systemPrompt, model);

    // Kirim balasan
    await sendWhatsAppMessage(from, aiResponse);

    // Simpan pesan keluar
    db.saveMessage(from, 'outgoing', aiResponse, 'text', true);

    emitEvent('message', {
      jid: from,
      name: 'Bot',
      content: aiResponse,
      direction: 'outgoing',
      isAi: true,
      timestamp: new Date().toISOString()
    });

    console.log(`[BOT] 🤖 AI replied to ${pushName}: ${aiResponse.substring(0, 50)}...`);

  } catch (error) {
    console.error('[BOT] Error handling webhook:', error);
  }
}

/**
 * Kirim pesan WhatsApp (internal, untuk auto-reply)
 */
async function sendWhatsAppMessage(to, text) {
  const phoneId = process.env.WA_PHONE_NUMBER_ID;
  const token = process.env.WA_ACCESS_TOKEN;

  const response = await fetch(`${WA_API_URL}/${phoneId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    })
  });

  return response.json();
}

/**
 * Mark message as read
 */
async function markAsRead(messageId) {
  try {
    const phoneId = process.env.WA_PHONE_NUMBER_ID;
    const token = process.env.WA_ACCESS_TOKEN;

    await fetch(`${WA_API_URL}/${phoneId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      })
    });
  } catch (e) {
    // Tidak fatal jika gagal mark as read
  }
}

/**
 * Verifikasi webhook (GET request dari Meta)
 */
function verifyWebhook(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  const verifyToken = process.env.WA_VERIFY_TOKEN || 'mywabot2026';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[BOT] ✅ Webhook verified');
    return challenge;
  }

  return null;
}

// Tidak perlu startBot/logout untuk Official API
async function startBot() {
  const status = getStatus();
  if (status.status === 'connected') {
    return { message: 'Bot sudah terhubung ke WhatsApp Cloud API' };
  }
  return { message: 'Set WA_ACCESS_TOKEN dan WA_PHONE_NUMBER_ID di .env' };
}

async function logout() {
  connectionStatus = 'disconnected';
  connectionInfo = null;
  return { message: 'Status direset. Untuk disconnect sepenuhnya, hapus token di Meta Developer Console.' };
}

module.exports = {
  startBot,
  getStatus,
  sendMessage,
  handleWebhook,
  verifyWebhook,
  logout,
  setEventEmitter
};
