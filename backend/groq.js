const Groq = require('groq-sdk');

let groqClient = null;

function getClient() {
  if (!groqClient) {
    groqClient = new Groq({
      apiKey: process.env.GROQ_API_KEY
    });
  }
  return groqClient;
}

/**
 * Generate AI response using GROQ API
 * @param {string} userMessage - The user's message
 * @param {Array} chatHistory - Previous messages for context
 * @param {string} systemPrompt - Custom system prompt
 * @param {string} model - AI model to use
 * @returns {Promise<string>} AI response text
 */
async function generateResponse(userMessage, chatHistory = [], systemPrompt = '', model = '') {
  const client = getClient();
  
  const activeModel = model || process.env.AI_MODEL || 'llama-3.3-70b-versatile';
  const activePrompt = systemPrompt || process.env.AI_SYSTEM_PROMPT || 'Kamu adalah asisten AI yang ramah dan membantu.';

  // Build messages array with context
  const messages = [
    {
      role: 'system',
      content: activePrompt
    }
  ];

  // Add chat history for context (last N messages)
  for (const msg of chatHistory) {
    messages.push({
      role: msg.direction === 'incoming' ? 'user' : 'assistant',
      content: msg.content
    });
  }

  // Add current message
  messages.push({
    role: 'user',
    content: userMessage
  });

  try {
    const completion = await client.chat.completions.create({
      model: activeModel,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1024,
      top_p: 0.9,
    });

    const response = completion.choices[0]?.message?.content;
    
    if (!response) {
      throw new Error('Empty response from AI');
    }

    return response.trim();
  } catch (error) {
    console.error('[GROQ] Error generating response:', error.message);
    
    if (error.status === 429) {
      return '⏳ Maaf, bot sedang sibuk. Silakan coba lagi dalam beberapa saat.';
    }
    if (error.status === 401) {
      return '⚠️ Konfigurasi AI belum benar. Hubungi admin.';
    }
    
    return '❌ Maaf, terjadi kesalahan saat memproses pesan. Silakan coba lagi.';
  }
}

module.exports = {
  generateResponse
};
