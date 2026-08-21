const { OpenAI } = require('openai');
const { getOllamaRuntimeSettingsSync } = require('./appSettings');

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    provider_type: connection.provider_type || 'ollama',
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

function resolveOllamaEmbeddingModel(model, fallbackModel) {
  return String(model || fallbackModel || '').trim();
}

function getConnectionProviderType(connection) {
  return String(connection?.provider_type || 'ollama').trim().toLowerCase() === 'exo' ? 'exo' : 'ollama';
}

function getEnabledConnections(providerType = null) {
  const requestedProvider = providerType ? getConnectionProviderType({ provider_type: providerType }) : null;
  const settings = getOllamaRuntimeSettingsSync();
  const allConnections = Array.isArray(settings?.connections) ? settings.connections : [];
  const enabledConnections = allConnections.filter((connection) => (
    connection.enabled !== false
    && connection.base_url
    && (!requestedProvider || getConnectionProviderType(connection) === requestedProvider)
  ));
  return {
    settings,
    allConnections,
    enabledConnections,
  };
}

function getOrderedCandidateConnections(ollamaServerId = null, providerType = 'ollama') {
  const localProviderType = getConnectionProviderType({ provider_type: providerType });
  const providerLabel = localProviderType === 'exo' ? 'EXO' : 'Ollama';
  const { settings, enabledConnections } = getEnabledConnections(localProviderType);
  if (enabledConnections.length === 0) {
    throw new Error(`Nessun server ${providerLabel} configurato nelle impostazioni.`);
  }

  const requestedId = String(ollamaServerId || '').trim();
  if (requestedId) {
    const preferred = enabledConnections.find((connection) => connection.id === requestedId);
    if (!preferred) {
      throw new Error(`Server ${providerLabel} non trovato o disabilitato: ${requestedId}`);
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
    const isExo = getConnectionProviderType(connection) === 'exo';
    const url = isExo
      ? `${normalizeBaseUrl(connection.base_url)}/v1/models`
      : `${normalizeBaseUrl(connection.base_url)}/api/ps`;
    const response = await fetch(url, {
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => ({}));
    const models = Array.isArray(payload?.models)
      ? payload.models
      : (Array.isArray(payload?.data) ? payload.data : []);
    status.available = true;
    status.current_load = models.length;
    status.load_level = isExo ? 'unknown' : getLoadLevel(models.length);
    status.active_models = models
      .map((entry) => String(entry?.name || entry?.id || '').trim())
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

function normalizeEmbeddingInputs(input) {
  const source = Array.isArray(input) ? input : [input];
  const normalized = source
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
  return value.map((entry) => Number(entry));
}

function normalizeEmbeddingResponse(payload, expectedCount) {
  if (Array.isArray(payload?.embeddings)) {
    if (payload.embeddings.length === expectedCount && payload.embeddings.every(isValidEmbeddingVector)) {
      return payload.embeddings.map(normalizeEmbeddingVector);
    }
  }

  if (isValidEmbeddingVector(payload?.embedding) && expectedCount === 1) {
    return [normalizeEmbeddingVector(payload.embedding)];
  }

  if (Array.isArray(payload?.data)) {
    const rawEmbeddings = payload.data
      .map((entry) => entry?.embedding)
      .filter(Boolean);
    if (rawEmbeddings.length === expectedCount && rawEmbeddings.every(isValidEmbeddingVector)) {
      return rawEmbeddings.map(normalizeEmbeddingVector);
    }
  }

  throw new Error('Risposta embedding Ollama non valida.');
}

async function postOllamaJson(connection, path, body, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${normalizeBaseUrl(connection.base_url)}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error || payload?.message || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchExoJson(connection, path, settings, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), settings.timeout_ms);
  try {
    const response = await fetch(`${normalizeBaseUrl(connection.base_url)}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload?.error?.message || payload?.error || payload?.detail || payload?.message || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getExoInstances(payload) {
  const instances = payload?.instances || payload?.state?.instances || payload;
  if (!instances || typeof instances !== 'object' || Array.isArray(instances)) return [];
  return Object.entries(instances).map(([id, instance]) => ({
    id,
    ...(instance && typeof instance === 'object' ? instance : {}),
  }));
}

function getExoInstanceCore(instance) {
  const candidate = instance?.instance && typeof instance.instance === 'object'
    ? instance.instance
    : instance;
  return unwrapExoTaggedValue(candidate).value;
}

function unwrapExoTaggedValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { type: '', value };
  }
  const explicitType = String(
    value.type
    || value.kind
    || value.tag
    || value.__type__
    || value.class
    || value.name
    || ''
  ).trim();
  if (explicitType) return { type: explicitType, value };

  const keys = Object.keys(value).filter((key) => key !== 'id');
  if (keys.length === 1 && value[keys[0]] && typeof value[keys[0]] === 'object') {
    return { type: keys[0], value: value[keys[0]] };
  }

  return { type: '', value };
}

function getExoTaggedType(value) {
  const unwrapped = unwrapExoTaggedValue(value);
  return String(
    unwrapped.type
    || ''
  ).trim().toLowerCase();
}

function getExoInstanceModelId(instance) {
  const core = getExoInstanceCore(instance);
  const shardModelId = getExoShardValues(core)
    .map((shard) => String(shard?.model_card?.model_id || shard?.modelCard?.modelId || '').trim())
    .find(Boolean);
  return String(
    core?.shard_assignments?.model_id
    || core?.shardAssignments?.modelId
    || shardModelId
    || core?.model_id
    || core?.model
    || ''
  ).trim();
}

function getExoInstanceMeta(instance) {
  const outerTaggedType = getExoTaggedType(instance);
  if (outerTaggedType.includes('mlxring')) return 'mlxring';
  if (outerTaggedType.includes('mlxjaccl')) return 'mlxjaccl';
  const core = getExoInstanceCore(instance);
  const taggedType = getExoTaggedType(core);
  if (taggedType.includes('mlxring')) return 'mlxring';
  if (taggedType.includes('mlxjaccl')) return 'mlxjaccl';
  return String(
    core?.instance_meta
    || core?.instanceMeta
    || core?.meta
    || ''
  ).trim().toLowerCase();
}

function getExoShardEntries(instance) {
  const core = getExoInstanceCore(instance);
  const runnerToShard = core?.shard_assignments?.runner_to_shard
    || core?.shardAssignments?.runnerToShard
    || {};
  if (!runnerToShard || typeof runnerToShard !== 'object') return [];
  return Object.values(runnerToShard)
    .filter((shard) => shard && typeof shard === 'object')
    .map(unwrapExoTaggedValue);
}

function getExoShardValues(instance) {
  return getExoShardEntries(instance).map((entry) => entry.value);
}

function getExoInstanceSharding(instance) {
  const core = getExoInstanceCore(instance);
  const shardTypes = getExoShardEntries(core)
    .map((entry) => String(entry.type || getExoTaggedType(entry.value)).trim().toLowerCase())
    .filter(Boolean);
  if (shardTypes.some((type) => type.includes('tensorshard'))) return 'tensor';
  if (shardTypes.length > 0 && shardTypes.every((type) => type.includes('pipelineshard'))) return 'pipeline';
  return String(
    core?.shard_assignments?.sharding
    || core?.shardAssignments?.sharding
    || core?.sharding
    || ''
  ).trim().toLowerCase();
}

function isExoMlxRingPipelineInstance(instance, model) {
  return getExoInstanceModelId(instance) === model
    && getExoInstanceMeta(instance) === 'mlxring'
    && getExoInstanceSharding(instance) === 'pipeline';
}

function getExoInstancesForModel(payload, model) {
  return getExoInstances(payload)
    .filter((instance) => getExoInstanceModelId(instance) === model);
}

function pickExoMlxRingPipelinePreview(previews) {
  return (Array.isArray(previews) ? previews : [])
    .find((preview) => (
      !preview?.error
      && preview?.instance
      && String(preview?.instance_meta || '').trim().toLowerCase() === 'mlxring'
      && String(preview?.sharding || '').trim().toLowerCase() === 'pipeline'
    ));
}

async function hasExoMlxRingPipelineInstance(connection, model, settings) {
  const state = await fetchExoJson(connection, '/state', settings);
  return getExoInstancesForModel(state, model).some((instance) => isExoMlxRingPipelineInstance(instance, model));
}

async function deleteExoInstance(connection, instanceId, settings) {
  await fetchExoJson(connection, `/instance/${encodeURIComponent(instanceId)}`, settings, {
    method: 'DELETE',
  });
}

async function removeNonPipelineExoInstances(connection, model, settings) {
  const state = await fetchExoJson(connection, '/state', settings);
  const staleInstances = getExoInstancesForModel(state, model)
    .filter((instance) => !isExoMlxRingPipelineInstance(instance, model));

  for (const instance of staleInstances) {
    await deleteExoInstance(connection, instance.id, settings);
  }

  if (staleInstances.length === 0) return;

  const deadline = Date.now() + Math.min(settings.timeout_ms, 15000);
  while (Date.now() < deadline) {
    await sleep(500);
    const nextState = await fetchExoJson(connection, '/state', settings);
    const remaining = getExoInstancesForModel(nextState, model)
      .some((instance) => !isExoMlxRingPipelineInstance(instance, model));
    if (!remaining) return;
  }

  throw new Error(`Timeout durante la rimozione delle istanze EXO non MlxRing/Pipeline per il modello ${model}.`);
}

async function ensureExoMlxRingPipelineInstance(connection, model, settings) {
  await removeNonPipelineExoInstances(connection, model, settings);
  if (await hasExoMlxRingPipelineInstance(connection, model, settings)) return;

  const previews = await fetchExoJson(
    connection,
    `/instance/previews?model_id=${encodeURIComponent(model)}`,
    settings
  );
  const selectedPreview = pickExoMlxRingPipelinePreview(previews?.previews);
  if (!selectedPreview) {
    throw new Error(`Nessun placement EXO MlxRing/Pipeline disponibile per il modello ${model}.`);
  }

  await fetchExoJson(connection, '/instance', settings, {
    method: 'POST',
    body: { instance: selectedPreview.instance },
  });

  const deadline = Date.now() + Math.min(settings.timeout_ms, 15000);
  while (Date.now() < deadline) {
    await sleep(500);
    if (await hasExoMlxRingPipelineInstance(connection, model, settings)) return;
  }

  throw new Error(`Timeout durante la creazione dell'istanza EXO MlxRing/Pipeline per il modello ${model}.`);
}

async function callOllamaEmbedEndpoint(connection, model, inputs, settings) {
  const payload = await postOllamaJson(connection, '/api/embed', {
    model,
    input: inputs.length === 1 ? inputs[0] : inputs,
  }, settings.timeout_ms);
  return normalizeEmbeddingResponse(payload, inputs.length);
}

async function callOllamaLegacyEmbeddingsEndpoint(connection, model, inputs, settings) {
  const embeddings = [];
  for (const input of inputs) {
    const payload = await postOllamaJson(connection, '/api/embeddings', {
      model,
      prompt: input,
    }, settings.timeout_ms);
    embeddings.push(...normalizeEmbeddingResponse(payload, 1));
  }
  return embeddings;
}

function shouldTryLegacyEmbeddingsEndpoint(error) {
  const status = Number(error?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  return status === 404
    || status === 405
    || message.includes('not found')
    || message.includes('unknown endpoint')
    || message.includes('method not allowed');
}

async function callOllamaEmbeddings(input, model, options = {}) {
  const settings = getOllamaRuntimeSettingsSync();
  const inputs = normalizeEmbeddingInputs(input);
  const baseCandidates = getOrderedCandidateConnections(options?.ollamaServerId || null, 'ollama');
  const candidates = await getRankedConnections(settings, baseCandidates);
  const attempts = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const connection = candidates[index];
    const runtimeDefaultModel = String(settings?.default_model || '').trim();
    const resolvedModel = resolveOllamaEmbeddingModel(model, connection.default_model || runtimeDefaultModel);
    if (!resolvedModel) {
      throw new Error('Modello embedding Ollama obbligatorio.');
    }

    try {
      let embeddings;
      try {
        embeddings = await callOllamaEmbedEndpoint(connection, resolvedModel, inputs, settings);
      } catch (error) {
        if (!shouldTryLegacyEmbeddingsEndpoint(error)) throw error;
        attempts.push({
          connection_id: connection.id,
          endpoint: '/api/embed',
          message: String(error?.message || error),
        });
        embeddings = await callOllamaLegacyEmbeddingsEndpoint(connection, resolvedModel, inputs, settings);
      }

      return {
        embeddings,
        connection: {
          id: connection.id,
          name: connection.name,
          base_url: connection.base_url,
          model: resolvedModel,
          fallback_index: index,
        },
        attempts,
      };
    } catch (error) {
      attempts.push({
        connection_id: connection.id,
        endpoint: 'embeddings',
        message: String(error?.message || error),
      });
      const canFallback = settings.fallback_on_unavailable !== false && index < candidates.length - 1;
      if (!canFallback || !isLikelyAvailabilityError(error)) {
        throw new Error(`Ollama Embeddings error su ${connection.name}: ${error?.message || error}`);
      }
    }
  }

  throw new Error('Tutti i server Ollama configurati risultano non disponibili per gli embedding.');
}

async function callOllamaChatCompletions(messages, tools = null, model, options = {}) {
  const settings = getOllamaRuntimeSettingsSync();
  const providerType = getConnectionProviderType({ provider_type: options?.providerType || options?.provider || 'ollama' });
  const providerLabel = providerType === 'exo' ? 'EXO' : 'Ollama';
  const baseCandidates = getOrderedCandidateConnections(options?.ollamaServerId || null, providerType);
  const candidates = await getRankedConnections(settings, baseCandidates);
  const attempts = [];

  for (let index = 0; index < candidates.length; index += 1) {
    const connection = candidates[index];
    const client = new OpenAI({
      baseURL: `${normalizeBaseUrl(connection.base_url)}/v1`,
      apiKey: providerType,
      timeout: settings.timeout_ms,
    });
    try {
      const runtimeDefaultModel = String(settings?.default_model || '').trim();
      const params = {
        model: providerType === 'exo'
          ? (String(model || runtimeDefaultModel || connection.default_model || '').trim() || 'qwen3.5')
          : resolveOllamaModelAlias(model, runtimeDefaultModel || connection.default_model),
        messages,
      };
      if (providerType === 'exo') {
        await ensureExoMlxRingPipelineInstance(connection, params.model, settings);
      }
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
        throw new Error(`${providerLabel} Chat Completions error su ${connection.name}: ${error?.message || error}`);
      }
    }
  }

  throw new Error(`Tutti i server ${providerLabel} configurati risultano non disponibili.`);
}

module.exports = {
  resolveOllamaModelAlias,
  resolveOllamaEmbeddingModel,
  getOllamaConnectionStatuses,
  getOrderedCandidateConnections,
  callOllamaChatCompletions,
  callOllamaEmbeddings,
  getLoadLevel,
};
