const { createOpenAiClient } = require('../openaiRuntime');
const { callOllamaChatCompletions } = require('../ollamaRuntime');

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    throw new Error('Risposta memoria vuota.');
  }

  try {
    return JSON.parse(raw);
  } catch (_) {
    // Continue with fenced/object extraction below.
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      // Continue with object slicing below.
    }
  }

  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return JSON.parse(raw.slice(first, last + 1));
  }

  throw new Error('Risposta memoria non in formato JSON.');
}

async function callOpenAiMemoryJson(messages, settings = {}) {
  const client = createOpenAiClient();
  const model = String(settings.analysis_model || 'gpt-5-mini').trim() || 'gpt-5-mini';
  try {
    const response = await client.chat.completions.create({
      model,
      messages,
      response_format: { type: 'json_object' },
    });
    return extractJsonObject(response.choices?.[0]?.message?.content || '');
  } catch (error) {
    const message = String(error?.message || '').toLowerCase();
    if (!message.includes('response_format') && !message.includes('json')) {
      throw error;
    }
    const response = await client.chat.completions.create({ model, messages });
    return extractJsonObject(response.choices?.[0]?.message?.content || '');
  }
}

async function callOpenAiMemoryText(messages, settings = {}) {
  const client = createOpenAiClient();
  const model = String(settings.analysis_model || 'gpt-5-mini').trim() || 'gpt-5-mini';
  const response = await client.chat.completions.create({ model, messages });
  return String(response.choices?.[0]?.message?.content || '').trim();
}

async function callOllamaMemoryJson(messages, settings = {}) {
  const model = String(settings.analysis_model || '').trim();
  if (!model) {
    throw new Error('Modello chat memoria Ollama non configurato.');
  }
  const result = await callOllamaChatCompletions(messages, null, model, {
    ollamaServerId: settings.ollama_server_id || null,
  });
  return extractJsonObject(result?.message?.content || '');
}

async function callOllamaMemoryText(messages, settings = {}) {
  const model = String(settings.analysis_model || '').trim();
  if (!model) {
    throw new Error('Modello chat memoria Ollama non configurato.');
  }
  const result = await callOllamaChatCompletions(messages, null, model, {
    ollamaServerId: settings.ollama_server_id || null,
  });
  return String(result?.message?.content || '').trim();
}

async function callMemoryChatJson(messages, settings = {}) {
  const provider = String(settings.analysis_model_provider || '').trim().toLowerCase();
  if (provider === 'openai') {
    return callOpenAiMemoryJson(messages, settings);
  }
  if (provider === 'ollama') {
    return callOllamaMemoryJson(messages, settings);
  }
  throw new Error(`Provider chat memoria non supportato: ${provider || 'non configurato'}`);
}

async function callMemoryChatText(messages, settings = {}) {
  const provider = String(settings.analysis_model_provider || '').trim().toLowerCase();
  if (provider === 'openai') {
    return callOpenAiMemoryText(messages, settings);
  }
  if (provider === 'ollama') {
    return callOllamaMemoryText(messages, settings);
  }
  throw new Error(`Provider chat memoria non supportato: ${provider || 'non configurato'}`);
}

module.exports = {
  callMemoryChatText,
  callMemoryChatJson,
  extractJsonObject,
};
