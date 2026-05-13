const { callMemoryChatJson } = require('./memoryModelRuntime');
const {
  buildBeforeCompactionMessages,
  buildBeforeQueryMessages,
} = require('./memoryPromptBuilder');
const {
  canonicalizeGraphKey,
  normalizeConfidence,
  normalizeImportance,
  normalizeMemoryType,
  normalizeText,
} = require('./memorySchema');

const TYPE_TO_PACKET_KEY = {
  fact: 'facts',
  entity: 'entities',
  procedure: 'procedures',
  decision: 'decisions',
  tool_lesson: 'tool_lessons',
  action_history: 'recent_actions',
  summary: 'summaries',
};

const MIN_DETERMINISTIC_CONTEXT_SCORE = 0.34;

const CATEGORY_BY_MEMORY_TYPE = {
  fact: 'project_context',
  entity: 'project_context',
  procedure: 'procedure',
  decision: 'decision',
  tool_lesson: 'tool_lesson',
  summary: 'conversation_summary',
  action_history: 'action_history',
};

const ALLOWED_CATEGORIES = new Set([
  'project_context',
  'tool_lesson',
  'procedure',
  'decision',
  'error',
  'conversation_summary',
  'action_history',
  'asset_context',
  'service_context',
]);

const CATEGORY_ALIASES = {
  agent: 'project_context',
  api: 'service_context',
  asset: 'asset_context',
  concept: 'project_context',
  container: 'service_context',
  database: 'service_context',
  endpoint: 'service_context',
  integration: 'service_context',
  project: 'project_context',
  repository: 'project_context',
  repo: 'project_context',
  service: 'service_context',
  tool: 'tool_lesson',
};

function arrayOfStrings(value, maxItems = 8) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => normalizeText(entry, 800))
    .filter(Boolean)
    .slice(0, maxItems);
}

function uniqueStrings(values = [], maxItems = 8) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = normalizeText(value, 1200);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
    if (result.length >= maxItems) break;
  }
  return result;
}

function fallbackRetrievalQueries(chat = {}) {
  const userText = normalizeText(chat?.userMessage?.content || '', 800);
  if (!userText) return [];
  return [userText];
}

function normalizeOperationalCategory(value, memoryType) {
  const normalized = normalizeText(value || '', 120).toLowerCase();
  if (normalized === 'goal' || normalized === 'goals') return null;
  if (CATEGORY_ALIASES[normalized]) return CATEGORY_ALIASES[normalized];
  if (ALLOWED_CATEGORIES.has(normalized)) return normalized;
  return CATEGORY_BY_MEMORY_TYPE[normalizeMemoryType(memoryType)] || 'project_context';
}

function normalizeTopicEntry(entry = {}, fallbackCategory = 'project_context') {
  const rawName = typeof entry === 'string'
    ? entry
    : entry.name || entry.topic || entry.key || entry.subject_key || '';
  const name = normalizeText(rawName, 180);
  if (!name) return null;
  const category = normalizeOperationalCategory(
    typeof entry === 'string' ? fallbackCategory : entry.category || entry.entity_type || fallbackCategory,
    fallbackCategory
  ) || fallbackCategory;
  return {
    name,
    key: canonicalizeGraphKey(typeof entry === 'string' ? name : entry.key || entry.subject_key || name, name),
    category,
  };
}

function normalizeTopicEntries(values = [], fallbackCategory = 'project_context', maxItems = 6) {
  const seen = new Set();
  const topics = [];
  for (const value of Array.isArray(values) ? values : []) {
    const topic = normalizeTopicEntry(value, fallbackCategory);
    if (!topic || seen.has(topic.key)) continue;
    seen.add(topic.key);
    topics.push(topic);
    if (topics.length >= maxItems) break;
  }
  return topics;
}

function normalizeRequestAnalysis(parsed = {}, chat = {}) {
  const fallbackRequest = normalizeText(chat?.userMessage?.content || '', 220);
  const requestSummary = normalizeText(
    parsed.request_summary || parsed.requestSummary || parsed.summary || fallbackRequest,
    220
  );
  const topics = normalizeTopicEntries(parsed.topics || parsed.subjects || [], 'project_context', 6);
  const queries = uniqueStrings([
    ...(Array.isArray(parsed.queries) ? parsed.queries : []),
    requestSummary,
    ...topics.map((topic) => topic.name),
  ], 5);
  return {
    request_summary: requestSummary,
    topics,
    queries: queries.length > 0 ? queries : fallbackRetrievalQueries(chat),
  };
}

async function analyzeRetrievalRequest({ settings, chat }) {
  try {
    const parsed = await callMemoryChatJson(buildBeforeQueryMessages({ chat }), settings);
    return normalizeRequestAnalysis(parsed, chat);
  } catch (error) {
    return normalizeRequestAnalysis({ queries: fallbackRetrievalQueries(chat) }, chat);
  }
}

async function generateRetrievalQueries({ settings, chat }) {
  const analysis = await analyzeRetrievalRequest({ settings, chat });
  return analysis.queries;
}

function getCandidateScore(candidate = {}) {
  const score = Number(candidate.score);
  return Number.isFinite(score) ? score : 0;
}

function isDeterministicContextCandidate(candidate = {}) {
  const score = getCandidateScore(candidate);
  const confidence = normalizeConfidence(candidate.confidence, 0);
  const importance = normalizeImportance(candidate.importance, 0);
  return score >= MIN_DETERMINISTIC_CONTEXT_SCORE
    || (score >= 0.28 && confidence >= 0.82 && importance >= 0.72);
}

function selectDeterministicCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter(isDeterministicContextCandidate)
    .slice(0, 6);
}

function buildDeterministicContext(candidates = []) {
  const grouped = new Map();
  for (const candidate of selectDeterministicCandidates(candidates)) {
    const key = TYPE_TO_PACKET_KEY[candidate.memory_type] || 'facts';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(normalizeText(candidate.information || candidate.searchable_text || '', 500));
  }

  const labels = {
    facts: 'Fatti',
    entities: 'Entita',
    procedures: 'Procedure',
    decisions: 'Decisioni',
    tool_lessons: 'Lezioni tool',
    recent_actions: 'Azioni recenti',
    summaries: 'Sintesi',
  };

  return [...grouped.entries()]
    .map(([key, values]) => `${labels[key] || key}:\n${values.map((value) => `- ${value}`).join('\n')}`)
    .join('\n\n');
}

function normalizeCompactionPacket(parsed = {}, candidates = []) {
  const candidateIds = new Set((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => String(candidate?.id || '').trim())
    .filter(Boolean));
  const contextText = normalizeText(parsed.contextText || parsed.context_text || '', 3000);
  const packet = {
    facts: arrayOfStrings(parsed.facts, 8),
    entities: arrayOfStrings(parsed.entities, 8),
    procedures: arrayOfStrings(parsed.procedures, 6),
    decisions: arrayOfStrings(parsed.decisions, 6),
    tool_lessons: arrayOfStrings(parsed.tool_lessons, 6),
    recent_actions: arrayOfStrings(parsed.recent_actions, 6),
    summaries: arrayOfStrings(parsed.summaries, 4),
    selected_ids: arrayOfStrings(parsed.selected_ids, 16)
      .filter((id) => candidateIds.size === 0 || candidateIds.has(id)),
    contextText,
  };
  if (candidateIds.size > 0 && packet.contextText && packet.selected_ids.length === 0) {
    packet.contextText = '';
  }
  if (!packet.contextText) {
    packet.contextText = buildDeterministicContext(candidates);
    packet.selected_ids = selectDeterministicCandidates(candidates)
      .map((candidate) => candidate.id)
      .filter(Boolean);
  }
  return packet;
}

async function compactMemoryCandidates({ settings, chat, candidates, requestAnalysis }) {
  const source = Array.isArray(candidates) ? candidates : [];
  if (source.length === 0) {
    return normalizeCompactionPacket({}, []);
  }

  try {
    const parsed = await callMemoryChatJson(buildBeforeCompactionMessages({ chat, candidates: source, requestAnalysis }), settings);
    return normalizeCompactionPacket(parsed, source);
  } catch (error) {
    return normalizeCompactionPacket({}, source);
  }
}

module.exports = {
  TYPE_TO_PACKET_KEY,
  analyzeRetrievalRequest,
  compactMemoryCandidates,
  generateRetrievalQueries,
  normalizeTopicEntries,
};
