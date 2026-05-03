const { getMemoryEngineSettingsSync } = require('../appSettings');
const {
  buildEmptyMemoryContextPacket,
  formatMemoryContextPacket,
  hasMemoryContext,
  normalizeMemoryScope,
} = require('./memoryContextPacket');
const { analyzeRetrievalRequest, compactMemoryCandidates } = require('./memoryAnalyzer');
const { embedTexts } = require('./memoryEmbedding');
const { createMemoryRepository } = require('./repositories/memoryRepository');
const { normalizeAgentId } = require('./memorySchema');

function buildRetrievalTexts(chat = {}, queries = []) {
  const texts = [];
  for (const query of Array.isArray(queries) ? queries : []) {
    const cleanQuery = String(query || '').trim();
    if (cleanQuery) texts.push(cleanQuery);
  }
  const userText = String(chat?.userMessage?.content || '').trim();
  if (userText) texts.push(userText);
  return [...new Set(texts.map((text) => text.slice(0, 1000)))].slice(0, 5);
}

function buildRetrievalInputs(chat = {}, requestAnalysis = {}) {
  return [
    requestAnalysis.request_summary,
    ...(Array.isArray(requestAnalysis.topics) ? requestAnalysis.topics.map((topic) => topic.name || topic.key) : []),
    ...(Array.isArray(requestAnalysis.queries) ? requestAnalysis.queries : []),
  ].filter(Boolean);
}

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

async function beforeMemory(input = {}) {
  const chat = getMemoryChat(input);
  const settings = getMemoryEngineSettingsSync();
  const scope = normalizeMemoryScope(input.agent?.memory_scope);
  if (!shouldRunMemory(input.agent, settings)) {
    return buildEmptyMemoryContextPacket({
      agent: input.agent,
      enabled: false,
      scope,
      skipped_reason: !settings?.enabled ? 'global_disabled' : 'agent_disabled',
    });
  }

  const packet = buildEmptyMemoryContextPacket({
    agent: input.agent,
    enabled: true,
    scope,
  });
  const agentId = normalizeAgentId(packet.agent_id);
  packet.process = {
    user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
    agent: input.agent?.name || input.agent?.id || null,
    request: chat?.userMessage?.content || '',
    tool_sequence: ['memory_query_builder', 'memory_embedding', 'neo4j_search', 'memory_compaction'],
    status: 'running',
    reusable_info: [],
  };

  const requestAnalysis = await analyzeRetrievalRequest({ settings, chat });
  const queries = requestAnalysis.queries || [];
  packet.request = {
    summary: requestAnalysis.request_summary || '',
    topics: requestAnalysis.topics || [],
  };
  packet.process.request_summary = packet.request.summary;
  packet.process.topics = packet.request.topics;
  if (queries.length === 0) {
    packet.skipped_reason = 'no_retrieval_query';
    packet.process.status = 'skipped';
    return packet;
  }

  let embeddingResult;
  let embeddingError = null;
  let candidates;
  let repository;
  const retrievalInputs = buildRetrievalInputs(chat, requestAnalysis);
  const retrievalTexts = buildRetrievalTexts(chat, retrievalInputs.length > 0 ? retrievalInputs : queries);
  try {
    repository = createMemoryRepository(settings);
    try {
      embeddingResult = await embedTexts(retrievalInputs.length > 0 ? retrievalInputs.slice(0, 5) : queries, settings);
    } catch (error) {
      embeddingError = error;
      packet.warnings.push(`Embedding memoria non completato: ${error?.message || error}`);
    }
    candidates = await repository.searchContext({
      scope,
      agent_id: agentId,
      embeddings: embeddingResult?.embeddings || [],
      query_texts: retrievalTexts,
      limit: 14,
    });
  } catch (error) {
    packet.skipped_reason = 'retrieval_error';
    packet.process.status = 'failed';
    packet.warnings.push(`Retrieval memoria non completato: ${error?.message || error}`);
    return packet;
  }

  if (candidates.length === 0) {
    packet.skipped_reason = 'no_relevant_memory';
    packet.process.status = 'completed';
    packet.warnings.push('Nessuna memoria rilevante trovata.');
    return packet;
  }

  const compacted = await compactMemoryCandidates({ settings, chat, candidates, requestAnalysis });
  packet.facts = compacted.facts;
  packet.entities = compacted.entities;
  packet.procedures = compacted.procedures;
  packet.decisions = compacted.decisions;
  packet.tool_lessons = compacted.tool_lessons;
  packet.recent_actions = compacted.recent_actions;
  packet.summaries = compacted.summaries;
  packet.contextText = compacted.contextText;
  packet.retrieval = {
    queries,
    request_summary: requestAnalysis.request_summary || null,
    topics: requestAnalysis.topics || [],
    candidate_count: candidates.length,
    selected_ids: compacted.selected_ids,
    embedding_provider: embeddingResult?.provider || null,
    embedding_model: embeddingResult?.model || null,
    embedding_error: embeddingError ? String(embeddingError?.message || embeddingError) : null,
  };
  packet.process.status = 'completed';
  packet.process.reusable_info = candidates
    .map((candidate) => candidate.topic || candidate.information)
    .filter(Boolean)
    .slice(0, 8);

  const selectedIds = hasMemoryContext(packet)
    ? (compacted.selected_ids.length > 0
        ? compacted.selected_ids
        : candidates.slice(0, 6).map((candidate) => candidate.id))
    : [];
  try {
    await repository.touchMemoryItems(selectedIds);
  } catch (error) {
    packet.warnings.push(`Aggiornamento access_count memoria non completato: ${error?.message || error}`);
  }

  injectMemoryContext(chat.messages, packet);
  if (chat.sourceMessages && chat.sourceMessages !== chat.messages) {
    injectMemoryContext(chat.sourceMessages, packet);
  }
  return packet;
}

module.exports = {
  beforeMemory,
  getMemoryChat,
  injectMemoryContext,
  shouldRunMemory,
};
