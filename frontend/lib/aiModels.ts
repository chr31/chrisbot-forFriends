export type ModelProvider = 'openai' | 'ollama';

export type ModelConfig = {
  provider: ModelProvider;
  model: string;
  ollama_server_id?: string | null;
};

export type ModelCatalogEntry = {
  provider: ModelProvider;
  model: string;
  label: string;
};

export type OllamaConnectionOption = {
  id: string;
  name: string;
  base_url: string;
  default_model?: string | null;
};

export type AiOptionsResponse = {
  catalog: ModelCatalogEntry[];
  default_selection: ModelConfig;
  openai: {
    enabled: boolean;
    model: string | null;
  };
  ollama: {
    default_connection_id: string | null;
    fallback_on_unavailable: boolean;
    routing_strategy: 'priority' | 'least_loaded' | string;
    models: string[];
    default_model: string | null;
    connections: OllamaConnectionOption[];
  };
};

export function normalizeModelConfig(input: Partial<ModelConfig> | null | undefined, fallback?: ModelConfig | null): ModelConfig {
  const provider = input?.provider === 'openai' ? 'openai' : input?.provider === 'ollama' ? 'ollama' : (fallback?.provider || 'ollama');
  const model = String(input?.model || fallback?.model || '').trim();
  return {
    provider,
    model,
    ollama_server_id: provider === 'ollama'
      ? (String(input?.ollama_server_id || fallback?.ollama_server_id || '').trim() || null)
      : null,
  };
}

export function encodeModelValue(config: Partial<ModelConfig> | null | undefined) {
  const normalized = normalizeModelConfig(config);
  return `${normalized.provider}:${normalized.model}`;
}

export function decodeModelValue(value: string, fallback?: ModelConfig | null) {
  const [providerRaw, ...modelParts] = String(value || '').split(':');
  return normalizeModelConfig({
    provider: providerRaw === 'openai' ? 'openai' : 'ollama',
    model: modelParts.join(':'),
  }, fallback);
}

export function getModelLabel(config: Partial<ModelConfig> | null | undefined) {
  const normalized = normalizeModelConfig(config);
  if (!normalized.model) return '';
  return normalized.provider === 'openai'
    ? `ChatGPT (${normalized.model})`
    : normalized.model;
}

export function buildModelOptions(catalog: ModelCatalogEntry[] | null | undefined, currentConfig?: Partial<ModelConfig> | null) {
  const options = new Map<string, ModelCatalogEntry>();
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    options.set(encodeModelValue(entry), entry);
  }
  const current = normalizeModelConfig(currentConfig);
  if (current.model) {
    const value = encodeModelValue(current);
    if (!options.has(value)) {
      options.set(value, {
        provider: current.provider,
        model: current.model,
        label: getModelLabel(current),
      });
    }
  }
  return Array.from(options.entries()).map(([value, entry]) => ({ value, ...entry }));
}
