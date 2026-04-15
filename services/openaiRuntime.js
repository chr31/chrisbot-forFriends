const { OpenAI } = require('openai');
const { getOpenAiRuntimeSettingsSync } = require('./appSettings');

function getOpenAiRuntimeSettings() {
  return getOpenAiRuntimeSettingsSync();
}

function getConfiguredOpenAiApiKey() {
  return String(getOpenAiRuntimeSettings()?.api_key || '').trim();
}

function getConfiguredOpenAiChatModel() {
  return String(getOpenAiRuntimeSettings()?.chat_model || '').trim();
}

function getDefaultOpenAiModel() {
  return String(getOpenAiRuntimeSettings()?.chat_model || 'gpt-5-mini').trim() || 'gpt-5-mini';
}

function isOpenAiConfigured() {
  return Boolean(getConfiguredOpenAiApiKey() && getConfiguredOpenAiChatModel());
}

function createOpenAiClient() {
  const apiKey = getConfiguredOpenAiApiKey();
  if (!apiKey) {
    throw new Error('OpenAI API key non configurata nelle impostazioni.');
  }
  return new OpenAI({ apiKey });
}

module.exports = {
  getOpenAiRuntimeSettings,
  getConfiguredOpenAiApiKey,
  getConfiguredOpenAiChatModel,
  getDefaultOpenAiModel,
  isOpenAiConfigured,
  createOpenAiClient,
};
