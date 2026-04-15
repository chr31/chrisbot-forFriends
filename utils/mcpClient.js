require('dotenv').config();

const axios = require('axios');
const { getMcpRuntimeSettingsSync } = require('../services/appSettings');
const { buildInternalToolRegistry } = require('../services/internalTools/registry');

const DEFAULT_TOOL_PREFIX = 'mcp_';

const DEFAULT_TOOL_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_UNAVAILABLE_COOLDOWN_MS = 60 * 1000;
const DEFAULT_AV_TOOL_TIMEOUT_MS = 90 * 1000;
const DEFAULT_CALL_RETRY_BASE_MS = 1500;
const DEFAULT_CALL_RETRY_MAX_MS = 30000;
const DEFAULT_CALL_MAX_RETRIES = 10;

let requestId = 1;
const endpointCooldowns = new Map();
const sessionsByEndpoint = new Map();
const endpointRetryTimers = new Map();
const endpointCallQueues = new Map();
let toolCache = { at: 0, tools: [], nameMap: new Map(), reverseNameMap: new Map(), endpointMap: new Map() };

function createEmptyRegistry() {
  return {
    at: 0,
    tools: [],
    nameMap: new Map(),
    reverseNameMap: new Map(),
    endpointMap: new Map(),
    handlerMap: new Map(),
    prefixes: new Set(),
  };
}

function mergeRegistries(...registries) {
  const merged = createEmptyRegistry();
  merged.at = Date.now();

  for (const registry of registries) {
    if (!registry) continue;

    for (const tool of registry.tools || []) {
      const name = tool?.function?.name || tool?.name;
      if (!name || merged.nameMap.has(name)) continue;
      merged.tools.push(tool);
    }

    for (const [key, value] of registry.nameMap || []) {
      if (!merged.nameMap.has(key)) merged.nameMap.set(key, value);
    }
    for (const [key, value] of registry.reverseNameMap || []) {
      if (!merged.reverseNameMap.has(key)) merged.reverseNameMap.set(key, value);
    }
    for (const [key, value] of registry.endpointMap || []) {
      if (!merged.endpointMap.has(key)) merged.endpointMap.set(key, value);
    }
    for (const [key, value] of registry.handlerMap || []) {
      if (!merged.handlerMap.has(key)) merged.handlerMap.set(key, value);
    }
    for (const prefix of registry.prefixes || []) {
      if (prefix) merged.prefixes.add(prefix);
    }
  }

  return merged;
}

function getInternalRegistry() {
  return buildInternalToolRegistry();
}

function getRuntimeConfig() {
  return getMcpRuntimeSettingsSync();
}

function getPrimaryPrefix() {
  const runtime = getRuntimeConfig();
  return runtime.connections?.[0]?.name_prefix || DEFAULT_TOOL_PREFIX;
}

function isEnabled() {
  const runtime = getRuntimeConfig();
  return Array.isArray(runtime.connections) && runtime.connections.some((connection) => connection.enabled !== false && connection.url);
}

function getToolsetEntries() {
  if (!isEnabled()) return [];
  const runtime = getRuntimeConfig();
  return (runtime.connections || [])
    .filter((connection) => connection && connection.enabled !== false && connection.url)
    .map((connection) => ({
      id: connection.id,
      url: String(connection.url),
      description: connection.description ? String(connection.description) : '',
      namePrefix: connection.name_prefix ? String(connection.name_prefix) : DEFAULT_TOOL_PREFIX,
      headers: connection.headers_json && typeof connection.headers_json === 'object' ? connection.headers_json : {},
    }));
}

function getCooldownMs() {
  const runtime = getRuntimeConfig();
  return Number.isFinite(runtime.unavailable_cooldown_ms)
    ? runtime.unavailable_cooldown_ms
    : DEFAULT_UNAVAILABLE_COOLDOWN_MS;
}

function getClientInfo() {
  const runtime = getRuntimeConfig();
  return {
    protocolVersion: runtime.protocol_version || '2025-11-25',
    clientName: runtime.client_name || 'chrisbot',
    clientVersion: runtime.client_version || '1.0.0',
  };
}

function getHeadersForEndpoint(endpoint) {
  const runtime = getRuntimeConfig();
  const connection = (runtime.connections || []).find((entry) => String(entry.url || '') === String(endpoint || ''));
  return connection?.headers_json && typeof connection.headers_json === 'object'
    ? connection.headers_json
    : {};
}

function getMcpConnectionStatuses() {
  return getToolsetEntries().map((entry) => {
    const cooldown = endpointCooldowns.get(entry.url);
    const hasSession = sessionsByEndpoint.has(entry.url);
    const isAvailable = isEndpointAvailable(entry.url);
    return {
      id: entry.id || entry.url,
      url: entry.url,
      name_prefix: entry.namePrefix,
      connected: Boolean(isAvailable && hasSession),
      available: Boolean(isAvailable),
      has_session: Boolean(hasSession),
      in_cooldown: Boolean(cooldown && cooldown.until && cooldown.until > Date.now()),
      cooldown_remaining_ms: getEndpointCooldownRemainingMs(entry.url),
      last_error: cooldown?.reason || null,
    };
  });
}

function clearEndpointRetry(endpoint) {
  const timer = endpointRetryTimers.get(endpoint);
  if (timer) clearTimeout(timer);
  endpointRetryTimers.delete(endpoint);
}

async function probeEndpointRecovery(endpoint) {
  const clientInfo = getClientInfo();
  const initializePayload = {
    jsonrpc: '2.0',
    id: requestId++,
    method: 'initialize',
    params: {
      protocolVersion: clientInfo.protocolVersion,
      capabilities: {},
      clientInfo: { name: clientInfo.clientName, version: clientInfo.clientVersion },
    },
  };

  const initResponse = await rawMcpPost(endpoint, initializePayload, { includeSession: false });
  if (initResponse.status >= 400) {
    throw new Error(`Initialize MCP fallita (${initResponse.status})`);
  }

  const initializedPayload = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  };
  const initializedResponse = await rawMcpPost(endpoint, initializedPayload, { includeSession: true });
  if (initializedResponse.status >= 400) {
    throw new Error(`Notifica initialized MCP fallita (${initializedResponse.status})`);
  }
}

function scheduleEndpointRetry(endpoint) {
  if (!endpoint || endpointRetryTimers.has(endpoint)) return;

  const timer = setTimeout(async () => {
    endpointRetryTimers.delete(endpoint);

    try {
      await probeEndpointRecovery(endpoint);
      endpointCooldowns.delete(endpoint);
      console.info(`Connessione MCP ripristinata verso ${endpoint}`);
      return;
    } catch (error) {
      console.warn(`Retry MCP fallito verso ${endpoint}:`, formatConnectionError(error));
      markEndpointUnavailable(endpoint, error);
    }
  }, getCooldownMs());

  endpointRetryTimers.set(endpoint, timer);
}

function markEndpointUnavailable(endpoint, error) {
  if (!endpoint) return;
  endpointCooldowns.set(endpoint, {
    until: Date.now() + getCooldownMs(),
    reason: error?.message || 'unavailable',
  });
  scheduleEndpointRetry(endpoint);
}

function isEndpointAvailable(endpoint) {
  if (!endpoint) return true;
  const entry = endpointCooldowns.get(endpoint);
  if (!entry) return true;
  if (Date.now() < entry.until) return false;
  endpointCooldowns.delete(endpoint);
  clearEndpointRetry(endpoint);
  return true;
}

function createUnavailableError(endpoint, error) {
  const err = new Error(`MCP_UNAVAILABLE: ${endpoint}`);
  err.code = 'MCP_UNAVAILABLE';
  if (error) err.cause = error;
  return err;
}

function getEndpointCooldownRemainingMs(endpoint) {
  if (!endpoint) return 0;
  const entry = endpointCooldowns.get(endpoint);
  if (!entry?.until) return 0;
  return Math.max(0, entry.until - Date.now());
}

function isEndpointUnavailableStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isConnectionError(error) {
  if (!error) return false;
  if (error.code) {
    return ['ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code);
  }
  const status = error.response?.status;
  return isEndpointUnavailableStatus(status);
}

function formatConnectionError(error) {
  if (!error) return 'Errore sconosciuto';
  const message = error.message || 'Errore MCP';
  const status = error.response?.status;
  const code = error.code;
  const details = [];
  if (code) details.push(`code=${code}`);
  if (status) details.push(`status=${status}`);
  return details.length > 0 ? `${message} (${details.join(', ')})` : message;
}

function isStreamAbortedError(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const message = String(error.message || '').toLowerCase();
  return code === 'ERR_BAD_RESPONSE' && message.includes('stream has been aborted');
}

function shouldRetryMcpCall(error) {
  if (!error) return false;

  if (error.code === 'MCP_UNAVAILABLE') return true;

  const message = String(error.message || '').toLowerCase();
  if (isMissingSessionMessage(message)) return true;

  if (message.includes('http 408') || message.includes('http 425') || message.includes('http 429')) return true;
  if (message.includes('http 500') || message.includes('http 502') || message.includes('http 503') || message.includes('http 504')) return true;
  if (message.includes('timeout') || message.includes('timed out')) return true;
  if (message.includes('stream has been aborted')) return true;

  return false;
}

function getCallRetryLimit() {
  const runtime = getRuntimeConfig();
  if (Number.isFinite(runtime.call_max_retries)) return runtime.call_max_retries;
  return DEFAULT_CALL_MAX_RETRIES;
}

function getRetryDelayMs(attemptIndex, endpoint) {
  const runtime = getRuntimeConfig();
  const base = Number.isFinite(runtime.call_retry_base_ms) ? runtime.call_retry_base_ms : DEFAULT_CALL_RETRY_BASE_MS;
  const max = Number.isFinite(runtime.call_retry_max_ms) ? runtime.call_retry_max_ms : DEFAULT_CALL_RETRY_MAX_MS;
  const expDelay = Math.min(max, base * (2 ** Math.max(0, attemptIndex - 1)));
  const cooldownDelay = getEndpointCooldownRemainingMs(endpoint);
  return Math.max(expDelay, cooldownDelay);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }
  if (!schema.type) schema.type = 'object';
  if (!schema.properties) schema.properties = {};
  return schema;
}

function buildToolDescription(tool, descriptionOverride) {
  const base = tool?.description ? String(tool.description).trim() : '';
  const override = descriptionOverride ? String(descriptionOverride).trim() : '';
  if (!override) return base;
  if (!base) return override;
  if (base.includes(override)) return base;
  return `${override} ${base}`;
}

function sanitizeFunctionName(rawName) {
  const normalized = String(rawName || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const fallback = normalized || 'tool';
  return fallback.slice(0, 64);
}

function buildUniqueFunctionName(baseName, usedNames) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  let attempt = 2;
  while (attempt < 10000) {
    const suffix = `_${attempt}`;
    const cut = Math.max(1, 64 - suffix.length);
    const candidate = `${baseName.slice(0, cut)}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    attempt += 1;
  }

  const forced = `${Date.now()}`.slice(-6);
  const fallback = `${baseName.slice(0, 57)}_${forced}`;
  usedNames.add(fallback);
  return fallback;
}

function parseSsePayload(raw) {
  const dataLines = String(raw)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(dataLines[i]);
    } catch {
      // continue
    }
  }

  return null;
}

function isMissingSessionMessage(message) {
  const lowered = String(message || '').toLowerCase();
  return lowered.includes('missing mcp session') || lowered.includes('invalid or missing mcp session');
}

function extractJsonRpc(responseData) {
  if (responseData && typeof responseData === 'object' && !Array.isArray(responseData)) {
    return responseData;
  }

  if (typeof responseData === 'string') {
    const trimmed = responseData.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed);
    } catch {
      return parseSsePayload(trimmed);
    }
  }

  return null;
}

function normalizeToolResult(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    return result
      .map((item) => {
        if (item && typeof item === 'object') {
          try {
            return JSON.stringify(item);
          } catch (_) {
            return String(item);
          }
        }
        return normalizeToolResult(item);
      })
      .filter(Boolean)
      .join('\n');
  }

  if (Array.isArray(result.content)) {
    const text = result.content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.text === 'string') return item.text;
      if (item && typeof item.data === 'string') return item.data;
      return JSON.stringify(item);
    }).join('\n');
    return result.isError ? `Errore MCP: ${text}` : text;
  }

  if (result.output) {
    return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  }

  if (result.error) {
    return `Errore MCP: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`;
  }

  return JSON.stringify(result);
}

async function rawMcpPost(endpoint, payload, { includeSession = true, timeoutMs } = {}) {
  const runtime = getRuntimeConfig();
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...getHeadersForEndpoint(endpoint),
  };

  if (includeSession) {
    const sessionId = sessionsByEndpoint.get(endpoint);
    if (sessionId) headers['mcp-session-id'] = sessionId;
  }

  const response = await axios.post(endpoint, payload, {
    headers,
    timeout: Number.isFinite(timeoutMs)
      ? timeoutMs
      : (Number.isFinite(runtime.timeout_ms) ? runtime.timeout_ms : DEFAULT_TIMEOUT_MS),
    responseType: 'text',
    transformResponse: [(data) => data],
    validateStatus: () => true,
  });

  const newSessionId = response.headers?.['mcp-session-id'];
  if (newSessionId) {
    sessionsByEndpoint.set(endpoint, newSessionId);
  }

  return response;
}

async function mcpRequest(method, params, { notification = false, url, includeSession = true, timeoutMs, allowSessionRecovery = true } = {}) {
  const endpoint = url || getToolsetEntries()[0]?.url || '';
  if (!endpoint) throw new Error('MCP non configurato: connessioni mancanti.');
  if (!isEndpointAvailable(endpoint)) throw createUnavailableError(endpoint);

  const payload = {
    jsonrpc: '2.0',
    method,
  };
  if (!notification) payload.id = requestId++;
  if (params !== undefined) payload.params = params;

  let response;
  try {
    response = await rawMcpPost(endpoint, payload, { includeSession, timeoutMs });
  } catch (error) {
    if (isStreamAbortedError(error)) {
      sessionsByEndpoint.delete(endpoint);
      try {
        response = await rawMcpPost(endpoint, payload, { includeSession: false, timeoutMs });
      } catch (retryError) {
        if (isConnectionError(retryError)) {
          console.warn(`Connessione MCP fallita verso ${endpoint}:`, formatConnectionError(retryError));
          markEndpointUnavailable(endpoint, retryError);
          throw createUnavailableError(endpoint, retryError);
        }
        throw retryError;
      }
    } else if (isConnectionError(error)) {
      console.warn(`Connessione MCP fallita verso ${endpoint}:`, formatConnectionError(error));
      markEndpointUnavailable(endpoint, error);
      throw createUnavailableError(endpoint, error);
    } else {
      throw error;
    }
  }

  if (notification) {
    if (response.status >= 400) {
      throw new Error(`Notifica MCP fallita (${response.status})`);
    }
    return null;
  }

  const jsonrpc = extractJsonRpc(response.data);
  if (response.status >= 400) {
    const msg = jsonrpc?.error?.message || `HTTP ${response.status}`;
    if (
      allowSessionRecovery &&
      includeSession &&
      !notification &&
      method !== 'initialize' &&
      isMissingSessionMessage(msg)
    ) {
      sessionsByEndpoint.delete(endpoint);
      await ensureInitialized(endpoint);
      return mcpRequest(method, params, {
        notification,
        url: endpoint,
        includeSession: true,
        timeoutMs,
        allowSessionRecovery: false,
      });
    }
    const error = new Error(msg);
    if (isEndpointUnavailableStatus(response.status)) {
      markEndpointUnavailable(endpoint, error);
      throw createUnavailableError(endpoint, error);
    }
    throw error;
  }

  if (!jsonrpc) {
    throw new Error('Risposta MCP non valida o vuota.');
  }

  if (jsonrpc.error) {
    throw new Error(jsonrpc.error.message || JSON.stringify(jsonrpc.error));
  }

  return jsonrpc.result;
}

async function ensureInitialized(endpointUrl) {
  if (!isEnabled() || !endpointUrl) return;
  if (!isEndpointAvailable(endpointUrl)) return;
  if (sessionsByEndpoint.has(endpointUrl)) return;
  const clientInfo = getClientInfo();

  await mcpRequest(
    'initialize',
    {
      protocolVersion: clientInfo.protocolVersion,
      capabilities: {},
      clientInfo: { name: clientInfo.clientName, version: clientInfo.clientVersion },
    },
    { url: endpointUrl, includeSession: false }
  );

  await mcpRequest('notifications/initialized', {}, { notification: true, url: endpointUrl });
}

async function listToolsFromServer(endpointUrl) {
  await ensureInitialized(endpointUrl);
  if (!isEndpointAvailable(endpointUrl)) return [];
  const result = await mcpRequest('tools/list', {}, { url: endpointUrl });
  if (Array.isArray(result?.tools)) return result.tools;
  if (Array.isArray(result)) return result;
  return [];
}

function buildToolDefinitions(tools, options = {}) {
  const nameMap = new Map();
  const reverseNameMap = new Map();
  const endpointMap = new Map();
  const handlerMap = new Map();
  const usedNames = new Set();
  const namePrefix = options.namePrefix || getPrimaryPrefix();
  const descriptionOverride = options.descriptionOverride || '';
  const endpointUrl = options.endpoint || null;

  const defs = tools
    .map((tool) => {
      if (!tool || !tool.name) return null;
      const rawName = `${namePrefix}${tool.name}`;
      const sanitizedBase = sanitizeFunctionName(rawName);
      const functionName = buildUniqueFunctionName(sanitizedBase, usedNames);
      nameMap.set(functionName, tool.name);
      reverseNameMap.set(tool.name, functionName);
      if (endpointUrl) endpointMap.set(functionName, endpointUrl);
      return {
        type: 'function',
        function: {
          name: functionName,
          description: buildToolDescription(tool, descriptionOverride),
          parameters: buildSchema(tool.inputSchema || tool.parameters),
        },
      };
    })
    .filter(Boolean);

  return { tools: defs, nameMap, reverseNameMap, endpointMap, handlerMap, prefixes: [namePrefix] };
}

async function refreshToolCache() {
  if (!isEnabled()) {
    toolCache = createEmptyRegistry();
    return toolCache;
  }

  const toolsets = getToolsetEntries();
  const nextCache = createEmptyRegistry();
  nextCache.at = Date.now();

  const results = await Promise.all(toolsets.map(async (toolset) => {
    try {
      const serverTools = await listToolsFromServer(toolset.url);
      return {
        toolset,
        registry: buildToolDefinitions(serverTools, {
          descriptionOverride: toolset.description,
          namePrefix: toolset.namePrefix,
          endpoint: toolset.url,
        }),
      };
    } catch (error) {
      console.error(`Errore nel recupero tools MCP (${toolset.url}):`, error.message);
      return null;
    }
  }));

  for (const entry of results) {
    if (!entry || !entry.registry) continue;

    const { registry, toolset } = entry;
    for (const tool of registry.tools) {
      const name = tool.function?.name || tool.name;
      if (!name) continue;

      if (nextCache.nameMap.has(name)) {
        console.warn(`Tool MCP duplicato ignorato (${name}) da ${toolset.url}`);
        continue;
      }

      nextCache.tools.push(tool);
      const originalName = registry.nameMap.get(name);
      if (originalName) {
        nextCache.nameMap.set(name, originalName);
        nextCache.reverseNameMap.set(originalName, name);
      }
      const endpoint = registry.endpointMap.get(name);
      if (endpoint) nextCache.endpointMap.set(name, endpoint);
    }
  }

  toolCache = nextCache;
  return toolCache;
}

async function reconnectAndRefreshToolCache() {
  if (!isEnabled()) {
    toolCache = createEmptyRegistry();
    return toolCache;
  }

  const toolsets = getToolsetEntries();
  for (const toolset of toolsets) {
    const endpoint = toolset?.url;
    if (!endpoint) continue;
    clearEndpointRetry(endpoint);
    endpointCooldowns.delete(endpoint);
    sessionsByEndpoint.delete(endpoint);
  }

  return refreshToolCache();
}

async function getMcpRegistry() {
  const internalRegistry = getInternalRegistry();
  if (!isEnabled()) {
    toolCache = createEmptyRegistry();
    return mergeRegistries(toolCache, internalRegistry);
  }

  const runtime = getRuntimeConfig();
  const ttl = Number.isFinite(runtime.tool_cache_ttl_ms) ? runtime.tool_cache_ttl_ms : DEFAULT_TOOL_CACHE_TTL_MS;
  if (toolCache.tools.length === 0 || Date.now() - toolCache.at > ttl) {
    await refreshToolCache();
  }
  return mergeRegistries(toolCache, internalRegistry);
}

function isMcpToolName(name) {
  const prefixes = [
    ...getToolsetEntries().map((entry) => entry.namePrefix).filter(Boolean),
    ...(getInternalRegistry().prefixes || []),
  ];
  return Boolean(name && prefixes.some((prefix) => String(name).startsWith(prefix)));
}

function stripMcpToolPrefix(name) {
  const prefixes = [
    ...getToolsetEntries().map((entry) => entry.namePrefix).filter(Boolean),
    ...(getInternalRegistry().prefixes || []),
  ];
  const matched = prefixes.find((prefix) => String(name || '').startsWith(prefix));
  return matched ? String(name).slice(matched.length) : name;
}

async function getMcpTools() {
  const registry = await getMcpRegistry();
  const tools = registry.tools || [];
  return tools.filter((tool) => {
    const name = tool.function?.name || tool.name;
    if (!name) return false;
    const endpoint = registry.endpointMap.get(name);
    return !endpoint || isEndpointAvailable(endpoint);
  });
}

async function listMcpToolMetadata() {
  const tools = await getMcpTools();
  return tools.map((tool) => ({
    name: tool.function?.name || tool.name,
    description: tool.function?.description || tool.description || '',
  }));
}

async function callMcpTool(name, args) {
  const registry = await getMcpRegistry();
  const prefixedName = registry.nameMap.has(name)
    ? name
    : registry.reverseNameMap.get(name) || `${getPrimaryPrefix()}${name}`;
  const internalHandler = registry.handlerMap.get(prefixedName);
  if (internalHandler) {
    return internalHandler(args || {});
  }

  const originalName = registry.nameMap.get(prefixedName) || stripMcpToolPrefix(name);
  const endpoint = registry.endpointMap.get(prefixedName) || getToolsetEntries()[0]?.url || '';

  if (!originalName) {
    throw new Error(`Tool MCP non riconosciuto: ${name}`);
  }

  const timeoutMs = originalName === 'AudioVideo_controlAndMonitoring'
    ? Number.parseInt(String(getRuntimeConfig().av_timeout_ms || ''), 10) || DEFAULT_AV_TOOL_TIMEOUT_MS
    : undefined;

  const previous = endpointCallQueues.get(endpoint) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const retryLimit = getCallRetryLimit();
      let attempt = 0;

      while (true) {
        attempt += 1;
        try {
          return await mcpRequest('tools/call', {
            name: originalName,
            arguments: args || {},
          }, { url: endpoint, timeoutMs });
        } catch (error) {
          const canRetry = shouldRetryMcpCall(error);
          const exceeded = retryLimit >= 0 && attempt > retryLimit;
          if (!canRetry || exceeded) throw error;

          const waitMs = getRetryDelayMs(attempt, endpoint);
          console.warn(
            `Tentativo MCP ${attempt} fallito per ${originalName} su ${endpoint}: ${formatConnectionError(error)}. Retry tra ${waitMs}ms`
          );
          await sleep(waitMs);
        }
      }
    });
  endpointCallQueues.set(endpoint, current);

  let result;
  try {
    result = await current;
  } finally {
    if (endpointCallQueues.get(endpoint) === current) {
      endpointCallQueues.delete(endpoint);
    }
  }

  if (result && typeof result === 'object' && (result.isError || result.error)) {
    const errorText = normalizeToolResult(result) || `Errore MCP durante l'esecuzione del tool ${originalName}`;
    throw new Error(errorText);
  }

  return normalizeToolResult(result);
}

module.exports = {
  getMcpTools,
  listMcpToolMetadata,
  reconnectAndRefreshToolCache,
  callMcpTool,
  getMcpConnectionStatuses,
  isMcpToolName,
  stripMcpToolPrefix,
};
