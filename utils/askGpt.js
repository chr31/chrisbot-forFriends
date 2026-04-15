const { callOllamaChatCompletions, resolveOllamaModelAlias } = require('../services/ollamaRuntime');
const { createOpenAiClient, getDefaultOpenAiModel } = require('../services/openaiRuntime');

const DEFAULT_OLLAMA_MODEL = null;

function resolveOllamaModel(model) {
  if (model === undefined || model === null || String(model).trim() === '') {
    return null;
  }
  return resolveOllamaModelAlias(model, DEFAULT_OLLAMA_MODEL);
}

async function askOllamaChatCompletions(messages, tools = null, model = DEFAULT_OLLAMA_MODEL, options = {}) {
  const messagePayload = Array.isArray(messages)
    ? messages
    : [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: messages },
      ];

  try {
    const result = await callOllamaChatCompletions(messagePayload, tools, resolveOllamaModel(model), options);
    if (result?.message) {
      return {
        ...result.message,
        _ollama: result.connection,
      };
    }
    throw new Error('No message returned from Ollama chat completions.');
  } catch (error) {
    throw new Error('Ollama Chat Completions error: ' + (error?.message || error));
  }
}

async function askGPT(prompt, system) {
  const chat = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  try {
    const openai = createOpenAiClient();
    const response = await openai.chat.completions.create({
      model: getDefaultOpenAiModel(),
      messages: chat,
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.log('Log', 'Errore nel chiamare le API di OpenAI:' + error.message);
    return 'Errore nella chiamata api a ChrisBot';
  }
}

module.exports = {
  DEFAULT_OLLAMA_MODEL,
  resolveOllamaModel,
  askOllamaChatCompletions,
  askGPT,
};
