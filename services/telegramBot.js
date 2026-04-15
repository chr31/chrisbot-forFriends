const axios = require('axios');
const {
  getTelegramRuntimeSettingsSync,
} = require('./appSettings');
const {
  getTelegramUserLinkByTelegramUserId,
  getTelegramChatSession,
  upsertTelegramChatSession,
} = require('../database/db_telegram');
const { getAccessibleAgentsForUser } = require('./agentAccess');
const { getAgentById } = require('../database/db_agents');
const {
  getAgentChatSummaries,
  getAgentChatByChatId,
  deleteAgentChat,
} = require('../database/db_agent_chats');
const {
  prepareAgentChatExecution,
  finalizeAgentChatExecution,
} = require('./agentChatExecutor');

const TELEGRAM_TEXT_LIMIT = 4000;

const state = {
  running: false,
  pollTimeout: null,
  offset: 0,
  inFlight: new Map(),
};

const BOT_COMMANDS = [
  { command: 'menu', description: 'Mostra il menu principale' },
  { command: 'new', description: 'Inizia una nuova conversazione' },
  { command: 'whoami', description: 'Mostra il tuo Telegram user id' },
];

function getApiBaseUrl() {
  const token = String(getTelegramRuntimeSettingsSync()?.bot_token || '').trim();
  return token ? `https://api.telegram.org/bot${token}` : null;
}

async function telegramApi(method, payload = {}) {
  const apiBaseUrl = getApiBaseUrl();
  if (!apiBaseUrl) throw new Error('Telegram bot token non configurato');
  const response = await axios.post(`${apiBaseUrl}/${method}`, payload, {
    timeout: 30000,
  });
  if (!response.data?.ok) {
    throw new Error(response.data?.description || `Telegram API error on ${method}`);
  }
  return response.data.result;
}

async function syncTelegramCommands() {
  await telegramApi('setMyCommands', {
    commands: BOT_COMMANDS,
  });
}

function chunkText(text) {
  const source = String(text || '').trim() || 'Risposta vuota.';
  const chunks = [];
  let current = source;
  while (current.length > TELEGRAM_TEXT_LIMIT) {
    chunks.push(current.slice(0, TELEGRAM_TEXT_LIMIT));
    current = current.slice(TELEGRAM_TEXT_LIMIT);
  }
  chunks.push(current);
  return chunks;
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  const chunks = chunkText(text);
  for (let index = 0; index < chunks.length; index += 1) {
    await telegramApi('sendMessage', {
      chat_id: String(chatId),
      text: chunks[index],
      reply_markup: index === chunks.length - 1 ? extra.reply_markup : undefined,
    });
  }
}

async function answerCallbackQuery(callbackQueryId, text = null) {
  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || undefined,
  });
}

function buildMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Scegli agente', callback_data: 'menu:agents' },
        { text: 'Nuova conversazione', callback_data: 'menu:new' },
      ],
      [
        { text: 'Apri conversazione', callback_data: 'menu:open' },
        { text: 'Elimina conversazione', callback_data: 'menu:delete' },
      ],
    ],
  };
}

function buildBackKeyboard() {
  return {
    inline_keyboard: [[{ text: 'Menu', callback_data: 'menu:root' }]],
  };
}

async function sendMainMenu(chatId, text = 'Menu Telegram Chrisbot') {
  await sendTelegramMessage(chatId, text, { reply_markup: buildMenuKeyboard() });
}

async function ensureMappedSession(telegramChat, telegramUser) {
  const userLink = await getTelegramUserLinkByTelegramUserId(telegramUser?.id);
  if (!userLink) return null;
  const currentSession = await getTelegramChatSession(telegramChat?.id);
  return upsertTelegramChatSession({
    telegram_chat_id: telegramChat?.id,
    telegram_user_id: telegramUser?.id,
    subject_type: userLink.subject_type,
    subject_id: userLink.subject_id,
    active_agent_chat_id: currentSession?.active_agent_chat_id || null,
    active_agent_id: currentSession?.active_agent_id || null,
    last_command: currentSession?.last_command || null,
    metadata_json: {
      ...(currentSession?.metadata_json || {}),
      telegram_username: telegramUser?.username || null,
      telegram_first_name: telegramUser?.first_name || null,
      telegram_last_name: telegramUser?.last_name || null,
    },
  });
}

async function getDirectAgentsForSubject(subjectId) {
  const agents = await getAccessibleAgentsForUser(subjectId);
  return agents.filter((agent) => agent.direct_chat_enabled && agent.is_active);
}

async function showAgentPicker(chatId, session) {
  const agents = await getDirectAgentsForSubject(session.subject_id);
  if (agents.length === 0) {
    await sendTelegramMessage(chatId, 'Nessun agente disponibile per questo utente.', { reply_markup: buildBackKeyboard() });
    return;
  }
  await sendTelegramMessage(chatId, 'Seleziona l’agente con cui iniziare la nuova conversazione.', {
    reply_markup: {
      inline_keyboard: [
        ...agents.map((agent) => [{ text: agent.name, callback_data: `agent:${agent.id}` }]),
        [{ text: 'Menu', callback_data: 'menu:root' }],
      ],
    },
  });
}

async function showOpenChats(chatId, session, mode) {
  const chats = await getAgentChatSummaries(session.subject_id);
  if (chats.length === 0) {
    await sendTelegramMessage(chatId, 'Non ci sono conversazioni aperte.', { reply_markup: buildBackKeyboard() });
    return;
  }
  const prefix = mode === 'delete' ? 'Scegli la conversazione da eliminare.' : 'Scegli la conversazione da aprire.';
  await sendTelegramMessage(chatId, prefix, {
    reply_markup: {
      inline_keyboard: [
        ...chats.map((chat) => [{
          text: `${chat.title || chat.agent_name}`.slice(0, 60),
          callback_data: `${mode}:${chat.id}`,
        }]),
        [{ text: 'Menu', callback_data: 'menu:root' }],
      ],
    },
  });
}

async function startNewConversation(chatId, session) {
  const agentId = Number(session.active_agent_id || 0);
  if (!agentId) {
    await showAgentPicker(chatId, session);
    return;
  }
  const agent = await getAgentById(agentId);
  await upsertTelegramChatSession({
    ...session,
    active_agent_chat_id: null,
    active_agent_id: agentId,
    last_command: 'new_chat',
    metadata_json: session.metadata_json || {},
  });
  await sendTelegramMessage(
    chatId,
    `Nuova conversazione pronta${agent?.name ? ` con ${agent.name}` : ''}. Scrivi il messaggio e verra creata una nuova chat.`,
    { reply_markup: buildMenuKeyboard() }
  );
}

function enqueueChatJob(chatId, task) {
  const key = String(chatId);
  const previous = state.inFlight.get(key) || Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (state.inFlight.get(key) === next) {
        state.inFlight.delete(key);
      }
    });
  state.inFlight.set(key, next);
  return next;
}

async function resolveAgentForNewChat(session) {
  if (Number(session.active_agent_id || 0) > 0) {
    return Number(session.active_agent_id);
  }
  const agents = await getDirectAgentsForSubject(session.subject_id);
  if (agents.length === 1) return agents[0].id;
  return null;
}

async function handleConversationText(message, session) {
  const chatId = String(message.chat.id);
  const currentSession = await getTelegramChatSession(chatId);
  const activeSession = currentSession || session;
  let targetChatId = String(activeSession?.active_agent_chat_id || '').trim() || null;
  let agentId = Number(activeSession?.active_agent_id || 0) || null;

  if (targetChatId) {
    const existingChat = await getAgentChatByChatId(targetChatId);
    if (!existingChat || existingChat.owner_username !== activeSession.subject_id) {
      targetChatId = null;
    } else {
      agentId = existingChat.agent_id;
    }
  }

  if (!targetChatId) {
    agentId = await resolveAgentForNewChat(activeSession);
    if (!agentId) {
      await showAgentPicker(chatId, activeSession);
      return;
    }
  }

  await sendTelegramMessage(chatId, 'Messaggio ricevuto. Ti scrivo appena la risposta e pronta.');

  enqueueChatJob(chatId, async () => {
    try {
      const prepared = await prepareAgentChatExecution({
        chat_id: targetChatId || 'new',
        agent_id: agentId,
        messages: [{ role: 'user', content: String(message.text || '').trim() }],
        user: activeSession.subject_id,
        owner_username: activeSession.subject_id,
      });
      await upsertTelegramChatSession({
        ...activeSession,
        active_agent_chat_id: prepared.chatId,
        active_agent_id: prepared.agent.id,
        last_command: 'message',
        metadata_json: activeSession.metadata_json || {},
      });
      const result = await finalizeAgentChatExecution(prepared);
      await sendTelegramMessage(chatId, result.response || 'Risposta vuota.', { reply_markup: buildMenuKeyboard() });
    } catch (error) {
      console.error('Errore esecuzione Telegram chat:', error);
      await sendTelegramMessage(chatId, `Errore durante la conversazione: ${error?.message || 'errore sconosciuto'}`, {
        reply_markup: buildMenuKeyboard(),
      });
    }
  });
}

async function processCallbackQuery(callbackQuery) {
  const session = await ensureMappedSession(callbackQuery.message?.chat, callbackQuery.from);
  if (!session) {
    await answerCallbackQuery(callbackQuery.id);
    return;
  }

  const data = String(callbackQuery.data || '').trim();
  const [action, rawValue] = data.split(':');
  const chatId = String(callbackQuery.message.chat.id);

  if (action === 'menu') {
    await answerCallbackQuery(callbackQuery.id);
    if (rawValue === 'agents') return showAgentPicker(chatId, session);
    if (rawValue === 'new') return startNewConversation(chatId, session);
    if (rawValue === 'open') return showOpenChats(chatId, session, 'open');
    if (rawValue === 'delete') return showOpenChats(chatId, session, 'delete');
    return sendMainMenu(chatId);
  }

  if (action === 'agent') {
    const agentId = Number(rawValue || 0);
    const agent = agentId ? await getAgentById(agentId) : null;
    if (!agent) {
      await answerCallbackQuery(callbackQuery.id, 'Agente non trovato');
      return;
    }
    await upsertTelegramChatSession({
      ...session,
      active_agent_chat_id: null,
      active_agent_id: agent.id,
      last_command: 'agent_selected',
      metadata_json: session.metadata_json || {},
    });
    await answerCallbackQuery(callbackQuery.id, 'Agente selezionato');
    await sendTelegramMessage(chatId, `Agente attivo: ${agent.name}. Il prossimo messaggio aprira una nuova conversazione.`, {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (action === 'open') {
    const agentChat = await getAgentChatByChatId(rawValue);
    if (!agentChat || agentChat.owner_username !== session.subject_id) {
      await answerCallbackQuery(callbackQuery.id, 'Chat non trovata');
      return;
    }
    await upsertTelegramChatSession({
      ...session,
      active_agent_chat_id: agentChat.chat_id,
      active_agent_id: agentChat.agent_id,
      last_command: 'chat_opened',
      metadata_json: session.metadata_json || {},
    });
    await answerCallbackQuery(callbackQuery.id, 'Conversazione selezionata');
    await sendTelegramMessage(chatId, `Conversazione attiva: ${agentChat.title || agentChat.agent_name}.`, {
      reply_markup: buildMenuKeyboard(),
    });
    return;
  }

  if (action === 'delete') {
    const result = await deleteAgentChat(rawValue, session.subject_id);
    const activeChatId = String(session.active_agent_chat_id || '').trim();
    await upsertTelegramChatSession({
      ...session,
      active_agent_chat_id: activeChatId === rawValue ? null : activeChatId,
      active_agent_id: activeChatId === rawValue ? session.active_agent_id : session.active_agent_id,
      last_command: 'chat_deleted',
      metadata_json: session.metadata_json || {},
    });
    await answerCallbackQuery(callbackQuery.id, result.changes > 0 ? 'Conversazione eliminata' : 'Chat non trovata');
    await sendTelegramMessage(chatId, result.changes > 0 ? 'Conversazione eliminata.' : 'Chat non trovata.', {
      reply_markup: buildMenuKeyboard(),
    });
  }
}

async function processMessage(message) {
  if (message?.chat?.type !== 'private') return;
  const text = String(message.text || '').trim();
  if (!text) return;
  if (text === '/whoami') {
    await sendTelegramMessage(
      message.chat.id,
      [
        'Identita Telegram',
        `user_id: ${String(message.from?.id || '')}`,
        `chat_id: ${String(message.chat?.id || '')}`,
        message.from?.username ? `username: @${message.from.username}` : null,
      ].filter(Boolean).join('\n'),
      { reply_markup: buildMenuKeyboard() }
    );
    return;
  }

  const session = await ensureMappedSession(message.chat, message.from);
  if (!session) return;

  if (text === '/menu' || text === '/help') {
    await sendMainMenu(message.chat.id, 'Chrisbot Telegram attivo. Scegli un’azione o scrivi un messaggio.');
    return;
  }
  if (text === '/new') {
    await startNewConversation(message.chat.id, session);
    return;
  }
  await handleConversationText(message, session);
}

async function processUpdate(update) {
  if (update.message) {
    await processMessage(update.message);
    return;
  }
  if (update.callback_query) {
    await processCallbackQuery(update.callback_query);
  }
}

async function pollOnce() {
  if (!state.running) return;
  try {
    const result = await telegramApi('getUpdates', {
      offset: state.offset,
      timeout: 20,
      allowed_updates: ['message', 'callback_query'],
    });
    for (const update of result || []) {
      state.offset = Number(update.update_id || 0) + 1;
      try {
        await processUpdate(update);
      } catch (error) {
        console.error('Errore processamento update Telegram:', error);
      }
    }
  } catch (error) {
    console.error('Errore polling Telegram:', error?.message || error);
  } finally {
    scheduleNextPoll();
  }
}

function scheduleNextPoll() {
  clearTimeout(state.pollTimeout);
  if (!state.running) return;
  const intervalMs = Math.max(1000, Number(getTelegramRuntimeSettingsSync()?.polling_interval_ms || 3000));
  state.pollTimeout = setTimeout(() => {
    pollOnce().catch((error) => console.error('Errore loop Telegram:', error));
  }, intervalMs);
}

function stopTelegramBot() {
  state.running = false;
  clearTimeout(state.pollTimeout);
  state.pollTimeout = null;
}

function startTelegramBot() {
  const settings = getTelegramRuntimeSettingsSync();
  const enabled = settings.enabled === true && String(settings.bot_token || '').trim();
  if (!enabled) {
    stopTelegramBot();
    return;
  }
  if (state.running) return;
  state.running = true;
  syncTelegramCommands()
    .catch((error) => console.error('Errore registrazione comandi Telegram:', error?.message || error))
    .finally(() => {
      if (state.running) {
        scheduleNextPoll();
      }
    });
}

function initializeTelegramBot() {
  startTelegramBot();
}

function refreshTelegramBotRuntime() {
  stopTelegramBot();
  startTelegramBot();
}

module.exports = {
  initializeTelegramBot,
  refreshTelegramBotRuntime,
  sendTelegramMessage,
};
