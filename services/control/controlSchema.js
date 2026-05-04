const crypto = require('crypto');

const CONTROL_GRAPH_ID = 'control';
const CONTROL_GRAPH_KEY = 'chrisbot-actions';

const ACTION_TYPES = new Set(['bash', 'telnet', 'telnet_auth', 'ssh', 'ping', 'http', 'http_api']);
const ACTION_INTENTS = new Set(['control', 'monitoring']);
const RISK_LEVELS = new Set(['low', 'medium', 'high']);
const LOCATION_KINDS = new Set(['campus', 'building', 'floor', 'room', 'zone', 'location']);

function normalizeText(value, limit = 255) {
  return String(value || '').trim().slice(0, limit);
}

function normalizeKey(value, fallback = '') {
  const source = normalizeText(value || fallback, 255).toLowerCase();
  return source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
}

function stableHash(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

function buildControlId(kind, input = {}) {
  const explicit = normalizeText(input.id, 180);
  if (explicit) return explicit;
  const parts = [
    kind,
    input.building || input.building_name || '',
    input.room || input.room_name || '',
    input.device || input.device_name || '',
    input.name || input.action || input.command || '',
    input.ip || '',
    input.mac_address || input.macAddress || '',
  ].map((part) => normalizeKey(part)).filter(Boolean);
  const base = parts.join(':') || stableHash(JSON.stringify(input));
  return `control:${kind}:${base}`.slice(0, 240);
}

function buildCanonicalKey(kind, input = {}) {
  const parts = [
    kind,
    input.path || input.location_path || '',
    input.kind || input.location_kind || '',
    input.name || input.key || '',
    input.device_type || input.type || '',
    input.capability_key || input.capability || '',
    input.adapter_type || input.action_type || '',
    input.connection_ref || input.connectionRef || '',
    input.ip || '',
    input.mac_address || input.macAddress || '',
    input.command || '',
  ].map((part) => normalizeKey(part)).filter(Boolean);
  return parts.join(':').slice(0, 240) || `${normalizeKey(kind)}:${stableHash(JSON.stringify(input))}`;
}

function normalizeList(value, limit = 24) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const seen = new Set();
  const items = [];
  for (const entry of source) {
    const item = normalizeText(entry, 120);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

function normalizeActionType(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return ACTION_TYPES.has(normalized) ? normalized : 'bash';
}

function normalizeLocationKind(value) {
  const normalized = normalizeKey(value || 'location');
  return LOCATION_KINDS.has(normalized) ? normalized : 'location';
}

function normalizeIntent(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return ACTION_INTENTS.has(normalized) ? normalized : 'control';
}

function normalizeRiskLevel(value) {
  const normalized = normalizeText(value, 40).toLowerCase();
  return RISK_LEVELS.has(normalized) ? normalized : 'medium';
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

module.exports = {
  CONTROL_GRAPH_ID,
  CONTROL_GRAPH_KEY,
  ACTION_TYPES,
  buildControlId,
  buildCanonicalKey,
  normalizeActionType,
  normalizeIntent,
  normalizeKey,
  normalizeList,
  normalizeLocationKind,
  normalizeRiskLevel,
  normalizeText,
  parseBoolean,
};
