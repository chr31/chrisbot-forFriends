const { callMemoryChatJson } = require('./memoryModelRuntime');
const {
  buildAfterExtractionMessages,
  buildBeforeCompactionMessages,
  buildBeforeQueryMessages,
} = require('./memoryPromptBuilder');
const {
  MEMORY_TYPES,
  canonicalizeGraphKey,
  normalizeConfidence,
  normalizeImportance,
  normalizeMemoryType,
  normalizeSearchableText,
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

const MIN_MEMORY_CONFIDENCE = 0.7;
const MIN_DETERMINISTIC_CONTEXT_SCORE = 0.34;
const MAX_AFTER_MEMORY_CANDIDATES = 2;

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

function normalizeEntityCandidate(entry = {}) {
  const name = normalizeText(entry.topic || entry.name || '', 180);
  const description = normalizeText(entry.information || entry.description || '', 700);
  if (!name && !description) return null;
  const entityType = normalizeOperationalCategory(entry.entity_type || entry.category, 'entity');
  if (!entityType) return null;
  const topic = normalizeText(entry.topic || name, 180);
  const information = description ? `${name}: ${description}` : name;
  return {
    memory_type: 'entity',
    topic,
    information,
    category: entityType,
    confidence: normalizeConfidence(entry.confidence, 0.65),
    importance: normalizeImportance(entry.importance, 0.5),
  };
}

function normalizeGenericCandidate(entry = {}, memoryType) {
  const information = normalizeText(entry.information || '', 1200);
  if (!information) return null;
  const normalizedMemoryType = normalizeMemoryType(memoryType);
  const category = normalizeOperationalCategory(entry.category || entry.tool_name || '', normalizedMemoryType);
  if (!category) return null;
  const topic = normalizeText(entry.topic || entry.tool_name || category, 180);
  return {
    memory_type: normalizedMemoryType,
    topic,
    information,
    category,
    confidence: normalizeConfidence(entry.confidence, 0.65),
    importance: normalizeImportance(entry.importance, 0.5),
  };
}

function isStatusCheckRequest(text) {
  return /\b(controll|verific|monitor|check|status|stato|funzionando|funziona|working|operativo)\b/i.test(text)
    && /\b(se|stato|status|monitor|funzionando|funziona|working|operativo)\b/i.test(text);
}

function hasCurrentRunStatusShape(text) {
  return /\b(data corrente|current date|al momento|attual[ei]|ora|adesso|stato:\s*\w+|stato player|brano|artist[ao]|album|in riproduzione|funzionante|funziona correttamente|nessun errore|nessun problema|senza errori|play)\b/i.test(text);
}

function hasStableMappingShape(text) {
  return /\b(gestisce|usa|usare|chiamare|delegare|mapping|parametr[oi]|building|room|device|action|monitoring|endpoint|api|url|player|sorgente|servizio|service|stream|identificativ[oi])\b/i.test(text);
}

function stripTransientStatusDetails(text) {
  let sanitized = normalizeText(text || '', 1200);
  sanitized = sanitized
    .replace(/\s*\((?:stato|status|brano|artist[ao]|album)[^)]+\)/gi, '')
    .replace(/\b(?:stato|status)\s*:\s*[^,.;|)]+[,.;|)]?/gi, '')
    .replace(/\bbrano\s*:\s*[^,.;|)]+[,.;|)]?/gi, '')
    .replace(/\bartist[ao]\s*:\s*[^,.;|)]+[,.;|)]?/gi, '')
    .replace(/\balbum\s*:\s*[^,.;|)]+[,.;|)]?/gi, '')
    .replace(/\b(?:attivo|attiva)\s+e\s+in\s+riproduzione\b/gi, '')
    .replace(/\battiv[oaie]\b/gi, '')
    .replace(/\bin\s+riproduzione\b/gi, '')
    .replace(/\bfunzionante(?:\s+a\s+data\s+corrente)?\b/gi, '')
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—:]\s*$/g, '')
    .trim();
  return sanitized;
}

function sanitizeOperationalCandidate(candidate = {}, context = {}) {
  if (!candidate) return null;
  const requestText = normalizeText(context.requestText || '', 1200);
  const text = normalizeText(candidate.information || '', 1200);
  if (!text) return candidate;
  if (!isStatusCheckRequest(requestText) && !hasCurrentRunStatusShape(text)) return candidate;

  const cleaned = stripTransientStatusDetails(text);
  if (!cleaned || cleaned.length < 12) return candidate;

  const requestMentionsGreenhouse = /\bserra\b/i.test(requestText);
  const topicMentionsGreenhouse = /\bserra\b/i.test(candidate.topic || '');
  const informationMentionsGreenhouse = /\bserra\b/i.test(cleaned);
  const topic = normalizeText(candidate.topic || '', 180);
  let information = cleaned;
  if (requestMentionsGreenhouse && !topicMentionsGreenhouse && !informationMentionsGreenhouse) {
    information = `${information.replace(/[.;,]\s*$/, '')} nella serra`;
  }
  information = information
    .replace(/\s+([,.])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–—:]\s*$/g, '')
    .trim();

  return {
    ...candidate,
    information,
  };
}

function hasUserMarker(text) {
  return /\b(utente|user|persona)\b/i.test(text);
}

function isProbablyPersonalMemory(text) {
  if (!hasUserMarker(text)) return false;
  return /\b(preferenz[ae]|preferisc[eo]|tono|personalit[aà]|carattere|eta|et[aà]|indirizzo|telefono|famiglia|figli|moglie|marito|vive|abita|hobby|likes?|dislikes?)\b/i.test(text);
}

function isProbablyGenericOrTransient(text) {
  const normalized = String(text || '').trim();
  if (/^(l'utente|utente|the user|user)\s+(ha chiesto|chiede|vuole|vorrebbe|asked|requested|wants)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(questa conversazione|this conversation|in questa chat|current chat|messaggio corrente)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(oggi|domani|ieri|today|tomorrow|yesterday|tra poco|later today|adesso|ora)\b/i.test(normalized)) {
    return true;
  }
  if (/\b(data corrente|current date|a data corrente|brano attuale|artista attuale|album attuale)\b/i.test(normalized)) {
    return true;
  }
  return false;
}

function hasWorkflowShape(text) {
  return /\b(step|passaggi|procedura|workflow|prima|poi|infine|eseguire|verificare|riconciliare|assegnare)\b/i.test(text)
    || /\b\d+[.)]\s+\S+/.test(text);
}

function hasToolLessonShape(text) {
  return /\b(tool|api|endpoint|comando|parametr[oi]|errore|fallback|timeout|richiede|restituisce|fallisce)\b/i.test(text);
}

function hasStableOperationalEvidence(text) {
  return /\b(asset|device|dispositivo|servizio|service|endpoint|stream|id|identificativ[oi]|sensore|sensor|media_player|switch|relay|controller|host|url|fallback|parametr[oi])\b/i.test(text);
}

function isGenericToolRunStatus(candidate = {}) {
  const text = normalizeText([
    candidate.topic,
    candidate.information,
  ].filter(Boolean).join(' '), 1400);
  if (!/\b(tool|api|endpoint|comando|funzione|function)\b/i.test(text)) return false;
  const reportsOnlyRunOutcome = /\b(riuscit[oaie]|successo|success|completed|completat[oaie]|fallit[oaie]|failed|errore|error|funzionat[oaie]|eseguit[oaie])\b/i.test(text);
  if (!reportsOnlyRunOutcome) return false;
  return !hasStableOperationalEvidence(text);
}

function isRunOutcomeMemory(candidate = {}, context = {}) {
  const information = normalizeText(candidate.information || '', 1200);
  const combined = normalizeText([candidate.topic, information].filter(Boolean).join(' '), 1400);
  if (!combined) return false;

  if (candidate.memory_type === 'fact' && hasCurrentRunStatusShape(combined) && !hasStableMappingShape(combined)) {
    return true;
  }

  if (candidate.memory_type === 'tool_lesson' && hasCurrentRunStatusShape(combined)) {
    return !/\b(usare|chiamare|delegare|parametr[oi]|building|room|device|action|monitoring|endpoint|fallback|richiede)\b/i.test(combined);
  }

  return isStatusCheckRequest(context.requestText || '') && hasCurrentRunStatusShape(combined) && !hasStableMappingShape(combined);
}

function normalizeTopicKey(candidate = {}) {
  const subject = normalizeText(candidate.topic || '', 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (subject) return subject;

  return normalizeText(candidate.information || '', 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((term) => term.length >= 4)
    .slice(0, 6)
    .join(' ');
}

function contentTerms(candidate = {}) {
  return normalizeText([
    candidate.topic,
    candidate.information,
  ].filter(Boolean).join(' '), 1400)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((term) => term.length >= 4);
}

function areRelatedCandidates(left = {}, right = {}) {
  if (left.category && right.category && left.category !== right.category) return false;
  const leftTerms = new Set(contentTerms(left));
  const rightTerms = new Set(contentTerms(right));
  if (leftTerms.size === 0 || rightTerms.size === 0) return false;
  const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  return overlap >= 2 || (overlap >= 1 && (leftTerms.has('snipeit') || leftTerms.has('snipe')));
}

function getCandidatePriority(candidate = {}) {
  if (candidate.category === 'asset_context') return 0;
  if (candidate.category === 'service_context') return 1;
  if (candidate.memory_type === 'decision') return 2;
  if (candidate.memory_type === 'procedure') return 3;
  if (candidate.memory_type === 'tool_lesson') return 4;
  if (candidate.memory_type === 'entity') return 5;
  return 6;
}

function mergeSameTopicCandidates(candidates = [], context = {}) {
  const selected = [];
  const source = isStatusCheckRequest(context.requestText || '')
    ? collapseStatusCheckCandidates(candidates)
    : candidates;
  const sorted = [...source].sort((left, right) => {
    const priorityDelta = getCandidatePriority(left) - getCandidatePriority(right);
    if (priorityDelta !== 0) return priorityDelta;
    const importanceDelta = normalizeImportance(right.importance, 0) - normalizeImportance(left.importance, 0);
    if (importanceDelta !== 0) return importanceDelta;
    return normalizeConfidence(right.confidence, 0) - normalizeConfidence(left.confidence, 0);
  });

  for (const candidate of sorted) {
    const topicKey = normalizeTopicKey(candidate);
    if (!topicKey) continue;
    const existingIndex = selected.findIndex((existing) => (
      normalizeTopicKey(existing) === topicKey || areRelatedCandidates(existing, candidate)
    ));
    if (existingIndex < 0) {
      selected.push(candidate);
      continue;
    }

    const existing = selected[existingIndex];
    const existingContent = normalizeText(existing.information || '', 1200).toLowerCase();
    const nextContent = normalizeText(candidate.information || '', 1200).toLowerCase();
    const existingLooksShorter = existingContent.length <= nextContent.length;
    if (!existingLooksShorter && getCandidatePriority(candidate) <= getCandidatePriority(existing)) {
      selected[existingIndex] = candidate;
    }
  }

  return selected.slice(0, MAX_AFTER_MEMORY_CANDIDATES);
}

function getStatusCheckKeepScore(candidate = {}) {
  let score = 0;
  if (candidate.memory_type === 'entity') score += 6;
  if (candidate.memory_type === 'procedure') score += 5;
  if (candidate.memory_type === 'tool_lesson') score += 4;
  if (candidate.category === 'asset_context' || candidate.category === 'service_context') score += 3;
  if (hasStableMappingShape([candidate.topic, candidate.information].filter(Boolean).join(' '))) score += 4;
  if (hasCurrentRunStatusShape(candidate.information || '')) score -= 4;
  score += normalizeImportance(candidate.importance, 0) + normalizeConfidence(candidate.confidence, 0);
  return score;
}

function collapseStatusCheckCandidates(candidates = []) {
  const stable = candidates.filter((candidate) => !isRunOutcomeMemory(candidate, { requestText: 'status check' }));
  const source = stable.length > 0 ? stable : candidates;
  const sorted = [...source].sort((left, right) => getStatusCheckKeepScore(right) - getStatusCheckKeepScore(left));
  return sorted.slice(0, 1);
}

function isValidOperationalCandidate(candidate = {}, context = {}) {
  const information = normalizeText(candidate.information || '', 1200);
  if (!information) return false;
  if (candidate.confidence < MIN_MEMORY_CONFIDENCE) return false;
  if (candidate.memory_type === 'summary') return false;
  if (candidate.memory_type === 'action_history') return false;
  if (candidate.memory_type === 'procedure' && !hasWorkflowShape(information)) return false;
  if (candidate.memory_type === 'tool_lesson' && !hasToolLessonShape(information)) return false;
  if (isGenericToolRunStatus(candidate)) return false;
  if (isRunOutcomeMemory(candidate, context)) return false;
  if (isProbablyPersonalMemory(information)) return false;
  if (isProbablyGenericOrTransient(information)) return false;
  if (candidate.category === 'goal') return false;
  return true;
}

function normalizeMemoryCandidate(entry, memoryType, context = {}) {
  const rawNormalized = memoryType === 'entity'
    ? normalizeEntityCandidate(entry)
    : normalizeGenericCandidate(entry, memoryType);
  if (!rawNormalized) return null;
  if (rawNormalized.memory_type !== 'entity' && isRunOutcomeMemory(rawNormalized, context)) return null;
  const normalized = sanitizeOperationalCandidate(rawNormalized, context);
  if (!normalized) return null;
  if (!MEMORY_TYPES.includes(normalized.memory_type)) return null;
  if (!isValidOperationalCandidate(normalized, context)) return null;

  const searchable = normalizeSearchableText([
    normalized.memory_type,
    normalized.category,
    normalized.topic,
    normalized.information,
  ].filter(Boolean).join(' - '), 1800);
  if (searchable.length < 12) return null;

  return {
    ...normalized,
    scope: context.scope,
    agent_id: context.agentId || null,
    subject_key: canonicalizeGraphKey(entry.subject_key || entry.key || normalized.topic || normalized.category, normalized.topic),
    searchable_text: searchable,
  };
}

function flattenMemoryCandidates(parsed = {}, context = {}) {
  const candidates = [];
  const seen = new Set();
  const mapping = [
    ['facts', 'fact'],
    ['entities', 'entity'],
    ['procedures', 'procedure'],
    ['decisions', 'decision'],
    ['tool_lessons', 'tool_lesson'],
    ['summaries', 'summary'],
  ];

  for (const [key, memoryType] of mapping) {
    const values = Array.isArray(parsed?.[key]) ? parsed[key] : [];
    for (const value of values) {
      const candidate = normalizeMemoryCandidate(value, memoryType, context);
      if (!candidate) continue;
      const dedupeKey = [
        candidate.memory_type,
        candidate.category,
        candidate.topic,
        candidate.information,
      ].join('|').toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push(candidate);
    }
  }

  return mergeSameTopicCandidates(candidates, context);
}

async function extractMemoryUpdates({ settings, chat, agent, scope, agentId, processStatus }) {
  const parsed = await callMemoryChatJson(
    buildAfterExtractionMessages({ chat, agent, scope, processStatus }),
    settings
  );
  return {
    request_summary: normalizeText(parsed?.request_summary || parsed?.requestSummary || parsed?.summary || chat?.userMessage?.content || '', 220),
    topics: normalizeTopicEntries(parsed?.topics || parsed?.subjects || [], 'project_context', 6),
    candidates: flattenMemoryCandidates(parsed, {
      scope,
      agentId,
      requestText: chat?.userMessage?.content || '',
    }),
    warnings: arrayOfStrings(parsed?.warnings, 8),
  };
}

module.exports = {
  TYPE_TO_PACKET_KEY,
  analyzeRetrievalRequest,
  compactMemoryCandidates,
  extractMemoryUpdates,
  generateRetrievalQueries,
  normalizeTopicEntries,
};
