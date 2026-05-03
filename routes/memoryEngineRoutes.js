const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireSuperAdmin } = require('../utils/adminAccess');
const { runBeforeMemory, runAfterMemory } = require('../services/memory/memoryOrchestrator');

router.use(authenticateToken);
router.use(requireSuperAdmin);

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

router.post('/get', async (req, res) => {
  try {
    const prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt richiesto.' });
    }
    const userMessage = buildUserMessage(prompt);
    const messages = [userMessage];
    const packet = await runBeforeMemory({
      agent: MEMORY_TEST_AGENT,
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
      items: packetToItems(packet, getRequesterLabel(req.user)),
    });
  } catch (error) {
    console.error('Errore Memory Engine getMemories:', error);
    return res.status(500).json({ error: error.message || 'Errore recupero memorie.' });
  }
});

router.post('/set', async (req, res) => {
  try {
    const prompt = normalizePrompt(req.body?.prompt);
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt richiesto.' });
    }
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
      agent: MEMORY_TEST_AGENT,
      chatId: null,
      messages,
      userMessage,
      assistantResponse,
      toolCalls: [],
      toolResults: [],
      userKey: getRequesterLabel(req.user),
      modelConfig: null,
    });

    return res.json({
      action: 'setMemories',
      prompt,
      packet,
      items: packetToItems(packet, getRequesterLabel(req.user)),
    });
  } catch (error) {
    console.error('Errore Memory Engine setMemories:', error);
    return res.status(500).json({ error: error.message || 'Errore salvataggio memorie.' });
  }
});

module.exports = router;
