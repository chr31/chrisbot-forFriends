const { getMemoryEngineSettingsSync } = require('../appSettings');
const {
  buildEmptyMemoryContextPacket,
  formatMemoryContextPacket,
  hasMemoryContext,
} = require('./memoryContextPacket');
const { createMem0Provider } = require('./providers/mem0Provider');

const DEFAULT_MAX_INJECTED_CHARS = 4000;

// La lettura memorie gira solo se mem0 e attivo a portale e l'agente ha il flag.
function shouldRunMemory(agent, settings) {
  return Boolean(settings?.enabled && agent?.memory_engine_enabled);
}

function injectMemoryContext(messages, packet) {
  if (!Array.isArray(messages) || !hasMemoryContext(packet)) return messages;
  const contextBlock = formatMemoryContextPacket(packet);
  if (!contextBlock) return messages;

  const systemIndex = messages.findIndex((message) => message?.role === 'system');
  const memoryMessage = {
    role: 'system',
    content: contextBlock,
  };
  if (systemIndex < 0) {
    messages.unshift(memoryMessage);
    return messages;
  }
  messages.splice(systemIndex + 1, 0, memoryMessage);
  return messages;
}

function getMemoryChat(input = {}) {
  return input.chat && typeof input.chat === 'object'
    ? input.chat
    : {
        chatId: input.chatId || null,
        messages: input.messages,
        sourceMessages: input.messages,
        userMessage: input.userMessage || null,
      };
}

function getMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => (typeof item === 'string' ? item : item?.text || item?.content || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function uniqueStrings(values, limit) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const clean = String(value || '').trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(clean);
    if (limit && output.length >= limit) break;
  }
  return output;
}

function getAgentId(agent) {
  return agent?.id != null && String(agent.id).trim() ? String(agent.id) : null;
}

// mem0 e semantico: basta una query. Usa il messaggio utente, con fallback
// sull'ultimo turno utente presente nella history.
function buildRetrievalQuery(chat) {
  const userText = getMessageText(chat?.userMessage);
  if (userText) return userText.slice(0, 800);
  const messages = Array.isArray(chat?.sourceMessages || chat?.messages)
    ? (chat.sourceMessages || chat.messages)
    : [];
  const lastUser = [...messages].reverse().find((message) => String(message?.role || '').toLowerCase() === 'user');
  return getMessageText(lastUser).slice(0, 800);
}

// Retrocompatibilita: alcuni test/altri moduli si aspettano una lista di query.
function buildRetrievalQueries(chat) {
  const query = buildRetrievalQuery(chat);
  return query ? [query] : [];
}

function extractMemoryText(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  return String(item.memory || item.text || item.content || item.data || item.name || '').trim();
}

function buildContextText(facts, maxChars) {
  const budget = Math.max(500, Number(maxChars || DEFAULT_MAX_INJECTED_CHARS));
  const lines = [];
  let used = 0;
  for (const fact of facts) {
    const line = `- ${fact}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n').trim();
}

async function beforeMemory(input = {}) {
  const chat = getMemoryChat(input);
  const settings = getMemoryEngineSettingsSync();
  const agentId = getAgentId(input.agent);

  if (!shouldRunMemory(input.agent, settings)) {
    return buildEmptyMemoryContextPacket({
      agent: input.agent,
      enabled: false,
      provider: 'mem0',
      skipped_reason: !settings?.enabled ? 'global_disabled' : 'agent_disabled',
    });
  }

  const packet = buildEmptyMemoryContextPacket({
    agent: input.agent,
    enabled: true,
    provider: 'mem0',
  });
  const query = buildRetrievalQuery(chat);
  packet.request = {
    summary: getMessageText(chat?.userMessage).slice(0, 220),
    topics: [],
  };
  packet.retrieval = {
    provider: 'mem0',
    agent_id: agentId,
    query,
    search_result_count: 0,
    hits: [],
    injected: false,
  };

  if (!agentId) {
    packet.skipped_reason = 'missing_agent_id';
    packet.warnings.push('agent_id mancante: impossibile definire lo scope mem0.');
    return packet;
  }
  if (!query) {
    packet.skipped_reason = 'empty_query';
    return packet;
  }

  try {
    const provider = createMem0Provider(settings);
    const limit = Math.max(1, Number(settings.mem0_search_limit || 6));
    const results = await provider.search(query, { agent_id: agentId, limit });
    packet.retrieval.search_result_count = Array.isArray(results) ? results.length : 0;

    const memories = (Array.isArray(results) ? results : [])
      .map((item) => ({ text: extractMemoryText(item), score: Number(item?.score ?? 0) }))
      .filter((memory) => memory.text);

    packet.retrieval.hits = memories.slice(0, limit).map((memory) => ({
      snippet: memory.text.slice(0, 300),
      score: Number.isFinite(memory.score) ? memory.score : 0,
    }));
    packet.facts = uniqueStrings(memories.map((memory) => memory.text), limit);
    packet.contextText = buildContextText(packet.facts, settings.mem0_max_injected_chars);
    packet.retrieval.injected = Boolean(packet.contextText);
    if (!packet.contextText) packet.skipped_reason = 'no_memories';
  } catch (error) {
    packet.skipped_reason = 'retrieval_error';
    packet.warnings.push(`mem0 search fallita: ${error?.message || error}`);
  }

  injectMemoryContext(chat.messages, packet);
  if (chat.sourceMessages && chat.sourceMessages !== chat.messages) {
    injectMemoryContext(chat.sourceMessages, packet);
  }
  return packet;
}

module.exports = {
  beforeMemory,
  buildRetrievalQuery,
  buildRetrievalQueries,
  getMemoryChat,
  getMessageText,
  injectMemoryContext,
  shouldRunMemory,
};
