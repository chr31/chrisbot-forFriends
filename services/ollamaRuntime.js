const { OpenAI } = require('openai');
const { getOllamaRuntimeSettingsSync } = require('./appSettings');

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLikelyAvailabilityError(error) {
  const status = Number(error?.status || error?.code || 0);
  const message = String(error?.message || '').toLowerCase();
  return status === 408
    || status === 429
    || status >= 500
    || message.includes('timeout')
    || message.includes('econnrefused')
    || message.includes('fetch failed')
    || message.includes('network')
    || message.includes('socket hang up')
    || message.includes('connection');
}

function buildConnectionStatusShape(connection) {
  return {
    id: connection.id,
    name: connection.name,
    base_url: connection.base_url,
    enabled: connection.enabled !== false,
    available: false,
    current_load: null,
    load_level: 'unknown',
    active_models: [],
    last_error: null,
  };
}

function getLoadLevel(currentLoad) {
  if (!Number.isFinite(currentLoad) || currentLoad < 0) return 'unknown';
  if (currentLoad === 0) return 'idle';
  if (currentLoad <= 1) return 'low';
  if (currentLoad <= 3) return 'medium';
  return 'high';
}

function getProbeTimeoutMs(settings) {
  const configured = Number(settings?.probe_timeout_ms || 0);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return 5000;
}

function resolveOllamaModelAlias(model, fallbackModel) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized || normalized === 'ollama') {
    return fallbackModel || 'qwen3.5:9b';
  }
  if (normalized === 'gpt-oss') {
    return 'gpt-oss:20b';
  }
  if (normalized === 'qwen3.5') {
    return 'qwen3.5:9b';
  }
  return String(model || fallbackModel || 'qwen3.5:9b').trim() || 'qwen3.5:9b';
}

function getEnabledConnections() {
  const settings = getOllamaRuntimeSettingsSync();
  const allConnections = Array.isArray(settings?.connections) ? settings.connections : [];
  const enabledConnections = allConnections.filter((connection) => connection.enabled !== false && connection.base_url);
  return {
    settings,
    allConnections,
    enabledConnections,
  };
}

function getOrderedCandidateConnections(ollamaServerId = null) {
  const { settings, enabledConnections } = getEnabledConnections();
  if (enabledConnections.length === 0) {
    throw new Error('Nessun server Ollama configurato nelle impostazioni.');
  }

  const requestedId = String(ollamaServerId || '').trim();
  if (requestedId) {
    const preferred = enabledConnections.find((connection) => connection.id === requestedId);
    if (!preferred) {
      throw new Error(`Server Ollama non trovato o disabilitato: ${requestedId}`);
    }
    return [
      preferred,
      ...enabledConnections.filter((connection) => connection.id !== requestedId),
    ];
  }

  const defaultId = String(settings?.default_connection_id || '').trim();
  if (!defaultId) return enabledConnections;

  const preferred = enabledConnections.find((connection) => connection.id === defaultId);
  if (!preferred) return enabledConnections;

  return [
    preferred,
    ...enabledConnections.filter((connection) => connection.id !== defaultId),
  ];
}

async function probeSingleConnection(connection) {
  const status = buildConnectionStatusShape(connection);
  const settings = getOllamaRuntimeSettingsSync();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getProbeTimeoutMs(settings));
  try {
    const url = `${normalizeBaseUrl(connection.base_url)}/api/ps`;
    const response = await fetch(url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload?.models) ? payload.models : [];
    status.available = true;
    status.current_load = models.length;
    status.load_level = getLoadLevel(models.length);
    status.active_models = models
      .map((entry) => String(entry?.name || '').trim())
      .filter(Boolean);
  } catch (error) {
    status.last_error = String(error?.message || error);
  } finally {
    clearTimeout(timeoutId);
  }
  return status;
}

async function getOllamaConnectionStatuses() {
  const { allConnections } = getEnabledConnections();
  return Promise.all(allConnections.map((connection) => probeSingleConnection(connection)));
}

async function getRankedConnections(settings, candidates) {
  if (settings.routing_strategy !== 'least_loaded' || candidates.length <= 1) {
    return candidates;
  }

  const statuses = await Promise.all(candidates.map((connection) => probeSingleConnection(connection)));
  const ranked = candidates.map((connection, index) => ({
    connection,
    status: statuses[index],
  })).sort((left, right) => {
    if (left.status.available !== right.status.available) {
      return left.status.available ? -1 : 1;
    }
    const leftLoad = Number.isFinite(left.status.current_load) ? left.status.current_load : Number.MAX_SAFE_INTEGER;
    const rightLoad = Number.isFinite(right.status.current_load) ? right.status.current_load : Number.MAX_SAFE_INTEGER;
    if (leftLoad !== rightLoad) return leftLoad - rightLoad;
    return left.connection.priority - right.connection.priority || left.connection.name.localeCompare(right.connection.name, 'it');
  });
  return ranked.map((entry) => entry.connection);
}

async function callOllamaChatCompletions(messages, tools = null, model, options = {}) {
  const settings = getOllamaRuntimeSettingsSync();
  const baseCandidates = getOrderedCandidateConnections(options?.ollamaServerId || null);
  const candidates = await getRankedConnections(settings, baseCandidates);
  const attempts = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const connection = candidates[index];
    const client = new OpenAI({
      baseURL: `${normalizeBaseUrl(connection.base_url)}/v1`,
      apiKey: 'ollama',
      timeout: settings.timeout_ms,
    });
    try {
      const runtimeDefaultModel = String(settings?.default_model || '').trim();
      const params = {
        model: resolveOllamaModelAlias(model, runtimeDefaultModel || connection.default_model),
        messages,
      };
      if (tools) params.tools = tools;
      const response = await client.chat.completions.create(params);
      return {
        message: {
          ...response.choices?.[0]?.message,
          total_tokens: Number.isFinite(response?.usage?.total_tokens) ? response.usage.total_tokens : null,
        },
        connection: {
          id: connection.id,
          name: connection.name,
          base_url: connection.base_url,
          model: params.model,
          fallback_index: index,
        },
        attempts,
      };
    } catch (error) {
      attempts.push({
        connection_id: connection.id,
        message: String(error?.message || error),
      });
      const canFallback = settings.fallback_on_unavailable !== false && index < candidates.length - 1;
      if (!canFallback || !isLikelyAvailabilityError(error)) {
        throw new Error(`Ollama Chat Completions error su ${connection.name}: ${error?.message || error}`);
      }
    }
  }

  throw new Error('Tutti i server Ollama configurati risultano non disponibili.');
}

module.exports = {
  resolveOllamaModelAlias,
  getOllamaConnectionStatuses,
  getOrderedCandidateConnections,
  callOllamaChatCompletions,
  getLoadLevel,
};
