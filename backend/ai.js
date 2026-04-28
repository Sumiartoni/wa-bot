const Groq = require('groq-sdk');
const OpenAI = require('openai');
const db = require('./database');

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

function getOpenAIClient() {
  const apiKey = db.getSetting('openai_api_key') || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OpenAI API Key belum diset');
  if (!openaiClient || openaiClient._apiKey !== apiKey) {
    openaiClient = new OpenAI({ apiKey });
    openaiClient._apiKey = apiKey;
  }
  return openaiClient;
}

const DEFAULT_MODELS = {
  groq: 'llama-3.3-70b-versatile',
  openai: 'gpt-4o-mini'
};

async function generateResponse(userMessage, chatHistory = [], systemPrompt = '', model = '', provider = 'groq') {
  const activeProvider = provider || db.getSetting('ai_provider') || 'groq';
  const activeModel = model || db.getSetting('ai_model') || DEFAULT_MODELS[activeProvider];
  const activePrompt = systemPrompt || db.getSetting('ai_system_prompt') || 'Kamu adalah asisten AI yang ramah dan membantu.';

  const messages = [{ role: 'system', content: activePrompt }];
  for (const msg of chatHistory) {
    messages.push({ role: msg.direction === 'incoming' ? 'user' : 'assistant', content: msg.content });
  }
  messages.push({ role: 'user', content: userMessage });

  try {
    let client;
    if (activeProvider === 'openai') {
      client = getOpenAIClient();
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
    if (error.status === 429) return '⏳ Maaf, bot sedang sibuk. Coba lagi nanti.';
    if (error.status === 401) return '⚠️ API Key AI tidak valid. Hubungi admin.';
    return '❌ Maaf, terjadi kesalahan. Silakan coba lagi.';
  }
}

module.exports = { generateResponse };
