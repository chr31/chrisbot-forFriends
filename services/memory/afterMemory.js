const { getMemoryEngineSettingsSync } = require('../appSettings');
const { buildEmptyMemoryContextPacket, normalizeMemoryScope } = require('./memoryContextPacket');
const { extractMemoryUpdates, TYPE_TO_PACKET_KEY } = require('./memoryAnalyzer');
const { embedTexts } = require('./memoryEmbedding');
const { createMemoryRepository } = require('./repositories/memoryRepository');
const {
  isLikelyFailureText,
  canonicalizeGraphKey,
  normalizeAgentId,
  normalizeProcessStatus,
  normalizeText,
  parseMaybeJson,
  toJsonString,
} = require('./memorySchema');

function shouldRunMemory(agent, settings) {
  return Boolean(settings?.enabled && agent?.improve_memories_enabled);
}

function getMemoryChat(input = {}) {
  return input.chat && typeof input.chat === 'object'
    ? input.chat
    : {
        chatId: input.chatId || null,
        messages: input.messages,
        userMessage: input.userMessage || null,
        assistantResponse: input.assistantResponse || '',
        toolCalls: input.toolCalls || [],
        toolResults: input.toolResults || [],
      };
}

function getToolName(toolCall = {}) {
  return normalizeText(toolCall?.function?.name || toolCall?.name || 'unknown_tool', 255);
}

function getToolArguments(toolCall = {}) {
  const raw = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
  return parseMaybeJson(raw, raw || {});
}

function getToolResultStatus(result = {}) {
  const content = String(result?.content || '');
  return isLikelyFailureText(content) ? 'failed' : 'completed';
}

function findLatestUserMessage(chat = {}) {
  if (chat.userMessage?.content) return chat.userMessage;
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return messages[index];
  }
  return null;
}

function buildEpisodeBase({ input, chat, scope, scopedAgentId, processStatus }) {
  return {
    scope,
    agent_id: scopedAgentId,
    actor_agent_id: normalizeAgentId(input.agent?.id),
    agent_name: input.agent?.name || null,
    actor_agent_name: input.agent?.name || null,
    user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
    chat_id: chat.chatId || chat.chat_id || input.chatId || null,
    agent_run_id: input.runId || input.run_id || chat.runId || chat.run_id || null,
    process_status: processStatus,
  };
}

function buildAfterMemoryEpisodes({ input, chat, scope, scopedAgentId, processStatus }) {
  const base = buildEpisodeBase({ input, chat, scope, scopedAgentId, processStatus });
  const episodes = [];
  const userMessage = findLatestUserMessage(chat);
  const requestText = normalizeText(userMessage?.content || '', 2000);
  const assistantResponse = normalizeText(chat.assistantResponse || input.assistantResponse || '', 4000);
  const errorText = normalizeText(input.error?.message || input.error || chat.error?.message || chat.error || '', 2000);
  const toolCalls = Array.isArray(chat.toolCalls) ? chat.toolCalls : [];
  const toolResults = Array.isArray(chat.toolResults) ? chat.toolResults : [];
  const resultById = new Map(toolResults.map((result) => [String(result.tool_call_id || ''), result]));
  const toolNames = toolCalls.map(getToolName).filter(Boolean);

  if (requestText || toolNames.length > 0 || assistantResponse || errorText) {
    episodes.push({
      ...base,
      episode_type: 'run_process',
      content: [
        requestText ? `Richiesta: ${requestText}` : null,
        toolNames.length > 0 ? `Tool: ${toolNames.join(' -> ')}` : 'Tool: nessuno',
        `Esito: ${processStatus}`,
        assistantResponse ? `Risposta: ${normalizeText(assistantResponse, 1200)}` : null,
        errorText ? `Errore: ${normalizeText(errorText, 1200)}` : null,
      ].filter(Boolean).join('\n'),
      request_text: requestText,
      result_text: normalizeText(assistantResponse || errorText, 1600),
      metadata_json: {
        tool_sequence: toolNames,
        tool_count: toolNames.length,
      },
    });
  }

  if (requestText) {
    episodes.push({
      ...base,
      episode_type: 'user_request',
      content: requestText,
      request_text: requestText,
    });
  }

  for (const toolCall of toolCalls) {
    const toolName = getToolName(toolCall);
    const toolCallId = String(toolCall?.id || '').trim();
    episodes.push({
      ...base,
      episode_type: 'tool_call',
      content: `${toolName}: ${toJsonString(getToolArguments(toolCall)) || '{}'}`,
      metadata_json: {
        tool_name: toolName,
        tool_call_id: toolCallId || null,
        arguments: getToolArguments(toolCall),
      },
    });

    const result = resultById.get(toolCallId);
    if (result) {
      episodes.push({
        ...base,
        episode_type: 'tool_result',
        process_status: getToolResultStatus(result),
        content: normalizeText(result.content || '', 4000),
        result_text: normalizeText(result.content || '', 1600),
        metadata_json: {
          tool_name: toolName,
          tool_call_id: toolCallId || null,
        },
      });
    }
  }

  if (assistantResponse) {
    episodes.push({
      ...base,
      episode_type: 'assistant_response',
      content: assistantResponse,
      result_text: normalizeText(assistantResponse, 1600),
    });
  }

  if (errorText) {
    episodes.push({
      ...base,
      episode_type: 'error',
      process_status: 'failed',
      content: errorText,
      result_text: errorText,
      metadata_json: {
        error: errorText,
      },
    });
  }

  return episodes;
}

async function persistEpisodes(repository, episodes = []) {
  const saved = [];
  for (const episode of episodes) {
    const result = await repository.addEpisode(episode);
    if (result?.id) saved.push(result);
  }
  return saved;
}

async function persistToolUses(repository, { input, chat, scope, scopedAgentId, processStatus }) {
  const toolCalls = Array.isArray(chat.toolCalls) ? chat.toolCalls : [];
  const toolResults = Array.isArray(chat.toolResults) ? chat.toolResults : [];
  const resultById = new Map(toolResults.map((result) => [String(result.tool_call_id || ''), result]));
  const saved = [];
  for (const toolCall of toolCalls) {
    const toolCallId = String(toolCall?.id || '').trim();
    const result = resultById.get(toolCallId);
    const record = await repository.recordToolUse({
      scope,
      agent_id: scopedAgentId,
      actor_agent_id: normalizeAgentId(input.agent?.id),
      agent_name: input.agent?.name || null,
      actor_agent_name: input.agent?.name || null,
      user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
      chat_id: chat.chatId || chat.chat_id || input.chatId || null,
      agent_run_id: input.runId || input.run_id || chat.runId || chat.run_id || null,
      process_status: processStatus,
      tool_name: getToolName(toolCall),
      tool_call_id: toolCallId || null,
      arguments: getToolArguments(toolCall),
      result_text: result?.content || '',
      status: result ? getToolResultStatus(result) : 'unknown',
    });
    if (record) saved.push(record);
  }
  return saved;
}

function appendPacketItem(packet, memoryType, information, candidate = {}) {
  const key = TYPE_TO_PACKET_KEY[memoryType] || 'facts';
  if (!Array.isArray(packet[key])) packet[key] = [];
  packet[key].push({
    memory_type: candidate.memory_type || memoryType,
    category: candidate.category || null,
    topic: candidate.topic || null,
    information,
  });
}

function buildSemanticTopics(extraction = {}, candidates = []) {
  const byKey = new Map();
  const addTopic = (topic, fallbackCategory = 'project_context') => {
    const name = normalizeText(topic?.name || topic?.topic || topic?.key || topic, 180);
    if (!name) return;
    const key = canonicalizeGraphKey(topic?.key || topic?.subject_key || name, name);
    if (byKey.has(key)) return;
    byKey.set(key, {
      name,
      key,
      category: normalizeText(topic?.category || fallbackCategory, 120) || fallbackCategory,
    });
  };
  for (const topic of Array.isArray(extraction.topics) ? extraction.topics : []) {
    addTopic(topic);
  }
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    addTopic({
      name: candidate.topic || candidate.subject_key || candidate.category,
      key: candidate.subject_key || candidate.topic,
      category: candidate.category || 'project_context',
    }, candidate.category || 'project_context');
  }
  return [...byKey.values()].slice(0, 8);
}

function normalizedComparable(value) {
  return canonicalizeGraphKey(value, '');
}

function comparableTerms(value) {
  return normalizedComparable(value)
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 4);
}

function countTermOverlap(left, right) {
  const leftTerms = new Set(comparableTerms(left));
  const rightTerms = new Set(comparableTerms(right));
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  return [...leftTerms].filter((term) => rightTerms.has(term)).length;
}

function shouldReuseExistingMemory(candidate = {}, existing = {}) {
  if (!existing?.id) return false;
  if (candidate.memory_type && existing.memory_type && candidate.memory_type !== existing.memory_type) return false;
  if (candidate.category && existing.category && candidate.category !== existing.category) return false;

  const candidateTopic = normalizedComparable(candidate.subject_key || candidate.topic);
  const existingTopic = normalizedComparable(existing.subject_key || existing.topic);
  if (candidateTopic && existingTopic && candidateTopic === existingTopic) return true;

  const score = Number(existing.score || 0);
  const overlap = countTermOverlap(
    [candidate.topic, candidate.information].filter(Boolean).join(' '),
    [existing.topic, existing.information].filter(Boolean).join(' ')
  );
  return score >= 0.78 && overlap >= 2;
}

async function findReusableMemoryMatch(repository, { scope, agentId, candidate, embedding, requestSummary, topics }) {
  const queryTexts = [
    candidate.topic,
    candidate.subject_key,
    candidate.searchable_text,
    candidate.information,
    requestSummary,
    ...(Array.isArray(topics) ? topics.map((topic) => topic.name || topic.key) : []),
  ].filter(Boolean);
  const matches = await repository.searchContext({
    scope,
    agent_id: agentId,
    embeddings: embedding ? [embedding] : [],
    query_texts: queryTexts,
    limit: 8,
    min_score: 0.28,
  });
  return matches.find((match) => shouldReuseExistingMemory(candidate, match)) || null;
}

async function afterMemory(input = {}) {
  const chat = getMemoryChat(input);
  const settings = getMemoryEngineSettingsSync();
  const scope = normalizeMemoryScope(input.agent?.memory_scope);
  if (!shouldRunMemory(input.agent, settings)) {
    return buildEmptyMemoryContextPacket({
      agent: input.agent,
      enabled: false,
      scope,
      skipped_reason: !settings?.enabled
        ? 'global_disabled'
        : 'improve_memories_disabled',
    });
  }

  const packet = buildEmptyMemoryContextPacket({
    agent: input.agent,
    enabled: true,
    scope,
    chat_id: chat.chatId || null,
  });
  const scopedAgentId = normalizeAgentId(packet.agent_id);
  const processStatus = normalizeProcessStatus(input.processStatus || input.process_status || chat.processStatus, 'completed');
  const repository = createMemoryRepository(settings);
  packet.process = {
    user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
    agent: input.agent?.name || input.agent?.id || null,
    request: findLatestUserMessage(chat)?.content || '',
    tool_sequence: [],
    status: processStatus,
    reusable_info: [],
  };

  const episodes = buildAfterMemoryEpisodes({
    input,
    chat,
    scope,
    scopedAgentId,
    processStatus,
  });
  const savedEpisodes = await persistEpisodes(repository, episodes);
  const processEpisode = savedEpisodes.find((episode) => episode.episodeType === 'run_process') || savedEpisodes[0] || null;
  const savedTools = await persistToolUses(repository, {
    input,
    chat,
    scope,
    scopedAgentId,
    processStatus,
  });
  packet.process.tool_sequence = savedTools.map((tool) => tool.toolName).filter(Boolean);

  let extraction;
  try {
    extraction = await extractMemoryUpdates({
      settings,
      chat,
      agent: input.agent,
      scope,
      agentId: scopedAgentId,
      processStatus,
    });
  } catch (error) {
    packet.warnings.push(`Analisi memoria non completata: ${error?.message || error}`);
    extraction = { candidates: [], warnings: [] };
  }

  packet.warnings.push(...(extraction.warnings || []));
  const candidates = extraction.candidates || [];
  const requestSummary = normalizeText(extraction.request_summary || findLatestUserMessage(chat)?.content || '', 220);
  const semanticTopics = buildSemanticTopics(extraction, candidates);
  packet.request = {
    summary: requestSummary,
    topics: semanticTopics,
  };
  packet.process.request_summary = requestSummary;
  packet.process.topics = semanticTopics;

  let semanticGraph = { runKey: null, request: null, topics: [] };
  try {
    semanticGraph = await repository.recordRunSemantics({
      scope,
      agent_id: scopedAgentId,
      actor_agent_id: normalizeAgentId(input.agent?.id),
      agent_name: input.agent?.name || null,
      actor_agent_name: input.agent?.name || null,
      user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
      chat_id: chat.chatId || chat.chat_id || input.chatId || null,
      agent_run_id: input.runId || input.run_id || chat.runId || chat.run_id || null,
      process_status: processStatus,
      request_summary: requestSummary,
      request_text: findLatestUserMessage(chat)?.content || '',
      topics: semanticTopics,
    });
  } catch (error) {
    packet.warnings.push(`Grafo semantico memoria non aggiornato: ${error?.message || error}`);
  }

  if (candidates.length > 0) {
    try {
      const embeddingResult = await embedTexts(candidates.map((candidate) => candidate.searchable_text || candidate.information), settings);
      let savedItemCount = 0;
      let unchangedItemCount = 0;
      let updatedItemCount = 0;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        let reusableMatch = null;
        try {
          reusableMatch = await findReusableMemoryMatch(repository, {
            scope,
            agentId: scopedAgentId,
            candidate,
            embedding: embeddingResult.embeddings[index],
            requestSummary,
            topics: semanticTopics,
          });
        } catch (error) {
          packet.warnings.push(`Confronto memorie correlate non completato: ${error?.message || error}`);
        }
        const saved = await repository.upsertMemoryItem({
          ...candidate,
          id: reusableMatch?.id || candidate.id,
          agent_id: scopedAgentId,
          agent_label: input.agent?.name || null,
          user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
          episode_id: processEpisode?.id || null,
          agent_run_id: input.runId || input.run_id || chat.runId || chat.run_id || null,
          chat_id: chat.chatId || chat.chat_id || input.chatId || null,
          embedding: embeddingResult.embeddings[index],
          embedding_model: embeddingResult.model,
          embedding_provider: embeddingResult.provider,
        });
        if (saved?.id && !saved.unchanged) {
          savedItemCount += 1;
          if (reusableMatch?.id) updatedItemCount += 1;
          appendPacketItem(packet, candidate.memory_type, candidate.information, candidate);
          packet.process.reusable_info.push(candidate.topic || candidate.information);
          try {
            await repository.linkMemoryItemSemantics({
              item_id: saved.id,
              scope,
              agent_id: scopedAgentId,
              agent_run_id: input.runId || input.run_id || chat.runId || chat.run_id || null,
              process_status: processStatus,
              request: semanticGraph.request,
              request_summary: requestSummary,
              request_text: findLatestUserMessage(chat)?.content || '',
              topics: semanticGraph.topics?.length ? semanticGraph.topics : semanticTopics,
              tool_names: packet.process.tool_sequence,
            });
          } catch (error) {
            packet.warnings.push(`Collegamento semantico memoria non completato: ${error?.message || error}`);
          }
        } else if (saved?.unchanged) {
          unchangedItemCount += 1;
          try {
            await repository.linkMemoryItemSemantics({
              item_id: saved.id,
              scope,
              agent_id: scopedAgentId,
              agent_run_id: input.runId || input.run_id || chat.runId || chat.run_id || null,
              process_status: processStatus,
              request: semanticGraph.request,
              request_summary: requestSummary,
              request_text: findLatestUserMessage(chat)?.content || '',
              topics: semanticGraph.topics?.length ? semanticGraph.topics : semanticTopics,
              tool_names: packet.process.tool_sequence,
            });
          } catch (error) {
            packet.warnings.push(`Collegamento semantico memoria non completato: ${error?.message || error}`);
          }
        }
      }
      packet.embedding = {
        provider: embeddingResult.provider,
        model: embeddingResult.model,
        saved_items: savedItemCount,
        unchanged_items: unchangedItemCount,
        updated_items: updatedItemCount,
      };
    } catch (error) {
      packet.warnings.push(`Embedding/salvataggio memorie riutilizzabili non completato: ${error?.message || error}`);
    }
  }

  packet.episodes = {
    saved: savedEpisodes.length,
    tools: savedTools.length,
  };
  if (savedEpisodes.length === 0 && candidates.length === 0) {
    packet.skipped_reason = 'nothing_to_save';
  }
  return packet;
}

module.exports = {
  afterMemory,
  getMemoryChat,
  shouldRunMemory,
};
