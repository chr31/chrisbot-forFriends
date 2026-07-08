const { getMemoryEngineSettingsSync } = require('../appSettings');
const { createMem0Provider } = require('./providers/mem0Provider');
const { getMemoryChat, getMessageText } = require('./beforeMemory');

// La scrittura memorie gira solo se mem0 e attivo a portale e l'agente ha il
// flag "improve memories". mem0 estrae/deduplica/aggiorna internamente.
function shouldWriteMemory(agent, settings) {
  return Boolean(settings?.enabled && agent?.improve_memories_enabled);
}

function getAgentId(agent) {
  return agent?.id != null && String(agent.id).trim() ? String(agent.id) : null;
}

function extractResponseText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response.trim();
  if (typeof response === 'object') {
    const text = response.content || response.text || response.message || response.output || '';
    if (typeof text === 'string' && text.trim()) return text.trim();
    try {
      return JSON.stringify(response).trim();
    } catch (_) {
      return '';
    }
  }
  return String(response).trim();
}

// Costruisce il turno (user + assistant) da inviare a mem0 per l'estrazione.
function buildTurnMessages(input = {}) {
  const chat = getMemoryChat(input);
  const userText = getMessageText(chat?.userMessage || input.userMessage);
  const assistantText = extractResponseText(input.response);
  const messages = [];
  if (userText) messages.push({ role: 'user', content: userText });
  if (assistantText) messages.push({ role: 'assistant', content: assistantText });
  return messages;
}

async function afterMemory(input = {}) {
  const settings = getMemoryEngineSettingsSync();
  const agentId = getAgentId(input.agent);
  const result = {
    enabled: false,
    provider: 'mem0',
    agent_id: agentId,
    written: false,
    skipped_reason: null,
    warnings: [],
  };

  if (!shouldWriteMemory(input.agent, settings)) {
    result.skipped_reason = !settings?.enabled ? 'global_disabled' : 'agent_disabled';
    return result;
  }
  result.enabled = true;

  if (!agentId) {
    result.skipped_reason = 'missing_agent_id';
    result.warnings.push('agent_id mancante: impossibile definire lo scope mem0.');
    return result;
  }

  const messages = buildTurnMessages(input);
  if (!messages.length) {
    result.skipped_reason = 'empty_turn';
    return result;
  }

  try {
    const provider = createMem0Provider(settings);
    const scope = { agent_id: agentId };
    if (input.runId) scope.run_id = String(input.runId);
    await provider.add(messages, scope);
    result.written = true;
  } catch (error) {
    result.skipped_reason = 'add_error';
    result.warnings.push(`mem0 add fallita: ${error?.message || error}`);
  }
  return result;
}

module.exports = {
  afterMemory,
  buildTurnMessages,
  shouldWriteMemory,
};
