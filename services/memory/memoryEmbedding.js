const { createOpenAiClient } = require('../openaiRuntime');
const { callOllamaEmbeddings } = require('../ollamaRuntime');

function normalizeEmbeddingInput(input) {
  const values = Array.isArray(input) ? input : [input];
  const normalized = values
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    throw new Error('Testo embedding obbligatorio.');
  }
  return normalized;
}

function isValidEmbeddingVector(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((entry) => Number.isFinite(Number(entry)));
}

function normalizeEmbeddingVector(value) {
  if (!isValidEmbeddingVector(value)) {
    throw new Error('Vettore embedding non valido.');
  }
  return value.map((entry) => Number(entry));
}

function getOpenAiEmbeddingModel(settings = {}) {
  return String(settings.embedding_model || 'text-embedding-3-small').trim() || 'text-embedding-3-small';
}

async function callOpenAiEmbeddings(input, settings = {}) {
  const inputs = normalizeEmbeddingInput(input);
  const client = createOpenAiClient();
  const response = await client.embeddings.create({
    model: getOpenAiEmbeddingModel(settings),
    input: inputs,
  });
  const embeddings = Array.isArray(response?.data)
    ? response.data.map((entry) => entry?.embedding)
    : [];
  if (embeddings.length !== inputs.length || !embeddings.every(isValidEmbeddingVector)) {
    throw new Error('Risposta embedding OpenAI non valida.');
  }
  return {
    embeddings: embeddings.map(normalizeEmbeddingVector),
    model: getOpenAiEmbeddingModel(settings),
    provider: 'openai',
  };
}

async function embedTexts(input, settings = {}) {
  const inputs = normalizeEmbeddingInput(input);
  const provider = String(settings.embedding_model_provider || '').trim().toLowerCase();

  if (provider === 'openai') {
    return callOpenAiEmbeddings(inputs, settings);
  }

  if (provider === 'ollama') {
    if (!String(settings.embedding_model || '').trim()) {
      throw new Error('Modello embedding Ollama non configurato.');
    }
    const result = await callOllamaEmbeddings(inputs, settings.embedding_model, {
      ollamaServerId: settings.embedding_ollama_server_id || settings.ollama_server_id || null,
    });
    return {
      embeddings: result.embeddings.map(normalizeEmbeddingVector),
      model: result.connection?.model || settings.embedding_model,
      provider: 'ollama',
      connection: result.connection || null,
      attempts: result.attempts || [],
    };
  }

  throw new Error(`Provider embedding non supportato: ${provider || 'non configurato'}`);
}

module.exports = {
  embedTexts,
  normalizeEmbeddingInput,
  normalizeEmbeddingVector,
};
