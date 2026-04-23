const { getSetting, setSetting } = require('../database/db_app_settings');
const { encryptValue, decryptValue } = require('../utils/settingsCrypto');

const SETTINGS_KEYS = Object.freeze({
  portalAccess: 'portal_access',
  mcpRuntime: 'mcp_runtime',
  ollamaRuntime: 'ollama_runtime',
  openaiRuntime: 'openai_runtime',
  telegramRuntime: 'telegram_runtime',
});

const settingsCache = {
  portalAccess: null,
  mcpRuntime: null,
  ollamaRuntime: null,
  openaiRuntime: null,
  telegramRuntime: null,
};

const DEFAULT_ADMIN_GROUP = 'chrisbot.admin';
const DEFAULT_MCP_CLIENT_NAME = 'chrisbot';
const PORTAL_ACCESS_SENSITIVE_FIELDS = Object.freeze([
  'local_admin_password',
  'azure_client_secret',
]);
const SECRET_PLACEHOLDER_VALUES = new Set(['', '********', '••••••••']);

function normalizeGroupList(input, fallback = []) {
  const source = Array.isArray(input) ? input : String(input || '').split(',');
  const normalized = Array.from(
    new Set(
      source
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
  return normalized.length > 0 ? normalized : fallback;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return fallback;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function buildDefaultPortalAccessSettings() {
  const backendBaseUrl = String(
    process.env.PUBLIC_BACKEND_URL || `http://127.0.0.1:${process.env.PORT || 3000}`
  ).replace(/\/$/, '');
  const frontendBaseUrl = String(process.env.FRONTEND_BASE_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
  return {
    local_login_enabled: true,
    local_admin_username: '',
    local_admin_password: '',
    allowed_login_groups: [DEFAULT_ADMIN_GROUP],
    allowed_login_upns: [],
    super_admin_groups: [DEFAULT_ADMIN_GROUP],
    super_admin_upns: [],
    group_directory: [],
    azure_tenant_id: 'common',
    azure_client_id: '',
    azure_client_secret: '',
    azure_redirect_uri: `${backendBaseUrl}/api/auth/azure/callback`,
    backend_base_url: backendBaseUrl,
    frontend_base_url: frontendBaseUrl,
  };
}

function normalizeGroupDirectory(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const normalized = [];
  for (const entry of input) {
    const name = String(entry?.name || '').trim().toLowerCase();
    const objectId = String(entry?.object_id || '').trim().toLowerCase();
    if (!name || !objectId) continue;
    const key = `${name}::${objectId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ name, object_id: objectId });
  }
  return normalized;
}

function buildDefaultMcpRuntimeSettings() {
  return {
    client_name: DEFAULT_MCP_CLIENT_NAME,
    client_version: '1.0.0',
    protocol_version: '2025-11-25',
    tool_cache_ttl_ms: 300000,
    timeout_ms: 30000,
    unavailable_cooldown_ms: 60000,
    call_retry_base_ms: 1500,
    call_retry_max_ms: 30000,
    call_max_retries: 10,
    av_timeout_ms: 90000,
    connections: [],
  };
}

function buildDefaultOllamaRuntimeSettings() {
  return {
    timeout_ms: 1200000,
    fallback_on_unavailable: true,
    routing_strategy: 'least_loaded',
    default_connection_id: null,
    models: [],
    default_model: '',
    connections: [],
  };
}

function buildDefaultTelegramRuntimeSettings() {
  return {
    enabled: false,
    bot_token: '',
    polling_interval_ms: 3000,
  };
}

function buildDefaultOpenAiRuntimeSettings() {
  return {
    api_key: '',
    chat_model: 'gpt-5-mini',
  };
}

function normalizePortalAccessSettings(value) {
  const defaults = buildDefaultPortalAccessSettings();
  return {
    local_login_enabled: parseBoolean(value?.local_login_enabled, defaults.local_login_enabled),
    local_admin_username: String(value?.local_admin_username || '').trim(),
    local_admin_password: String(value?.local_admin_password || '').trim(),
    allowed_login_groups: normalizeGroupList(value?.allowed_login_groups, defaults.allowed_login_groups),
    allowed_login_upns: normalizeGroupList(value?.allowed_login_upns, defaults.allowed_login_upns),
    super_admin_groups: normalizeGroupList(value?.super_admin_groups, defaults.super_admin_groups),
    super_admin_upns: normalizeGroupList(value?.super_admin_upns, defaults.super_admin_upns),
    group_directory: normalizeGroupDirectory(value?.group_directory),
    azure_tenant_id: String(value?.azure_tenant_id || defaults.azure_tenant_id).trim() || defaults.azure_tenant_id,
    azure_client_id: String(value?.azure_client_id || '').trim(),
    azure_client_secret: String(value?.azure_client_secret || '').trim(),
    azure_redirect_uri: String(value?.azure_redirect_uri || defaults.azure_redirect_uri).trim() || defaults.azure_redirect_uri,
    backend_base_url: String(value?.backend_base_url || defaults.backend_base_url).trim().replace(/\/$/, '') || defaults.backend_base_url,
    frontend_base_url: String(value?.frontend_base_url || defaults.frontend_base_url).trim().replace(/\/$/, '') || defaults.frontend_base_url,
  };
}

function normalizeOpenAiRuntimeSettings(value) {
  const defaults = buildDefaultOpenAiRuntimeSettings();
  return {
    api_key: String(value?.api_key || '').trim(),
    chat_model: String(value?.chat_model || defaults.chat_model).trim() || defaults.chat_model,
  };
}

function deserializePortalAccessSettings(value) {
  if (!value || typeof value !== 'object') return value;
  const nextValue = { ...value };
  for (const field of PORTAL_ACCESS_SENSITIVE_FIELDS) {
    nextValue[field] = decryptValue(nextValue[field]);
  }
  return nextValue;
}

function serializePortalAccessSettings(value) {
  if (!value || typeof value !== 'object') return value;
  const nextValue = { ...value };
  for (const field of PORTAL_ACCESS_SENSITIVE_FIELDS) {
    nextValue[field] = encryptValue(nextValue[field]);
  }
  return nextValue;
}

function deserializeOpenAiRuntimeSettings(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    api_key: decryptValue(value.api_key),
  };
}

function serializeOpenAiRuntimeSettings(value) {
  if (!value || typeof value !== 'object') return value;
  return {
    ...value,
    api_key: encryptValue(value.api_key),
  };
}

function normalizeMcpConnection(connection, index) {
  const id = String(connection?.id || `conn_${index + 1}`).trim() || `conn_${index + 1}`;
  const headers = connection?.headers_json && typeof connection.headers_json === 'object'
    ? connection.headers_json
    : {};
  return {
    id,
    name: String(connection?.name || `MCP ${index + 1}`).trim() || `MCP ${index + 1}`,
    url: String(connection?.url || '').trim(),
    description: String(connection?.description || '').trim(),
    name_prefix: String(connection?.name_prefix || 'mcp_').trim() || 'mcp_',
    enabled: connection?.enabled !== false,
    headers_json: headers,
  };
}

function normalizeMcpRuntimeSettings(value) {
  const defaults = buildDefaultMcpRuntimeSettings();
  const sourceConnections = Array.isArray(value?.connections) && value.connections.length > 0
    ? value.connections
    : defaults.connections;
  return {
    client_name: String(value?.client_name || defaults.client_name).trim() || defaults.client_name,
    client_version: String(value?.client_version || defaults.client_version).trim() || defaults.client_version,
    protocol_version: String(value?.protocol_version || defaults.protocol_version).trim() || defaults.protocol_version,
    tool_cache_ttl_ms: parseInteger(value?.tool_cache_ttl_ms, defaults.tool_cache_ttl_ms),
    timeout_ms: parseInteger(value?.timeout_ms, defaults.timeout_ms),
    unavailable_cooldown_ms: parseInteger(value?.unavailable_cooldown_ms, defaults.unavailable_cooldown_ms),
    call_retry_base_ms: parseInteger(value?.call_retry_base_ms, defaults.call_retry_base_ms),
    call_retry_max_ms: parseInteger(value?.call_retry_max_ms, defaults.call_retry_max_ms),
    call_max_retries: parseInteger(value?.call_max_retries, defaults.call_max_retries),
    av_timeout_ms: parseInteger(value?.av_timeout_ms, defaults.av_timeout_ms),
    connections: sourceConnections
      .map(normalizeMcpConnection)
      .filter((connection) => connection.url),
  };
}

function normalizeOllamaConnection(connection, index) {
  const id = String(connection?.id || `ollama_${index + 1}`).trim() || `ollama_${index + 1}`;
  const priority = Number.parseInt(String(connection?.priority ?? index + 1), 10);
  return {
    id,
    name: String(connection?.name || `Ollama ${index + 1}`).trim() || `Ollama ${index + 1}`,
    base_url: String(connection?.base_url || '').trim().replace(/\/+$/, ''),
    default_model: String(connection?.default_model || '').trim(),
    enabled: connection?.enabled !== false,
    priority: Number.isFinite(priority) ? priority : (index + 1),
  };
}

function normalizeOllamaModelList(input, fallback = []) {
  const source = Array.isArray(input)
    ? input
    : String(input || '').split(/[\n,]+/);
  const normalized = [];
  const seen = new Set();

  for (const entry of source) {
    const model = String(entry || '').trim();
    if (!model) continue;
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(model);
  }

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeOllamaRuntimeSettings(value) {
  const defaults = buildDefaultOllamaRuntimeSettings();
  const legacyDefaultModels = ['qwen3.5', 'gpt-oss'];
  const rawModels = Array.isArray(value?.models) ? value.models : [];
  const normalizedRawModels = rawModels
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
  const hasLegacySeededModels = normalizedRawModels.length === legacyDefaultModels.length
    && legacyDefaultModels.every((model, index) => normalizedRawModels[index] === model)
    && String(value?.default_model || '').trim().toLowerCase() === 'qwen3.5'
    && (!Array.isArray(value?.connections) || value.connections.length === 0);
  const effectiveValue = hasLegacySeededModels
    ? {
      ...value,
      models: [],
      default_model: '',
    }
    : value;
  const sourceConnections = Array.isArray(value?.connections) && value.connections.length > 0
    ? value.connections
    : defaults.connections;
  const normalizedConnections = sourceConnections
    .map(normalizeOllamaConnection)
    .filter((connection) => connection.base_url)
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name, 'it'));
  const validIds = new Set(normalizedConnections.map((connection) => connection.id));
  const requestedDefaultId = String(effectiveValue?.default_connection_id || defaults.default_connection_id || '').trim() || null;
  const defaultConnectionId = requestedDefaultId && validIds.has(requestedDefaultId)
    ? requestedDefaultId
    : (normalizedConnections[0]?.id || null);
  const fallbackModels = Array.from(new Set([
    String(effectiveValue?.default_model || '').trim(),
    ...normalizedConnections.map((connection) => String(connection.default_model || '').trim()).filter(Boolean),
  ].filter(Boolean)));
  const requestedDefaultModel = String(effectiveValue?.default_model || '').trim();
  const normalizedModels = normalizeOllamaModelList(effectiveValue?.models, fallbackModels);
  const defaultModel = requestedDefaultModel && normalizedModels.some((model) => model.toLowerCase() === requestedDefaultModel.toLowerCase())
    ? normalizedModels.find((model) => model.toLowerCase() === requestedDefaultModel.toLowerCase())
    : (normalizedModels[0] || '');

  return {
    timeout_ms: parseInteger(value?.timeout_ms, defaults.timeout_ms),
    fallback_on_unavailable: value?.fallback_on_unavailable !== false,
    routing_strategy: String(value?.routing_strategy || defaults.routing_strategy).trim() === 'priority'
      ? 'priority'
      : 'least_loaded',
    default_connection_id: defaultConnectionId,
    models: normalizedModels,
    default_model: defaultModel,
    connections: normalizedConnections,
  };
}

function normalizeTelegramRuntimeSettings(value) {
  const defaults = buildDefaultTelegramRuntimeSettings();
  return {
    enabled: value?.enabled === true,
    bot_token: String(value?.bot_token || defaults.bot_token).trim(),
    polling_interval_ms: parseInteger(value?.polling_interval_ms, defaults.polling_interval_ms),
  };
}

function hasReplacementSecret(value) {
  const normalized = String(value ?? '').trim();
  return Boolean(normalized) && !SECRET_PLACEHOLDER_VALUES.has(normalized);
}

function preserveExistingSecrets(normalized, incoming, current, fields) {
  const nextValue = { ...normalized };
  for (const field of fields) {
    if (!hasReplacementSecret(incoming?.[field]) && current?.[field]) {
      nextValue[field] = current[field];
    }
  }
  return nextValue;
}

function redactPortalAccessSettings(value) {
  return {
    ...value,
    local_admin_password: '',
    local_admin_password_configured: Boolean(String(value?.local_admin_password || '').trim()),
    azure_client_secret: '',
    azure_client_secret_configured: Boolean(String(value?.azure_client_secret || '').trim()),
  };
}

function redactOpenAiRuntimeSettings(value) {
  return {
    ...value,
    api_key: '',
    api_key_configured: Boolean(String(value?.api_key || '').trim()),
  };
}

function redactMcpRuntimeSettings(value) {
  return {
    ...value,
    connections: (value?.connections || []).map((connection) => ({
      ...connection,
      headers_json: Object.fromEntries(
        Object.keys(connection?.headers_json || {}).map((key) => [key, ''])
      ),
      headers_configured: Object.fromEntries(
        Object.entries(connection?.headers_json || {}).map(([key, headerValue]) => [key, Boolean(String(headerValue || '').trim())])
      ),
    })),
  };
}

function redactTelegramRuntimeSettings(value) {
  return {
    ...value,
    bot_token: '',
    bot_token_configured: Boolean(String(value?.bot_token || '').trim()),
  };
}

function preserveMcpHeaderSecrets(normalized, incoming, current) {
  const currentById = new Map((current?.connections || []).map((connection) => [connection.id, connection]));
  const incomingById = new Map((incoming?.connections || []).map((connection) => [String(connection?.id || ''), connection]));
  return {
    ...normalized,
    connections: (normalized.connections || []).map((connection) => {
      const currentConnection = currentById.get(connection.id);
      const incomingConnection = incomingById.get(connection.id);
      const nextHeaders = { ...(connection.headers_json || {}) };
      for (const [key, currentValue] of Object.entries(currentConnection?.headers_json || {})) {
        const incomingValue = incomingConnection?.headers_json?.[key];
        if (!hasReplacementSecret(incomingValue) && String(currentValue || '').trim()) {
          nextHeaders[key] = currentValue;
        }
      }
      return {
        ...connection,
        headers_json: nextHeaders,
      };
    }),
  };
}

async function loadOrSeedSetting(settingKey, defaultBuilder, normalizer, options = {}) {
  const deserialize = typeof options.deserialize === 'function' ? options.deserialize : (input) => input;
  const serialize = typeof options.serialize === 'function' ? options.serialize : (input) => input;
  const existing = await getSetting(settingKey);
  if (!existing) {
    const defaults = normalizer(defaultBuilder());
    await setSetting(settingKey, serialize(defaults));
    return defaults;
  }
  const normalized = normalizer(deserialize(existing.value_json));
  const normalizedForStorage = serialize(normalized);
  if (JSON.stringify(normalizedForStorage) !== JSON.stringify(existing.value_json)) {
    await setSetting(settingKey, normalizedForStorage);
  }
  return normalized;
}

async function initializeAppSettings() {
  settingsCache.portalAccess = await loadOrSeedSetting(
    SETTINGS_KEYS.portalAccess,
    buildDefaultPortalAccessSettings,
    normalizePortalAccessSettings,
    {
      deserialize: deserializePortalAccessSettings,
      serialize: serializePortalAccessSettings,
    }
  );
  settingsCache.mcpRuntime = await loadOrSeedSetting(
    SETTINGS_KEYS.mcpRuntime,
    buildDefaultMcpRuntimeSettings,
    normalizeMcpRuntimeSettings
  );
  settingsCache.ollamaRuntime = await loadOrSeedSetting(
    SETTINGS_KEYS.ollamaRuntime,
    buildDefaultOllamaRuntimeSettings,
    normalizeOllamaRuntimeSettings
  );
  settingsCache.openaiRuntime = await loadOrSeedSetting(
    SETTINGS_KEYS.openaiRuntime,
    buildDefaultOpenAiRuntimeSettings,
    normalizeOpenAiRuntimeSettings,
    {
      deserialize: deserializeOpenAiRuntimeSettings,
      serialize: serializeOpenAiRuntimeSettings,
    }
  );
  settingsCache.telegramRuntime = await loadOrSeedSetting(
    SETTINGS_KEYS.telegramRuntime,
    buildDefaultTelegramRuntimeSettings,
    normalizeTelegramRuntimeSettings
  );
}

function getPortalAccessSettingsSync() {
  if (!settingsCache.portalAccess) {
    settingsCache.portalAccess = normalizePortalAccessSettings(buildDefaultPortalAccessSettings());
  }
  return settingsCache.portalAccess;
}

function getMcpRuntimeSettingsSync() {
  if (!settingsCache.mcpRuntime) {
    settingsCache.mcpRuntime = normalizeMcpRuntimeSettings(buildDefaultMcpRuntimeSettings());
  }
  return settingsCache.mcpRuntime;
}

function getOllamaRuntimeSettingsSync() {
  if (!settingsCache.ollamaRuntime) {
    settingsCache.ollamaRuntime = normalizeOllamaRuntimeSettings(buildDefaultOllamaRuntimeSettings());
  }
  return settingsCache.ollamaRuntime;
}

function getOpenAiRuntimeSettingsSync() {
  if (!settingsCache.openaiRuntime) {
    settingsCache.openaiRuntime = normalizeOpenAiRuntimeSettings(buildDefaultOpenAiRuntimeSettings());
  }
  return settingsCache.openaiRuntime;
}

function getTelegramRuntimeSettingsSync() {
  if (!settingsCache.telegramRuntime) {
    settingsCache.telegramRuntime = normalizeTelegramRuntimeSettings(buildDefaultTelegramRuntimeSettings());
  }
  return settingsCache.telegramRuntime;
}

async function updatePortalAccessSettings(nextValue) {
  const current = getPortalAccessSettingsSync();
  const normalized = preserveExistingSecrets(
    normalizePortalAccessSettings({ ...current, ...(nextValue || {}) }),
    nextValue || {},
    current,
    PORTAL_ACCESS_SENSITIVE_FIELDS
  );
  await setSetting(SETTINGS_KEYS.portalAccess, serializePortalAccessSettings(normalized));
  settingsCache.portalAccess = normalized;
  return normalized;
}

async function updateOpenAiRuntimeSettings(nextValue) {
  const current = getOpenAiRuntimeSettingsSync();
  const normalized = preserveExistingSecrets(
    normalizeOpenAiRuntimeSettings({ ...current, ...(nextValue || {}) }),
    nextValue || {},
    current,
    ['api_key']
  );
  await setSetting(SETTINGS_KEYS.openaiRuntime, serializeOpenAiRuntimeSettings(normalized));
  settingsCache.openaiRuntime = normalized;
  return normalized;
}

async function updateMcpRuntimeSettings(nextValue) {
  const current = getMcpRuntimeSettingsSync();
  const normalized = preserveMcpHeaderSecrets(
    normalizeMcpRuntimeSettings(nextValue),
    nextValue || {},
    current
  );
  await setSetting(SETTINGS_KEYS.mcpRuntime, normalized);
  settingsCache.mcpRuntime = normalized;
  return normalized;
}

async function updateOllamaRuntimeSettings(nextValue) {
  const normalized = normalizeOllamaRuntimeSettings(nextValue);
  await setSetting(SETTINGS_KEYS.ollamaRuntime, normalized);
  settingsCache.ollamaRuntime = normalized;
  return normalized;
}

async function updateTelegramRuntimeSettings(nextValue) {
  const current = getTelegramRuntimeSettingsSync();
  const normalized = preserveExistingSecrets(
    normalizeTelegramRuntimeSettings({ ...current, ...(nextValue || {}) }),
    nextValue || {},
    current,
    ['bot_token']
  );
  await setSetting(SETTINGS_KEYS.telegramRuntime, normalized);
  settingsCache.telegramRuntime = normalized;
  return normalized;
}

function getSettingsSnapshot(options = {}) {
  const redactSecrets = options.redactSecrets !== false;
  const portalAccess = getPortalAccessSettingsSync();
  const openAiRuntime = getOpenAiRuntimeSettingsSync();
  const telegramRuntime = getTelegramRuntimeSettingsSync();
  return {
    portal_access: redactSecrets ? redactPortalAccessSettings(portalAccess) : portalAccess,
    mcp_runtime: redactSecrets ? redactMcpRuntimeSettings(getMcpRuntimeSettingsSync()) : getMcpRuntimeSettingsSync(),
    ollama_runtime: getOllamaRuntimeSettingsSync(),
    openai_runtime: redactSecrets ? redactOpenAiRuntimeSettings(openAiRuntime) : openAiRuntime,
    telegram_runtime: redactSecrets ? redactTelegramRuntimeSettings(telegramRuntime) : telegramRuntime,
  };
}

module.exports = {
  initializeAppSettings,
  getPortalAccessSettingsSync,
  getMcpRuntimeSettingsSync,
  getOllamaRuntimeSettingsSync,
  getOpenAiRuntimeSettingsSync,
  getTelegramRuntimeSettingsSync,
  updatePortalAccessSettings,
  updateMcpRuntimeSettings,
  updateOllamaRuntimeSettings,
  updateOpenAiRuntimeSettings,
  updateTelegramRuntimeSettings,
  getSettingsSnapshot,
};
