const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireSuperAdmin } = require('../utils/adminAccess');
const { getAgentById } = require('../database/db_agents');
const { getMemoryEngineSettingsSync } = require('../services/appSettings');
const { runBeforeMemory, runAfterMemory } = require('../services/memory/memoryOrchestrator');
const { callMemoryChatText } = require('../services/memory/memoryModelRuntime');
const {
  createGraphDashboardSession,
  getLiveGraphSnapshot,
  requireGraphDashboardAccess,
} = require('../services/graphLiveService');

router.post('/graph/session', async (req, res) => {
  try {
    const session = createGraphDashboardSession(req.body?.password);
    return res.json(session);
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Accesso dashboard non riuscito.' });
  }
});

router.get('/graph/live', requireGraphDashboardAccess, async (req, res) => {
  try {
    const snapshot = await getLiveGraphSnapshot({
      engine: req.query.engine,
      limit: req.query.limit,
    });
    return res.json(snapshot);
  } catch (error) {
    console.error('Errore recupero grafo live:', error);
    return res.status(500).json({ error: error.message || 'Errore recupero grafo live' });
  }
});

const MEMORY_TEST_AGENT = {
  id: null,
  name: 'Memory Engine Access',
  slug: 'memory-engine-access',
  kind: 'worker',
  memory_engine_enabled: true,
  memory_scope: 'shared',
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

function normalizeMemoryScope(value) {
  return String(value || '').trim().toLowerCase() === 'dedicated' ? 'dedicated' : 'shared';
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
        id: `${section}-${index}`,
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
  const scope = normalizeMemoryScope(body.scope);
  if (scope !== 'dedicated') {
    return { ...MEMORY_TEST_AGENT, memory_scope: 'shared' };
  }

  const agentId = Number(body.agent_id || body.agentId);
  if (!Number.isFinite(agentId) || agentId <= 0) {
    const error = new Error('Agente richiesto per testare memorie dedicate.');
    error.status = 400;
    throw error;
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
    improve_memories_enabled: true,
    memory_scope: 'dedicated',
  };
}

function applySetStatuses(items = [], packet = {}) {
  const updatedCount = Number(packet?.embedding?.updated_items || 0);
  return items.map((item, index) => ({
    ...item,
    status: index < updatedCount ? 'updated' : 'added',
  }));
}

function countPacketItems(packet = {}) {
  return MEMORY_SECTIONS.reduce((counts, section) => {
    counts[section] = Array.isArray(packet?.[section]) ? packet[section].length : 0;
    return counts;
  }, {});
}

function hasWarning(packet = {}, text) {
  const needle = String(text || '').toLowerCase();
  return (Array.isArray(packet?.warnings) ? packet.warnings : [])
    .some((warning) => String(warning || '').toLowerCase().includes(needle));
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

function buildBeforeMemoryProcessLog({ prompt, agent, packet, generatedAnswer }) {
  const hasContext = Boolean(String(packet?.contextText || '').trim());
  const retrieval = packet?.retrieval || {};
  const warnings = Array.isArray(packet?.warnings) ? packet.warnings : [];
  return [
    buildLogStep('request', 'Richiesta test', 'completed', 'Prompt ricevuto dalla console Memory Engine.', {
      prompt,
      scope: packet?.scope || agent?.memory_scope || 'shared',
      agent: agent?.name || agent?.id || 'shared',
      agent_id: agent?.memory_scope === 'dedicated' ? agent?.id : null,
    }),
    buildLogStep(
      'before-start',
      'beforeMemory',
      packet?.enabled === false ? 'skipped' : 'completed',
      packet?.enabled === false
        ? `beforeMemory non eseguito: ${packet?.skipped_reason || 'disabilitato'}.`
        : 'beforeMemory ha analizzato richiesta, scope e agente.'
    ),
    buildLogStep('query-analysis', 'Analisi richiesta', packet?.request?.summary ? 'completed' : 'skipped', 'Generazione di sintesi, topic e query di retrieval.', {
      summary: packet?.request?.summary || retrieval.request_summary || null,
      topics: packet?.request?.topics || retrieval.topics || [],
      queries: retrieval.queries || [],
    }),
    buildLogStep(
      'retrieval',
      'Ricerca memorie',
      retrieval.embedding_error ? 'warning' : (packet?.skipped_reason === 'retrieval_error' ? 'error' : 'completed'),
      'Ricerca ibrida su embedding, match lessicale e relazioni Neo4j.',
      {
        candidate_count: retrieval.candidate_count || 0,
        embedding_provider: retrieval.embedding_provider || null,
        embedding_model: retrieval.embedding_model || null,
        embedding_error: retrieval.embedding_error || null,
      }
    ),
    buildLogStep(
      'compaction',
      'Compattazione contesto',
      hasContext ? 'completed' : 'skipped',
      hasContext
        ? 'Le memorie candidate sono state sintetizzate nel contextText.'
        : `Nessun contextText iniettabile${packet?.skipped_reason ? `: ${packet.skipped_reason}` : '.'}`,
      {
        selected_ids: retrieval.selected_ids || [],
        contextText: packet?.contextText || '',
      }
    ),
    buildLogStep(
      'injection',
      'Iniezione nel prompt',
      hasContext ? 'completed' : 'skipped',
      hasContext ? 'Il contextText e stato inserito nei messaggi della richiesta.' : 'Nessuna memoria e stata inserita nei messaggi.'
    ),
    buildLogStep(
      'llm-answer',
      'Risposta LLM di test',
      generatedAnswer?.error ? 'error' : (generatedAnswer?.text ? 'completed' : 'skipped'),
      generatedAnswer?.error
        ? 'La risposta LLM non e stata generata.'
        : (generatedAnswer?.text ? 'Risposta generata usando il contesto recuperato.' : 'Risposta non generata per assenza di contextText.'),
      {
        provider: generatedAnswer?.provider || null,
        model: generatedAnswer?.model || null,
        error: generatedAnswer?.error || null,
        skipped_reason: generatedAnswer?.skipped_reason || null,
      }
    ),
    ...(warnings.length > 0
      ? [buildLogStep('warnings', 'Warning', 'warning', 'Il processo ha prodotto avvisi non bloccanti.', { warnings })]
      : []),
  ];
}

function buildAfterMemoryProcessLog({ prompt, agent, packet, items }) {
  const embedding = packet?.embedding || {};
  const warnings = Array.isArray(packet?.warnings) ? packet.warnings : [];
  const itemCounts = countPacketItems(packet);
  return [
    buildLogStep('request', 'Richiesta test', 'completed', 'Prompt ricevuto come informazione candidata da salvare.', {
      prompt,
      scope: packet?.scope || agent?.memory_scope || 'shared',
      agent: agent?.name || agent?.id || 'shared',
      agent_id: agent?.memory_scope === 'dedicated' ? agent?.id : null,
    }),
    buildLogStep(
      'after-start',
      'afterMemory',
      packet?.enabled === false ? 'skipped' : 'completed',
      packet?.enabled === false
        ? `afterMemory non eseguito: ${packet?.skipped_reason || 'disabilitato'}.`
        : 'afterMemory ha preparato episodi, tool e candidate riutilizzabili.'
    ),
    buildLogStep('episodes', 'Salvataggio episodi', packet?.episodes?.saved ? 'completed' : 'skipped', 'Persistenza degli eventi immutabili della run di test.', {
      episodes_saved: packet?.episodes?.saved || 0,
      tool_uses_saved: packet?.episodes?.tools || 0,
    }),
    buildLogStep(
      'extraction',
      'Estrazione memorie',
      items.length > 0 ? 'completed' : 'skipped',
      items.length > 0
        ? 'Il modulo di estrazione ha prodotto memorie operative candidate.'
        : `Nessuna memoria riutilizzabile prodotta${packet?.skipped_reason ? `: ${packet.skipped_reason}` : '.'}`,
      {
        item_counts: itemCounts,
        total_items: items.length,
        request_summary: packet?.request?.summary || packet?.process?.request_summary || null,
        topics: packet?.request?.topics || packet?.process?.topics || [],
      }
    ),
    buildLogStep(
      'semantic-graph',
      'Collegamenti semantici',
      hasWarning(packet, 'grafo semantico') || hasWarning(packet, 'collegamento semantico') ? 'warning' : 'completed',
      'Aggiornamento di request, topic, tool e relazioni Neo4j collegate alle memorie.',
      {
        tool_sequence: packet?.process?.tool_sequence || [],
        reusable_info: packet?.process?.reusable_info || [],
      }
    ),
    buildLogStep(
      'embedding-upsert',
      'Embedding e upsert',
      hasWarning(packet, 'embedding/salvataggio') ? 'warning' : (embedding.saved_items || embedding.updated_items || embedding.unchanged_items ? 'completed' : 'skipped'),
      'Calcolo embedding e salvataggio della versione corrente dei MemoryItem.',
      {
        provider: embedding.provider || null,
        model: embedding.model || null,
        saved_items: embedding.saved_items || 0,
        updated_items: embedding.updated_items || 0,
        unchanged_items: embedding.unchanged_items || 0,
      }
    ),
    buildLogStep('classification', 'Esito set', items.length > 0 ? 'completed' : 'skipped', 'Classificazione visuale delle memorie restituite alla console.', {
      added: items.filter((item) => item.status === 'added').length,
      updated: items.filter((item) => item.status === 'updated').length,
      deleted: items.filter((item) => item.status === 'deleted').length,
      unchanged: items.filter((item) => item.status === 'unchanged').length,
    }),
    ...(warnings.length > 0
      ? [buildLogStep('warnings', 'Warning', 'warning', 'Il processo ha prodotto avvisi non bloccanti.', { warnings })]
      : []),
  ];
}

async function generateGetAnswer(messages = [], packet = {}) {
  const settings = getMemoryEngineSettingsSync();
  const contextText = String(packet?.contextText || '').trim();
  if (!contextText) {
    return {
      text: '',
      skipped_reason: 'no_memory_context',
    };
  }

  try {
    const text = await callMemoryChatText([
      {
        role: 'system',
        content: [
          'Sei un agente di test della console Memory Engine.',
          'Rispondi alla richiesta utente usando il Memory context gia inserito nei messaggi, se rilevante.',
          'Mantieni la risposta breve e pratica.',
        ].join('\n'),
      },
      ...messages,
    ], settings);
    return {
      text,
      provider: settings.analysis_model_provider || null,
      model: settings.analysis_model || null,
    };
  } catch (error) {
    return {
      text: '',
      error: String(error?.message || error),
    };
  }
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
    const generatedAnswer = await generateGetAnswer(messages, packet);

    return res.json({
      action: 'getMemories',
      prompt,
      packet,
      generated_answer: generatedAnswer,
      process_log: buildBeforeMemoryProcessLog({ prompt, agent, packet, generatedAnswer }),
      items: packetToItems(packet, getRequesterLabel(req.user)),
    });
  } catch (error) {
    console.error('Errore Memory Engine getMemories:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Errore recupero memorie.' });
  }
});

router.post('/set', async (req, res) => {
  try {
    const prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt richiesto.' });
    }
    const agent = await resolveMemoryTestAgent(req.body || {});
    const userMessage = buildUserMessage(prompt);
    const assistantResponse = [
      'Informazione operativa candidata dal test admin.',
      'Valuta se e solo se e riutilizzabile in run future:',
      prompt,
    ].join('\n');
    const messages = [
      userMessage,
      { role: 'assistant', content: assistantResponse },
    ];
    const packet = await runAfterMemory({
      agent,
      chatId: null,
      messages,
      userMessage,
      assistantResponse,
      toolCalls: [],
      toolResults: [],
      userKey: getRequesterLabel(req.user),
      modelConfig: null,
    });

    const items = applySetStatuses(packetToItems(packet, getRequesterLabel(req.user)), packet);

    return res.json({
      action: 'setMemories',
      prompt,
      packet,
      process_log: buildAfterMemoryProcessLog({ prompt, agent, packet, items }),
      items,
    });
  } catch (error) {
    console.error('Errore Memory Engine setMemories:', error);
    return res.status(error.status || 500).json({ error: error.message || 'Errore salvataggio memorie.' });
  }
});

module.exports = router;
