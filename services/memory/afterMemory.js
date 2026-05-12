const { getMemoryEngineSettingsSync } = require('../appSettings');
const { buildEmptyMemoryContextPacket, normalizeMemoryScope } = require('./memoryContextPacket');
const { extractMemoryUpdates } = require('./memoryAnalyzer');
const { runMemoryAgent } = require('./memoryAgentRunner');
const { createMemoryRepository } = require('./repositories/memoryRepository');

const MEMORY_MODEL_TIMEOUT_MS = 45000;

function shouldRunMemory(agent, settings) {
  return Boolean(settings?.enabled && agent?.improve_memories_enabled);
}

function getMemoryChat(input = {}) {
  return input.chat && typeof input.chat === 'object'
    ? input.chat
    : {
        chatId: input.chatId || null,
        messages: input.messages,
        sourceMessages: input.messages,
        userMessage: input.userMessage || null,
        assistantResponse: input.assistantResponse || '',
        toolCalls: input.toolCalls || [],
        toolResults: input.toolResults || [],
      };
}

function buildAfterMessages(chat = {}) {
  const messages = Array.isArray(chat.sourceMessages || chat.messages)
    ? [...(chat.sourceMessages || chat.messages)]
    : [];
  const assistantResponse = String(chat.assistantResponse || '').trim();
  const hasAssistantResponse = assistantResponse
    && messages.some((message) => message?.role === 'assistant' && String(message.content || '').trim() === assistantResponse);
  if (assistantResponse && !hasAssistantResponse) {
    messages.push({ role: 'assistant', content: assistantResponse });
  }
  return messages;
}

function appendUserPromptContext(prompt, username) {
  const cleanPrompt = String(prompt || '').trim();
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) return cleanPrompt;
  return [cleanPrompt, `Stai parlando con l'utente ${cleanUsername}`].filter(Boolean).join('\n\n');
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout dopo ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function addCandidateToPacket(packet, candidate) {
  const keyByType = {
    fact: 'facts',
    entity: 'entities',
    procedure: 'procedures',
    decision: 'decisions',
    tool_lesson: 'tool_lessons',
    action_history: 'recent_actions',
    summary: 'summaries',
  };
  const key = keyByType[candidate?.memory_type] || 'facts';
  if (!Array.isArray(packet[key])) packet[key] = [];
  packet[key].push({
    id: candidate.id || null,
    topic: candidate.topic || candidate.category || candidate.memory_type || '',
    information: candidate.information || '',
    category: candidate.category || null,
    confidence: candidate.confidence,
    importance: candidate.importance,
  });
}

function getToolNames(chat = {}) {
  const names = [];
  for (const call of Array.isArray(chat.toolCalls) ? chat.toolCalls : []) {
    const name = String(call?.function?.name || call?.name || '').trim();
    if (name) names.push(name);
  }
  for (const result of Array.isArray(chat.toolResults) ? chat.toolResults : []) {
    const name = String(result?.tool_name || result?.name || '').trim();
    if (name) names.push(name);
  }
  return [...new Set(names)].slice(0, 8);
}

function buildDeterministicExtraction(chat = {}, warning) {
  const requestText = String(chat?.userMessage?.content || '').trim();
  const normalized = requestText.toLowerCase();
  const looksReusable = requestText.length >= 40
    && !/^(ciao|salve|hello|hi)[\s!.?]*$/i.test(requestText)
    && /\b(h-farm|campus|infrastruttura|agente|processo|procedura|servizio|edifici|asset|tool|repository)\b/i.test(requestText);
  if (!looksReusable) {
    return {
      request_summary: requestText.slice(0, 80) || 'richiesta chat',
      topics: [],
      candidates: [],
      warnings: [warning].filter(Boolean),
    };
  }

  const topic = normalized.includes('h-farm') ? 'H-FARM Campus' : 'contesto operativo';
  return {
    request_summary: requestText.slice(0, 120),
    topics: [{ name: topic, category: 'project_context' }],
    candidates: [{
      memory_type: 'fact',
      topic,
      category: 'project_context',
      information: requestText.slice(0, 1200),
      confidence: 0.72,
      importance: 0.65,
    }],
    warnings: [warning, 'Fallback deterministico: modello memoria non disponibile o troppo lento.'].filter(Boolean),
  };
}

async function persistStructuredMemoryUpdates({ settings, chat, agent, packet, scope, agentId, processStatus }) {
  const repository = createMemoryRepository(settings);
  let extraction;
  if (String(settings.analysis_model_provider || '').trim().toLowerCase() === 'ollama') {
    extraction = buildDeterministicExtraction(chat, 'Estrazione LLM saltata per provider Ollama: uso fallback deterministico.');
  } else {
    extraction = await withTimeout(
      extractMemoryUpdates({
        settings,
        chat,
        agent,
        scope,
        agentId,
        processStatus,
      }),
      MEMORY_MODEL_TIMEOUT_MS,
      'Estrazione memorie'
    );
  }
  packet.request = {
    summary: extraction.request_summary || packet.request?.summary || '',
    topics: extraction.topics || [],
  };
  if (Array.isArray(extraction.warnings) && extraction.warnings.length > 0) {
    packet.warnings.push(...extraction.warnings);
  }

  const common = {
    scope,
    agent_id: agentId,
    actor_agent_id: agent?.id || null,
    actor_agent_name: agent?.name || null,
    chat_id: chat.chatId || null,
    run_id: chat.runId || chat.run_id || null,
    agent_run_id: chat.runId || chat.run_id || null,
    user_key: packet.process?.user_key || null,
    process_status: processStatus,
    request_summary: packet.request.summary,
    request_text: chat?.userMessage?.content || '',
    topics: extraction.topics || [],
  };

  const semantics = await repository.recordRunSemantics(common);
  let savedItems = 0;
  let updatedItems = 0;
  let unchangedItems = 0;

  for (const candidate of Array.isArray(extraction.candidates) ? extraction.candidates : []) {
    const saved = await repository.upsertMemoryItem({
      ...common,
      ...candidate,
      agent_label: agent?.name || null,
    });
    if (!saved) continue;
    const item = { ...candidate, id: saved.id };
    addCandidateToPacket(packet, item);
    if (saved.unchanged) {
      unchangedItems += 1;
    } else if (saved.created) {
      savedItems += 1;
    } else {
      updatedItems += 1;
    }
    await repository.linkMemoryItemSemantics({
      ...common,
      item_id: saved.id,
      request: semantics?.request || null,
      topics: semantics?.topics || extraction.topics || [],
      tool_names: getToolNames(chat),
    });
  }

  return { savedItems, updatedItems, unchangedItems };
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
  packet.process = {
    user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
    agent: input.agent?.name || input.agent?.id || null,
    request: chat?.userMessage?.content || '',
    tool_sequence: ['memory_agent', 'runCypherQuery'],
    status: input.processStatus || input.process_status || chat.processStatus || 'completed',
    reusable_info: [],
  };
  packet.request = {
    summary: String(chat?.userMessage?.content || '').slice(0, 220),
    topics: [],
  };
  const agentId = packet.agent_id || null;
  const processStatus = input.processStatus || input.process_status || chat.processStatus || 'completed';

  try {
    let result = null;
    if (String(settings.analysis_model_provider || '').trim().toLowerCase() === 'ollama') {
      result = {
        text: '',
        tool_call_count: 0,
        warning: 'Tool-calling memoria saltato per provider Ollama: uso estrazione strutturata e scrittura diretta.',
      };
    } else {
      try {
        result = await withTimeout(
          runMemoryAgent({
            settings,
            messages: buildAfterMessages(chat),
            userPrompt: appendUserPromptContext(
              settings.after_memory_prompt,
              input.userKey || input.user_key || chat.userKey || chat.owner_username
            ),
            scope,
            agentId: packet.agent_id || null,
            output: {
              key: 'memoryStatus',
              description: 'riassunto delle operazioni di aggiornamento se necessarie',
            },
          }),
          MEMORY_MODEL_TIMEOUT_MS,
          'Agente memorie'
        );
      } catch (error) {
        result = {
          text: '',
          tool_call_count: 0,
          warning: String(error?.message || error),
        };
      }
    }
    packet.contextText = String(result.text || '').trim();
    packet.embedding = {
      saved_items: 0,
      updated_items: 0,
      unchanged_items: 0,
      agent_tool_calls: result.tool_call_count || 0,
    };
    packet.episodes = {
      saved: 0,
      tools: result.tool_call_count || 0,
    };
    if (!packet.contextText) packet.skipped_reason = 'no_agent_summary';
    if (result.warning) packet.warnings.push(result.warning);
    if ((result.tool_call_count || 0) === 0) {
      const persisted = await persistStructuredMemoryUpdates({
        settings,
        chat,
        agent: input.agent,
        packet,
        scope,
        agentId,
        processStatus,
      });
      packet.embedding.saved_items = persisted.savedItems;
      packet.embedding.updated_items = persisted.updatedItems;
      packet.embedding.unchanged_items = persisted.unchangedItems;
      packet.episodes.saved = persisted.savedItems + persisted.unchangedItems;
      if (persisted.savedItems > 0 || persisted.updatedItems > 0 || persisted.unchangedItems > 0) {
        delete packet.skipped_reason;
      } else if (!packet.skipped_reason) {
        packet.skipped_reason = 'no_memory_updates';
      }
    }
  } catch (error) {
    packet.skipped_reason = 'agent_error';
    packet.process.status = 'failed';
    packet.warnings.push(`Agente memorie non completato: ${error?.message || error}`);
  }

  return packet;
}

module.exports = {
  afterMemory,
  getMemoryChat,
  shouldRunMemory,
};
