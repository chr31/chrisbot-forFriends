const { getMemoryEngineSettingsSync } = require('../appSettings');
const { buildEmptyMemoryContextPacket, normalizeMemoryScope } = require('./memoryContextPacket');
const { runMemoryAgent } = require('./memoryAgentRunner');

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

  try {
    const result = await runMemoryAgent({
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
    });
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
