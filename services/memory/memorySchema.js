const crypto = require('crypto');

const MEMORY_TYPES = [
  'fact',
  'entity',
  'procedure',
  'decision',
  'tool_lesson',
  'summary',
  'action_history',
];

const EPISODE_TYPES = [
  'run_process',
  'user_request',
  'assistant_response',
  'tool_call',
  'tool_result',
  'error',
];

const PROCESS_STATUSES = ['completed', 'failed', 'partial', 'skipped', 'unknown'];

function normalizeMemoryType(value, fallback = 'fact') {
  const normalized = String(value || '').trim().toLowerCase();
  return MEMORY_TYPES.includes(normalized) ? normalized : fallback;
}

function normalizeEpisodeType(value, fallback = 'run_process') {
  const normalized = String(value || '').trim().toLowerCase();
  return EPISODE_TYPES.includes(normalized) ? normalized : fallback;
}

function normalizeProcessStatus(value, fallback = 'unknown') {
  const normalized = String(value || '').trim().toLowerCase();
  return PROCESS_STATUSES.includes(normalized) ? normalized : fallback;
}

function normalizeUserKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.toLowerCase() === 'null' || normalized.toLowerCase() === 'undefined') {
    return null;
  }
  return normalized.slice(0, 255);
}

function normalizeAgentId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function normalizeConfidence(value, fallback = 0.6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeImportance(value, fallback = 0.5) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeText(value, maxLength = 4000) {
  const text = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function normalizeSearchableText(value, maxLength = 2000) {
  return normalizeText(value, maxLength);
}

function canonicalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function canonicalizeGraphKey(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_./:@-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const key = normalized || String(fallback || 'unknown').trim().toLowerCase();
  return key.slice(0, 180);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function buildRunKey(agentRunId) {
  const numeric = normalizeAgentId(agentRunId);
  return numeric ? `agent_run:${numeric}` : null;
}

function buildCanonicalMemoryKey(input = {}) {
  const topicKey = canonicalize(input.topic || '');
  const category = canonicalize(input.category || '');
  if (topicKey) {
    return sha256([
      normalizeMemoryType(input.memory_type || input.type),
      String(input.scope || 'shared').trim().toLowerCase(),
      normalizeAgentId(input.agent_id) || 'shared',
      category,
      topicKey,
    ].join('|'));
  }

  const parts = [
    normalizeMemoryType(input.memory_type || input.type),
    String(input.scope || 'shared').trim().toLowerCase(),
    normalizeAgentId(input.agent_id) || 'shared',
    category,
    canonicalize(input.information || input.searchable_text || ''),
  ];
  return sha256(parts.join('|'));
}

function buildScopedGraphKey(type, input = {}) {
  const graphType = canonicalizeGraphKey(type, 'node');
  const scope = String(input.scope || 'shared').trim().toLowerCase();
  const agentId = normalizeAgentId(input.agent_id) || 'shared';
  const key = canonicalizeGraphKey(input.key || input.topic || input.summary || input.name || input.information || '', 'unknown');
  return sha256([graphType, scope, agentId, key].join('|'));
}

function toJsonString(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function parseMaybeJson(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function isLikelyFailureText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  if (/\b(nessun|nessuna|senza|no)\s+(errore|error|errori|errors|timeout|problema|problemi)\b/i.test(text)) {
    return false;
  }
  if (/\b(non|no)\s+(sono\s+stati\s+)?(riscontrati|rilevati|trovati)\s+(errori|problemi)\b/i.test(text)) {
    return false;
  }
  if (/\b(ok|success|successful|completato|riuscito|funzionante|operativo)\b/i.test(text)
    && /\b(nessun|nessuna|senza|non\s+sono\s+stati)\b/i.test(text)) {
    return false;
  }
  return text.includes('errore')
    || text.includes('error')
    || text.includes('failed')
    || text.includes('exception')
    || text.includes('non riuscit');
}

module.exports = {
  MEMORY_TYPES,
  EPISODE_TYPES,
  PROCESS_STATUSES,
  buildCanonicalMemoryKey,
  buildRunKey,
  buildScopedGraphKey,
  canonicalizeGraphKey,
  isLikelyFailureText,
  normalizeAgentId,
  normalizeConfidence,
  normalizeEpisodeType,
  normalizeImportance,
  normalizeMemoryType,
  normalizeProcessStatus,
  normalizeSearchableText,
  normalizeText,
  normalizeUserKey,
  parseMaybeJson,
  sha256,
  toJsonString,
};
