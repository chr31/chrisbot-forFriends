const { getAgentById } = require('../database/db_agents');
const {
  createAgentChat,
  updateAgentChatConfig,
  getAgentChatByChatId,
  getMessagesByAgentChatId,
  insertAgentMessages,
} = require('../database/db_agent_chats');
const { insertAgentRun, updateAgentRun, updateAgentRunIfStatus } = require('../database/db_agent_runs');
const { canUserAccessAgent } = require('./agentAccess');
const { runAgentConversation, buildInitialAgentHistory, createChatId, sanitizeMessages } = require('./agentRunner');
const { ADMIN_SHARED_OWNER, isSuperAdminUser } = require('../utils/adminAccess');
const { normalizeModelConfig, getAgentDefaultModelConfig, getDefaultModelConfig } = require('./aiModelCatalog');
const { runBeforeMemory, runAfterMemory } = require('./memory/memoryOrchestrator');
const { buildMemoryRunTrace } = require('./memory/memoryRunTrace');

function normalizeUserMessage(messages) {
  const userMessage = Array.isArray(messages) ? messages[messages.length - 1] : null;
  if (!userMessage || userMessage.role !== 'user' || !String(userMessage.content || '').trim()) {
    throw new Error("L'ultimo messaggio utente e obbligatorio.");
  }
  return {
    role: 'user',
    content: String(userMessage.content),
  };
}

async function prepareAgentChatExecution(input = {}) {
  const {
    chat_id,
    agent_id,
    messages,
    model_config,
    user,
    owner_username,
  } = input;

  const userMessage = normalizeUserMessage(messages);
  const currentChatId = chat_id === 'new' || !chat_id ? createChatId() : chat_id;
  const existingChat = chat_id && chat_id !== 'new' ? await getAgentChatByChatId(currentChatId) : null;
  let agent = null;

  if (existingChat) {
    const canAccessSharedAdminChat = existingChat.owner_username === ADMIN_SHARED_OWNER && isSuperAdminUser(user);
    if (existingChat.owner_username !== owner_username && !canAccessSharedAdminChat) {
      const accessError = new Error('Accesso negato');
      accessError.statusCode = 403;
      throw accessError;
    }
    agent = await getAgentById(existingChat.agent_id);
    const currentModelConfig = normalizeModelConfig(existingChat.config_json?.model_config || {}, getAgentDefaultModelConfig(agent));
    const nextModelConfig = normalizeModelConfig(model_config || {}, currentModelConfig);
    if (
      nextModelConfig.provider !== currentModelConfig.provider
      || nextModelConfig.model !== currentModelConfig.model
      || nextModelConfig.ollama_server_id !== currentModelConfig.ollama_server_id
    ) {
      const nextConfig = {
        ...(existingChat.config_json || {}),
        model_config: nextModelConfig,
      };
      await updateAgentChatConfig(currentChatId, nextConfig);
      existingChat.config_json = nextConfig;
    }
  } else {
    agent = await getAgentById(agent_id);
    if (!agent) {
      const notFound = new Error('Agente non trovato');
      notFound.statusCode = 404;
      throw notFound;
    }
    const canAccess = await canUserAccessAgent(agent, user, 'chat');
    if (!canAccess || !agent.direct_chat_enabled) {
      const forbidden = new Error('Agente non disponibile per la chat diretta');
      forbidden.statusCode = 403;
      throw forbidden;
    }
    await createAgentChat({
      chat_id: currentChatId,
      agent_id: agent.id,
      owner_username,
      title: String(userMessage.content).trim().slice(0, 180),
      config_json: {
        model_config: normalizeModelConfig(model_config || {}, getAgentDefaultModelConfig(agent)),
      },
    });
  }

  if (!agent) {
    const notFound = new Error('Agente non trovato');
    notFound.statusCode = 404;
    throw notFound;
  }

  const existingMessages = await getMessagesByAgentChatId(currentChatId);
  const history = await buildInitialAgentHistory(agent, existingMessages);
  const resolvedModelConfig = normalizeModelConfig(
    existingChat?.config_json?.model_config || model_config || {},
    getAgentDefaultModelConfig(agent) || getDefaultModelConfig()
  );
  if (existingMessages.length === 0) {
    await insertAgentMessages([{
      chat_id: currentChatId,
      agent_id: agent.id,
      role: 'system',
      event_type: 'system_prompt',
      content: history[0].content,
    }]);
  }

  await insertAgentMessages([{
    chat_id: currentChatId,
    agent_id: agent.id,
    role: 'user',
    event_type: 'message',
    content: String(userMessage.content),
  }]);
  history.push({ role: 'user', content: String(userMessage.content) });

  const run = await insertAgentRun({
    chat_id: currentChatId,
    agent_id: agent.id,
    status: 'running',
    model_name: resolvedModelConfig.model,
    model_provider: resolvedModelConfig.provider,
    depth: 0,
    started_at: new Date(),
  });

  const memoryContextPacket = await runBeforeMemory({
    agent,
    chat: {
      chatId: currentChatId,
      messages: sanitizeMessages(history),
      sourceMessages: history,
      userMessage,
      runId: run.id,
      userKey: owner_username,
      owner_username,
    },
    runId: run.id,
    userKey: owner_username,
    modelConfig: resolvedModelConfig,
  });

  await updateAgentRun(run.id, {
    guardrail_result_json: buildMemoryRunTrace(memoryContextPacket, null),
  });

  return {
    agent,
    run,
    chatId: currentChatId,
    history,
    modelConfig: resolvedModelConfig,
    userMessage,
    userKey: owner_username,
    memoryContextPacket,
  };
}

function runAfterMemoryInBackground(prepared, response, processStatus, error = null) {
  setImmediate(async () => {
    let afterMemoryPacket = null;
    try {
      afterMemoryPacket = await runAfterMemory({
        agent: prepared.agent,
        chat: {
          chatId: prepared.chatId,
          runId: prepared.run.id,
          messages: sanitizeMessages(prepared.history),
          sourceMessages: prepared.history,
          userMessage: prepared.userMessage,
          assistantResponse: response || '',
          error,
          userKey: prepared.userKey || null,
        },
        modelConfig: prepared.modelConfig,
        beforePacket: prepared.memoryContextPacket,
        runId: prepared.run.id,
        userKey: prepared.userKey || null,
        processStatus,
        error,
      });
    } catch (memoryError) {
      afterMemoryPacket = {
        enabled: false,
        scope: prepared.agent?.memory_scope || 'shared',
        warnings: [String(memoryError?.message || memoryError)],
        skipped_reason: 'error',
      };
    }

    try {
      await updateAgentRun(prepared.run.id, {
        guardrail_result_json: buildMemoryRunTrace(prepared.memoryContextPacket, afterMemoryPacket),
      });
    } catch (traceError) {
      console.error('Errore aggiornamento traccia afterMemory:', traceError);
    }
  });
}

async function finalizeAgentChatExecution(prepared) {
  let response = '';
  try {
    response = await runAgentConversation(prepared.agent, prepared.history, {
      chatId: prepared.chatId,
      agentId: prepared.agent.id,
      ollamaServerId: prepared.modelConfig.ollama_server_id,
      parentRunId: null,
      runId: prepared.run.id,
      parentAgentId: null,
      modelConfig: prepared.modelConfig,
      depth: 0,
      userKey: prepared.userKey || null,
    });
    await updateAgentRunIfStatus(prepared.run.id, {
      status: 'completed',
      finished_at: new Date(),
      guardrail_result_json: buildMemoryRunTrace(prepared.memoryContextPacket, null, { includePendingAfter: true }),
    }, 'running');
    runAfterMemoryInBackground(prepared, response, 'completed');
    return {
      response,
      chat_id: prepared.chatId,
      run_id: prepared.run.id,
      agent_id: prepared.agent.id,
    };
  } catch (error) {
    await updateAgentRunIfStatus(prepared.run.id, {
      status: 'failed',
      finished_at: new Date(),
      last_error: String(error?.message || error),
      guardrail_result_json: buildMemoryRunTrace(prepared.memoryContextPacket, null, { includePendingAfter: true }),
    }, 'running');
    runAfterMemoryInBackground(prepared, response, 'failed', error);
    throw error;
  }
}

async function executeAgentChat(input = {}) {
  const prepared = await prepareAgentChatExecution(input);
  return finalizeAgentChatExecution(prepared);
}

module.exports = {
  executeAgentChat,
  prepareAgentChatExecution,
  finalizeAgentChatExecution,
};
