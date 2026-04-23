const { getAgentById, getAliveAgents } = require('../database/db_agents');
const {
  ensureAliveAgentChat,
  getAliveAgentChatByAgentId,
  updateAliveAgentChatConfig,
  updateAliveAgentLoopState,
  claimAliveAgentChatForProcessing,
  releaseAliveAgentChatProcessing,
  listDueAliveAgentChats,
  getAliveAgentMessages,
  insertAliveAgentMessages,
  deleteAliveAgentChatHistory,
} = require('../database/db_alive_agent_chats');
const { insertAgentRun, updateAgentRunIfStatus, getAgentRunsByChatId } = require('../database/db_agent_runs');
const { runAgentConversation, buildInitialAgentHistory } = require('./agentRunner');
const { normalizeModelConfig, getAgentDefaultModelConfig, getDefaultModelConfig } = require('./aiModelCatalog');

const LOOP_POLL_MS = 1500;
let loopTimer = null;
let tickInFlight = false;

function buildAliveChatConfig(agent, configJson = null) {
  return {
    model_config: normalizeModelConfig(configJson?.model_config || {}, getAgentDefaultModelConfig(agent)),
  };
}

async function ensureAliveChatForAgent(agent, configJson = null) {
  const chat = await ensureAliveAgentChat(agent.id, buildAliveChatConfig(agent, configJson));
  return chat;
}

async function getAliveAgentCatalog() {
  const agents = await getAliveAgents();
  const chats = await Promise.all(
    agents.map(async (agent) => {
      const chat = await getAliveAgentChatByAgentId(agent.id);
      const messages = chat ? await getAliveAgentMessages(chat.chat_id) : [];
      const lastVisibleMessage = [...messages].reverse().find((entry) => entry.role === 'user' || entry.role === 'assistant') || null;
      return {
        ...agent,
        chat_id: chat?.chat_id || null,
        loop_status: chat?.loop_status || 'pause',
        is_processing: chat?.is_processing || false,
        next_loop_at: chat?.next_loop_at || null,
        last_error: chat?.last_error || null,
        last_message_at: lastVisibleMessage?.created_at || null,
      };
    })
  );
  return chats;
}

async function getAliveAgentDetail(agentId) {
  const agent = await getAgentById(agentId);
  if (!agent || !agent.is_alive || !agent.direct_chat_enabled || !agent.is_active) {
    return null;
  }
  const chat = await ensureAliveChatForAgent(agent);
  const messages = await getAliveAgentMessages(chat.chat_id);
  const runs = await getAgentRunsByChatId(chat.chat_id);
  return {
    agent,
    chat,
    messages,
    runs,
  };
}

function getResolvedAliveModelConfig(agent, chat, requestModelConfig = null) {
  return normalizeModelConfig(
    requestModelConfig || chat?.config_json?.model_config || {},
    getAgentDefaultModelConfig(agent) || getDefaultModelConfig()
  );
}

async function persistAliveSystemPromptIfNeeded(agent, chatId) {
  const existing = await getAliveAgentMessages(chatId);
  if (existing.length > 0) return;
  const history = await buildInitialAgentHistory(agent, [], { includeGoals: agent.alive_include_goals });
  await insertAliveAgentMessages([{
    chat_id: chatId,
    agent_id: agent.id,
    role: 'system',
    event_type: 'system_prompt',
    content: history[0].content,
  }]);
}

async function appendAliveUserMessage(chatId, agentId, content, eventType = 'message') {
  await insertAliveAgentMessages([{
    chat_id: chatId,
    agent_id: agentId,
    role: 'user',
    event_type: eventType,
    content: String(content || ''),
  }]);
}

async function buildAliveHistory(agent, chatId) {
  const existingMessages = await getAliveAgentMessages(chatId);
  return buildInitialAgentHistory(agent, existingMessages, {
    includeGoals: agent.alive_include_goals,
    visibleOnly: true,
    visibleLimit: agent.alive_context_messages,
  });
}

async function runAliveCycle(agentId, options = {}) {
  const agent = await getAgentById(agentId);
  if (!agent || !agent.is_alive || !agent.direct_chat_enabled || !agent.is_active) {
    throw new Error('Agente alive non disponibile.');
  }

  const chat = await ensureAliveChatForAgent(agent, options.model_config || null);
  const effectiveModelConfig = getResolvedAliveModelConfig(agent, chat, options.model_config || null);

  if (options.model_config) {
    await updateAliveAgentChatConfig(agent.id, { model_config: effectiveModelConfig });
  }

  const claimed = await claimAliveAgentChatForProcessing(agent.id);
  if (!claimed) {
    const conflict = new Error('La chat alive e gia in esecuzione o non e pronta per un nuovo ciclo.');
    conflict.statusCode = 409;
    throw conflict;
  }

  try {
    await persistAliveSystemPromptIfNeeded(agent, chat.chat_id);

    const inputText = String(options.user_message || '').trim();
    if (inputText) {
      await appendAliveUserMessage(chat.chat_id, agent.id, inputText, 'message');
    } else {
      const alivePrompt = String(agent.alive_prompt || '').trim();
      if (!alivePrompt) {
        throw new Error('Prompt alive non configurato.');
      }
      await appendAliveUserMessage(chat.chat_id, agent.id, alivePrompt, 'alive_prompt');
    }

    const history = await buildAliveHistory(agent, chat.chat_id);
    const run = await insertAgentRun({
      chat_id: chat.chat_id,
      agent_id: agent.id,
      status: 'running',
      model_name: effectiveModelConfig.model,
      model_provider: effectiveModelConfig.provider,
      depth: 0,
      started_at: new Date(),
    });

    try {
      const response = await runAgentConversation(agent, history, {
        chatId: chat.chat_id,
        agentId: agent.id,
        ollamaServerId: effectiveModelConfig.ollama_server_id,
        parentRunId: null,
        runId: run.id,
        parentAgentId: null,
      modelConfig: effectiveModelConfig,
      depth: 0,
      messageWriter: insertAliveAgentMessages,
    });

      await updateAgentRunIfStatus(run.id, {
        status: 'completed',
        finished_at: new Date(),
      }, 'running');

      const refreshedChat = await getAliveAgentChatByAgentId(agent.id);
      const requestedNextLoopStatus = options.next_loop_status === 'pause' ? 'pause' : null;
      const shouldContinue = requestedNextLoopStatus
        ? false
        : refreshedChat?.loop_status === 'play';
      await releaseAliveAgentChatProcessing(agent.id, {
        loop_status: shouldContinue ? 'play' : 'pause',
        next_loop_at: shouldContinue ? new Date(Date.now() + (Math.max(1, Number(agent.alive_loop_seconds || 60)) * 1000)) : null,
        last_error: null,
        last_finished_at: new Date(),
      });
      return {
        response,
        chat_id: chat.chat_id,
        run_id: run.id,
        agent_id: agent.id,
      };
    } catch (error) {
      await updateAgentRunIfStatus(run.id, {
        status: 'failed',
        finished_at: new Date(),
        last_error: String(error?.message || error),
      }, 'running');
      throw error;
    }
  } catch (error) {
    await releaseAliveAgentChatProcessing(agent.id, {
      loop_status: 'pause',
      next_loop_at: null,
      last_error: String(error?.message || error),
      last_finished_at: new Date(),
    });
    throw error;
  }
}

async function setAliveChatPaused(agentId) {
  await ensureAliveAgentChat(agentId);
  await updateAliveAgentLoopState(agentId, {
    loop_status: 'pause',
    next_loop_at: null,
    last_error: null,
    last_finished_at: new Date(),
  });
}

async function playAliveAgent(agentId, options = {}) {
  const agent = await getAgentById(agentId);
  if (!agent || !agent.is_alive || !agent.direct_chat_enabled || !agent.is_active) {
    const notFound = new Error('Agente alive non disponibile.');
    notFound.statusCode = 404;
    throw notFound;
  }
  const chat = await ensureAliveChatForAgent(agent, options.model_config || null);
  if (chat.loop_status === 'play' || chat.is_processing) {
    const conflict = new Error('La chat alive e gia in play.');
    conflict.statusCode = 409;
    throw conflict;
  }

  const modelConfig = getResolvedAliveModelConfig(agent, chat, options.model_config || null);
  await updateAliveAgentChatConfig(agent.id, { model_config: modelConfig });
  await updateAliveAgentLoopState(agent.id, {
    loop_status: 'play',
    is_processing: false,
    next_loop_at: new Date(),
    last_error: null,
  });
  return runAliveCycle(agent.id, {
    user_message: options.user_message || '',
    model_config: modelConfig,
  });
}

async function submitAliveAgentMessage(agentId, options = {}) {
  const agent = await getAgentById(agentId);
  if (!agent || !agent.is_alive || !agent.direct_chat_enabled || !agent.is_active) {
    const notFound = new Error('Agente alive non disponibile.');
    notFound.statusCode = 404;
    throw notFound;
  }
  const chat = await ensureAliveChatForAgent(agent, options.model_config || null);
  if (chat.is_processing) {
    const conflict = new Error('La chat alive sta gia elaborando una risposta.');
    conflict.statusCode = 409;
    throw conflict;
  }
  const modelConfig = getResolvedAliveModelConfig(agent, chat, options.model_config || null);
  const nextLoopStatus = options.continue_loop === true || chat.loop_status === 'play' ? 'play' : 'pause';
  await updateAliveAgentChatConfig(agent.id, { model_config: modelConfig });
  await updateAliveAgentLoopState(agent.id, {
    loop_status: 'play',
    is_processing: false,
    next_loop_at: new Date(),
    last_error: null,
  });
  return runAliveCycle(agent.id, {
    user_message: options.user_message || '',
    model_config: modelConfig,
    next_loop_status: nextLoopStatus,
  });
}

async function clearAliveAgentHistory(agentId) {
  return deleteAliveAgentChatHistory(agentId);
}

async function processDueAliveAgentChats() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const dueChats = await listDueAliveAgentChats(10);
    await Promise.all(
      dueChats.map(async (chat) => {
        try {
          await runAliveCycle(chat.agent_id, {});
        } catch (error) {
          console.error(`Errore ciclo alive agente ${chat.agent_id}:`, error?.message || error);
        }
      })
    );
  } finally {
    tickInFlight = false;
  }
}

function initializeAliveAgentScheduler() {
  if (loopTimer) return;
  loopTimer = setInterval(() => {
    processDueAliveAgentChats().catch((error) => {
      console.error('Errore scheduler alive agents:', error?.message || error);
    });
  }, LOOP_POLL_MS);

  processDueAliveAgentChats().catch((error) => {
    console.error('Errore bootstrap scheduler alive agents:', error?.message || error);
  });
}

module.exports = {
  getAliveAgentCatalog,
  getAliveAgentDetail,
  playAliveAgent,
  setAliveChatPaused,
  submitAliveAgentMessage,
  clearAliveAgentHistory,
  initializeAliveAgentScheduler,
};
