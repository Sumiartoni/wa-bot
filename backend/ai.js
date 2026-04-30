const Groq = require('groq-sdk');
const OpenAI = require('openai');
const db = require('./database');
const { randomUUID } = require('crypto');

let groqClient = null;
let openaiClient = null;

function getGroqClient() {
  const apiKey = db.getSetting('groq_api_key') || process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ API Key belum diset');
  if (!groqClient || groqClient._apiKey !== apiKey) {
    groqClient = new Groq({ apiKey });
    groqClient._apiKey = apiKey;
  }
  return groqClient;
}

function getOpenRouterClient() {
  const apiKey = db.getSetting('openrouter_api_key') || process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OpenRouter API Key belum diset');
  if (!openaiClient || openaiClient._apiKey !== apiKey) {
    openaiClient = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' });
    openaiClient._apiKey = apiKey;
  }
  return openaiClient;
}

const DEFAULT_MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'google/gemini-2.0-flash-001',
  chatgpt: 'auto'
};

/**
 * ChatGPT Free (Unofficial) - uses access token from browser session
 * User gets token from: https://chatgpt.com/api/auth/session
 */
async function chatgptFree(messages, model = 'auto') {
  const accessToken = db.getSetting('chatgpt_access_token');
  if (!accessToken) throw new Error('ChatGPT Access Token belum diset. Ambil dari chatgpt.com/api/auth/session');

  // Convert messages to ChatGPT format
  const chatgptMessages = messages.map(m => ({
    id: randomUUID(),
    author: { role: m.role },
    content: { content_type: 'text', parts: [m.content] },
    metadata: {}
  }));

  const body = {
    action: 'next',
    messages: chatgptMessages,
    model: model || 'auto',
    parent_message_id: randomUUID(),
    timezone_offset_min: -420,
    history_and_training_disabled: true,
    conversation_mode: { kind: 'primary_assistant' },
    force_paragen: false,
    force_paragen_model_slug: '',
    force_nulligen: false,
    force_rate_limit: false,
  };

  const deviceId = randomUUID();

  const response = await fetch('https://chatgpt.com/backend-api/conversation', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Referer': 'https://chatgpt.com/',
      'Origin': 'https://chatgpt.com',
      'oai-device-id': deviceId,
      'oai-language': 'en-US',
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[ChatGPT] Error:', response.status, errText.substring(0, 300));
    if (response.status === 401) {
      throw new Error('ChatGPT token expired/invalid. Ambil token baru dari chatgpt.com/api/auth/session');
    }
    if (response.status === 403) {
      throw new Error('ChatGPT request diblokir (Cloudflare). Coba ambil token baru atau gunakan GROQ.');
    }
    throw new Error(`ChatGPT error: ${response.status}`);
  }

  // Parse SSE response
  const text = await response.text();
  const lines = text.split('\n');
  let lastContent = '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;

    try {
      const parsed = JSON.parse(data);
      const parts = parsed.message?.content?.parts;
      if (parts && parts.length > 0 && parsed.message?.author?.role === 'assistant') {
        lastContent = parts.join('');
      }
    } catch (e) {
      // Skip unparseable lines
    }
  }

  if (!lastContent) throw new Error('Empty response from ChatGPT');
  return lastContent.trim();
}

async function generateResponse(userMessage, chatHistory = [], systemPrompt = '', model = '', provider = 'groq') {
  const activeProvider = provider || db.getSetting('ai_provider') || 'groq';
  const activeModel = model || db.getSetting('ai_model') || DEFAULT_MODELS[activeProvider] || 'auto';
  const activePrompt = systemPrompt || db.getSetting('ai_system_prompt') || 'Kamu adalah asisten AI yang ramah dan membantu.';

  const messages = [{ role: 'system', content: activePrompt }];
  for (const msg of chatHistory) {
    messages.push({ role: msg.direction === 'incoming' ? 'user' : 'assistant', content: msg.content });
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    // ChatGPT Free (unofficial)
    if (activeProvider === 'chatgpt') {
      return await chatgptFree(messages, activeModel);
    }

    // GROQ or OpenRouter (official)
    let client;
    if (activeProvider === 'openrouter') {
      client = getOpenRouterClient();
    } else {
      client = getGroqClient();
    }

    const completion = await client.chat.completions.create({
      model: activeModel,
      messages,
      temperature: 0.7,
      max_tokens: 1024,
    });

    const response = completion.choices[0]?.message?.content;
    if (!response) throw new Error('Empty response');
    return response.trim();
  } catch (error) {
    console.error(`[AI/${activeProvider}] Error:`, error.message);
    if (error.message.includes('token expired') || error.message.includes('Access Token')) {
      return '⚠️ ' + error.message;
    }
    if (error.status === 429) return '⏳ Maaf, bot sedang sibuk. Coba lagi nanti.';
    if (error.status === 401) return '⚠️ API Key/Token tidak valid. Hubungi admin.';
    return '❌ Maaf, terjadi kesalahan. Silakan coba lagi.';
  }
}

module.exports = { generateResponse };
