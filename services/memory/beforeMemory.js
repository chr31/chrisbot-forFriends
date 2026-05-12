const { getMemoryEngineSettingsSync } = require('../appSettings');
const {
  buildEmptyMemoryContextPacket,
  formatMemoryContextPacket,
  hasMemoryContext,
  normalizeMemoryScope,
} = require('./memoryContextPacket');
const { normalizeAgentId } = require('./memorySchema');
const { runMemoryAgent } = require('./memoryAgentRunner');

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

function appendUserPromptContext(prompt, username) {
  const cleanPrompt = String(prompt || '').trim();
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) return cleanPrompt;
  return [cleanPrompt, `Stai parlando con l'utente ${cleanUsername}`].filter(Boolean).join('\n\n');
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
  packet.process = {
    user_key: input.userKey || input.user_key || chat.userKey || chat.owner_username || null,
    agent: input.agent?.name || input.agent?.id || null,
    request: chat?.userMessage?.content || '',
    tool_sequence: ['memory_agent', 'runCypherQuery'],
    status: 'running',
    reusable_info: [],
  };
  packet.request = {
    summary: String(chat?.userMessage?.content || '').slice(0, 220),
    topics: [],
  };

  try {
    const result = await runMemoryAgent({
      settings,
      messages: chat.sourceMessages || chat.messages || [],
      userPrompt: appendUserPromptContext(
        settings.before_memory_prompt,
        input.userKey || input.user_key || chat.userKey || chat.owner_username
      ),
      scope,
      agentId: normalizeAgentId(packet.agent_id),
      output: {
        key: 'availableMemories',
        description: 'riassunto solo delle memorie utili al contesto',
      },
    });
    packet.contextText = String(result.text || '').trim();
    packet.process.status = 'completed';
    packet.retrieval = {
      agent_tool_calls: result.tool_call_count || 0,
      selected_ids: [],
    };
    if (!packet.contextText) {
      packet.skipped_reason = 'no_memory_context';
    }
    if (result.warning) packet.warnings.push(result.warning);
  } catch (error) {
    packet.skipped_reason = 'retrieval_error';
    packet.process.status = 'failed';
    packet.warnings.push(`Agente memorie non completato: ${error?.message || error}`);
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
