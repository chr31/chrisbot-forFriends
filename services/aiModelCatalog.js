const { getOllamaRuntimeSettingsSync } = require('./appSettings');
const { getDefaultOpenAiModel, isOpenAiConfigured } = require('./openaiRuntime');

const MODEL_PROVIDERS = {
  OPENAI: 'openai',
  OLLAMA: 'ollama',
};

function normalizeModelProvider(value, fallback = MODEL_PROVIDERS.OLLAMA) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === MODEL_PROVIDERS.OPENAI) return MODEL_PROVIDERS.OPENAI;
  if (normalized === MODEL_PROVIDERS.OLLAMA) return MODEL_PROVIDERS.OLLAMA;
  return fallback;
}

function normalizeModelName(value, fallback = '') {
  return String(value || '').trim() || fallback;
}

function getOllamaDefaultModelConfig() {
  const settings = getOllamaRuntimeSettingsSync();
  return {
    provider: MODEL_PROVIDERS.OLLAMA,
    model: String(settings?.default_model || 'qwen3.5').trim() || 'qwen3.5',
    ollama_server_id: String(settings?.default_connection_id || '').trim() || null,
  };
}

function getDefaultModelConfig() {
  if (isOpenAiConfigured() && !String(getOllamaRuntimeSettingsSync()?.default_model || '').trim()) {
    return {
      provider: MODEL_PROVIDERS.OPENAI,
      model: getDefaultOpenAiModel(),
      ollama_server_id: null,
    };
  }
  return getOllamaDefaultModelConfig();
}

function normalizeModelConfig(input, fallback = null) {
  const nested = input?.model_config && typeof input.model_config === 'object'
    ? input.model_config
    : {};
  const source = {
    provider: input?.model_provider ?? input?.default_model_provider ?? nested.provider,
    model: input?.model_name ?? input?.default_model_name ?? nested.model,
    ollama_server_id: input?.ollama_server_id ?? input?.default_ollama_server_id ?? nested.ollama_server_id,
  };

  const fallbackConfig = fallback || getDefaultModelConfig();
  const provider = normalizeModelProvider(source.provider, normalizeModelProvider(fallbackConfig?.provider, MODEL_PROVIDERS.OLLAMA));
  const modelFallback = provider === MODEL_PROVIDERS.OPENAI
    ? normalizeModelName(fallbackConfig?.model, getDefaultOpenAiModel())
    : normalizeModelName(fallbackConfig?.model, getOllamaDefaultModelConfig().model);
  const model = normalizeModelName(source.model, modelFallback);

  return {
    provider,
    model,
    ollama_server_id: provider === MODEL_PROVIDERS.OLLAMA
      ? (String(source.ollama_server_id || fallbackConfig?.ollama_server_id || '').trim() || null)
      : null,
  };
}

function getAgentDefaultModelConfig(agent) {
  return normalizeModelConfig(
    agent?.default_model_config || {
      model_provider: agent?.default_model_provider,
      model_name: agent?.default_model_name,
      ollama_server_id: agent?.default_ollama_server_id,
    },
    getDefaultModelConfig()
  );
}

function formatModelDisplayLabel(config) {
  const normalized = normalizeModelConfig(config, getDefaultModelConfig());
  if (normalized.provider === MODEL_PROVIDERS.OPENAI) {
    return `ChatGPT (${normalized.model})`;
  }
  return normalized.model;
}

function getAiOptionsSnapshot() {
  const ollamaSettings = getOllamaRuntimeSettingsSync();
  const openAiEnabled = isOpenAiConfigured();
  const openAiModel = openAiEnabled ? getDefaultOpenAiModel() : null;
  const ollamaModels = Array.isArray(ollamaSettings?.models)
    ? ollamaSettings.models.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];

  const catalog = [
    ...(openAiEnabled ? [{
      provider: MODEL_PROVIDERS.OPENAI,
      model: openAiModel,
      label: `ChatGPT (${openAiModel})`,
    }] : []),
    ...ollamaModels.map((model) => ({
      provider: MODEL_PROVIDERS.OLLAMA,
      model,
      label: model,
    })),
  ];

  return {
    catalog,
    openai: {
      enabled: openAiEnabled,
      model: openAiModel,
    },
    ollama: {
      default_connection_id: ollamaSettings?.default_connection_id || null,
      fallback_on_unavailable: ollamaSettings?.fallback_on_unavailable !== false,
      routing_strategy: ollamaSettings?.routing_strategy || 'least_loaded',
      models: ollamaModels,
      default_model: ollamaSettings?.default_model || null,
      connections: (ollamaSettings?.connections || [])
        .filter((connection) => connection.enabled !== false)
        .map((connection) => ({
          id: connection.id,
          name: connection.name,
          base_url: connection.base_url,
          default_model: connection.default_model || null,
        })),
    },
    default_selection: normalizeModelConfig(
      ollamaModels.length > 0
        ? {
            provider: MODEL_PROVIDERS.OLLAMA,
            model: ollamaSettings?.default_model || ollamaModels[0],
            ollama_server_id: ollamaSettings?.default_connection_id || null,
          }
        : (openAiEnabled ? {
            provider: MODEL_PROVIDERS.OPENAI,
            model: openAiModel,
          } : null),
      getDefaultModelConfig()
    ),
  };
}

module.exports = {
  MODEL_PROVIDERS,
  normalizeModelProvider,
  normalizeModelName,
  normalizeModelConfig,
  getAgentDefaultModelConfig,
  getDefaultModelConfig,
  getOllamaDefaultModelConfig,
  getAiOptionsSnapshot,
  formatModelDisplayLabel,
};
