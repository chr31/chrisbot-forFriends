const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireSuperAdmin } = require('../utils/adminAccess');
const { getAgentById } = require('../database/db_agents');
const { runBeforeMemory } = require('../services/memory/memoryOrchestrator');

const MEMORY_TEST_AGENT = {
  id: null,
  name: 'Memory Engine Access',
  slug: 'memory-engine-access',
  kind: 'worker',
  memory_engine_enabled: true,
};

const MEMORY_SECTIONS = [
  'facts',
  'entities',
  'procedures',
  'decisions',
  'tool_lessons',
  'recent_actions',
  'summaries',
];

const TOPIC_LABELS = {
  facts: 'informazione operativa',
  entities: 'entita operativa',
  procedures: 'procedura',
  decisions: 'decisione',
  tool_lessons: 'lezione tool',
  recent_actions: 'azione recente',
  summaries: 'sintesi',
};

router.use(authenticateToken);
router.use(requireSuperAdmin);

function normalizePrompt(value) {
  return String(value || '').trim();
}

function getRequesterLabel(user = {}) {
  return String(user?.name || user?.email || user?.oid || '').trim() || null;
}

function getDisplayContent(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function getMemoryTopic(value, section) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return getDisplayContent(value.topic || value.category || value.memory_type);
  }
  return TOPIC_LABELS[section] || section;
}

function getMemoryInformation(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return getDisplayContent(value.information || value.description || value.name || value);
  }
  return getDisplayContent(value);
}

function getRequestSummary(packet = {}) {
  return getDisplayContent(
    packet?.request?.summary
      || packet?.retrieval?.request_summary
      || packet?.process?.request_summary
      || ''
  );
}

function getRequestTopics(packet = {}) {
  const topics = packet?.request?.topics || packet?.retrieval?.topics || packet?.process?.topics || [];
  return (Array.isArray(topics) ? topics : [])
    .map((topic) => getDisplayContent(topic?.name || topic?.topic || topic?.key || topic))
    .filter(Boolean)
    .join(', ');
}

function packetToItems(packet = {}, fallbackUser = null) {
  const process = packet?.process || {};
  const items = [];
  for (const section of MEMORY_SECTIONS) {
    const values = Array.isArray(packet?.[section]) ? packet[section] : [];
    values.forEach((value, index) => {
      items.push({
        id: value && typeof value === 'object' && !Array.isArray(value) && value.id
          ? String(value.id)
          : `${section}-${index}`,
        user: process.user_key || fallbackUser || 'n/d',
        agent: process.agent || packet.agent_id || 'shared',
        topic: getMemoryTopic(value, section),
        information: getMemoryInformation(value),
      });
    });
  }
  if (items.length === 0 && String(packet?.contextText || '').trim()) {
    items.push({
      id: 'contextText',
      user: process.user_key || fallbackUser || 'n/d',
      agent: process.agent || packet.agent_id || 'shared',
      topic: 'contesto recuperato',
      information: String(packet.contextText).trim(),
    });
  }
  const requestSummary = getRequestSummary(packet);
  if (items.length === 0 && requestSummary) {
    items.push({
      id: 'request-summary',
      user: process.user_key || fallbackUser || 'n/d',
      agent: process.agent || packet.agent_id || 'shared',
      topic: getRequestTopics(packet) || 'richiesta',
      information: requestSummary,
    });
  }
  const warnings = Array.isArray(packet?.warnings) ? packet.warnings.filter(Boolean) : [];
  if (items.length === 0 && warnings.length > 0) {
    items.push({
      id: 'warnings',
      user: process.user_key || fallbackUser || 'n/d',
      agent: process.agent || packet.agent_id || 'shared',
      topic: 'warning',
      information: warnings.join('\n'),
    });
  }
  return items.slice(0, 3);
}

function buildUserMessage(prompt) {
  return { role: 'user', content: prompt };
}

async function resolveMemoryTestAgent(body = {}) {
  const agentId = Number(body.agent_id || body.agentId);
  if (!Number.isFinite(agentId) || agentId <= 0) {
    return { ...MEMORY_TEST_AGENT };
  }

  const agent = await getAgentById(Math.trunc(agentId));
  if (!agent) {
    const error = new Error('Agente non trovato per test memorie dedicate.');
    error.status = 404;
    throw error;
  }

  return {
    ...MEMORY_TEST_AGENT,
    id: agent.id,
    name: agent.name || `Agent ${agent.id}`,
    slug: agent.slug || MEMORY_TEST_AGENT.slug,
    kind: agent.kind || MEMORY_TEST_AGENT.kind,
    memory_engine_enabled: true,
  };
}

function buildLogStep(id, title, status, description, details = null) {
  return {
    id,
    title,
    status,
    description,
    details,
  };
}

function buildBeforeMemoryProcessLog({ prompt, agent, packet }) {
  const hasContext = Boolean(String(packet?.contextText || '').trim());
  const retrieval = packet?.retrieval || {};
  const warnings = Array.isArray(packet?.warnings) ? packet.warnings : [];
  return [
    buildLogStep('request', 'Richiesta test', 'completed', 'Prompt ricevuto dalla console Memory Engine.', {
      prompt,
      provider: packet?.provider || retrieval.provider || null,
      project_id: packet?.project_id || retrieval.project_id || null,
      agent: agent?.name || agent?.id || 'default',
      agent_id: agent?.id || null,
    }),
    buildLogStep(
      'before-start',
      'mem0 retrieval',
      packet?.enabled === false ? 'skipped' : 'completed',
      packet?.enabled === false
        ? `beforeMemory non eseguito: ${packet?.skipped_reason || 'disabilitato'}.`
        : 'beforeMemory ha eseguito la ricerca semantica su mem0.'
    ),
    buildLogStep('search', 'Search mem0', packet?.skipped_reason === 'retrieval_error' ? 'error' : 'completed', 'Ricerca semantica tramite API mem0.', {
      summary: packet?.request?.summary || retrieval.request_summary || null,
      project_id: retrieval.project_id || packet?.project_id || null,
      queries: retrieval.queries || [],
      search_result_count: retrieval.search_result_count || 0,
      hits: retrieval.hits || [],
      files_read: retrieval.files_read || [],
    }),
    buildLogStep(
      'structured-output',
      'availableMemories',
      hasContext ? 'completed' : 'skipped',
      hasContext
        ? 'L agente ha restituito output strutturato availableMemories.'
        : `Nessuna memoria disponibile${packet?.skipped_reason ? `: ${packet.skipped_reason}` : '.'}`,
      {
        availableMemories: packet?.contextText || '',
      }
    ),
    buildLogStep(
      'injection',
      'Iniezione nel prompt',
      hasContext ? 'completed' : 'skipped',
      hasContext ? 'Il contextText e stato inserito nei messaggi della richiesta.' : 'Nessuna memoria e stata inserita nei messaggi.'
    ),
    ...(warnings.length > 0
      ? [buildLogStep('warnings', 'Warning', 'warning', 'Il processo ha prodotto avvisi non bloccanti.', { warnings })]
      : []),
  ];
}

router.post('/get', async (req, res) => {
  try {
    const prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt richiesto.' });
    }
    const agent = await resolveMemoryTestAgent(req.body || {});
    const userMessage = buildUserMessage(prompt);
    const messages = [userMessage];
    const packet = await runBeforeMemory({
      agent,
      chatId: null,
      messages,
      userMessage,
      userKey: getRequesterLabel(req.user),
      modelConfig: null,
    });

    return res.json({
      action: 'getMemories',
      prompt,
      packet,
      generated_answer: null,
      process_log: buildBeforeMemoryProcessLog({ prompt, agent, packet }),
      items: packetToItems(packet, getRequesterLabel(req.user)),
    });
  } catch (error) {
    console.error('Errore Memory Engine getMemories:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Errore recupero memorie.' });
  }
});

module.exports = router;
