const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { ADMIN_SHARED_OWNER, isSuperAdminUser } = require('../utils/adminAccess');
const { getAgentById } = require('../database/db_agents');
const {
  insertInboxItem,
  updateInboxItem,
  getInboxItemById,
  getInboxItemsForUser,
  getInboxCategoriesForUser,
  insertInboxMessage,
  getInboxMessages,
  markInboxItemAsRead,
  deleteInboxItem,
  deleteInboxItemsForUser,
  normalizeItemStatus,
} = require('../database/db_inbox');
const { insertTaskEvent } = require('../database/db_tasks');
const { getAgentChatByChatId, getMessagesByAgentChatId, insertAgentMessages } = require('../database/db_agent_chats');
const { insertAgentRun, updateAgentRunIfStatus } = require('../database/db_agent_runs');
const { buildInitialAgentHistory, runAgentConversation, sanitizeMessages } = require('../services/agentRunner');
const { getAgentDefaultModelConfig, normalizeModelConfig } = require('../services/aiModelCatalog');
const { runBeforeMemory, runAfterMemory } = require('../services/memory/memoryOrchestrator');
const { buildMemoryRunTrace } = require('../services/memory/memoryRunTrace');

router.use(authenticateToken);

async function loadOwnedInboxItem(id, user) {
  const item = await getInboxItemById(id);
  if (!item) return null;
  if (item.owner_username === user?.name) return item;
  if (item.owner_username === ADMIN_SHARED_OWNER && isSuperAdminUser(user)) return item;
  return null;
}

async function mirrorInboxMessageToLinkedDomains(item, input) {
  if (item.task_id) {
    await insertTaskEvent({
      task_id: item.task_id,
      task_run_id: item.task_run_id || null,
      event_type: input.event_type || 'inbox_reply',
      actor_type: input.actor_type || 'user',
      actor_id: input.actor_id || null,
      content: input.content,
      payload_json: input.payload_json || {},
    });
  }

  if (item.chat_id) {
    const chat = await getAgentChatByChatId(item.chat_id);
    if (chat && chat.owner_username === item.owner_username) {
      await insertAgentMessages([{
        chat_id: item.chat_id,
        agent_id: input.agent_id || item.agent_id || null,
        role: input.agent_message_role || 'user',
        event_type: input.agent_event_type || 'inbox_reply',
        content: input.content,
        metadata_json: input.payload_json || {},
      }]);
    }
  }
}

async function continueInboxConversation(item, username, content) {
  if (!item?.chat_id) return null;

  const chat = await getAgentChatByChatId(item.chat_id);
  if (!chat || chat.owner_username !== item.owner_username) return null;

  const agent = await getAgentById(chat.agent_id);
  if (!agent || !agent.is_active) return null;

  const existingMessages = await getMessagesByAgentChatId(chat.chat_id);
  const history = await buildInitialAgentHistory(agent, existingMessages);
  if (!history.length || history[history.length - 1]?.role !== 'user' || String(history[history.length - 1]?.content || '').trim() !== content) {
    history.push({ role: 'user', content });
  }

  const run = await insertAgentRun({
    chat_id: chat.chat_id,
    agent_id: agent.id,
    status: 'running',
    model_name: getAgentDefaultModelConfig(agent).model,
    model_provider: getAgentDefaultModelConfig(agent).provider,
    depth: 0,
    started_at: new Date(),
  });
  const modelConfig = normalizeModelConfig(chat.config_json?.model_config || {}, getAgentDefaultModelConfig(agent));
  const userMessage = { role: 'user', content };
  const memoryContextPacket = await runBeforeMemory({
    agent,
    chat: {
      chatId: chat.chat_id,
      messages: sanitizeMessages(history),
      sourceMessages: history,
      userMessage,
      runId: run.id,
      userKey: item.owner_username || username || null,
      owner_username: item.owner_username || username || null,
    },
    runId: run.id,
    userKey: item.owner_username || username || null,
    modelConfig,
  });

  try {
    const response = await runAgentConversation(agent, history, {
      chatId: chat.chat_id,
      agentId: agent.id,
      ollamaServerId: modelConfig.ollama_server_id,
      parentRunId: null,
      runId: run.id,
      parentAgentId: null,
      modelConfig,
      depth: 0,
      userKey: item.owner_username || username || null,
    });
    const afterMemoryPacket = await runAfterMemory({
      agent,
      chat: {
        chatId: chat.chat_id,
        runId: run.id,
        messages: sanitizeMessages(history),
        sourceMessages: history,
        userMessage,
        assistantResponse: response,
        userKey: item.owner_username || username || null,
      },
      modelConfig,
      beforePacket: memoryContextPacket,
      runId: run.id,
      userKey: item.owner_username || username || null,
      processStatus: 'completed',
    });
    await updateAgentRunIfStatus(run.id, {
      status: 'completed',
      finished_at: new Date(),
      guardrail_result_json: buildMemoryRunTrace(memoryContextPacket, afterMemoryPacket),
    }, 'running');

    const responseText = String(typeof response === 'string' ? response : JSON.stringify(response)).trim();
    if (responseText) {
      await insertInboxMessage({
        inbox_item_id: item.id,
        role: 'agent',
        message_type: 'message',
        agent_id: agent.id,
        content: responseText,
        metadata_json: { source: 'agent_reply', agent_run_id: run.id },
      });
      await updateInboxItem(item.id, {
        status: 'open',
        is_read: 0,
        last_message_at: new Date(),
      });
    }
    return { runId: run.id, response: responseText };
  } catch (error) {
    let memoryTrace = null;
    try {
      const afterMemoryPacket = await runAfterMemory({
        agent,
        chat: {
          chatId: chat.chat_id,
          runId: run.id,
          messages: sanitizeMessages(history),
          sourceMessages: history,
          userMessage,
          assistantResponse: '',
          error,
          userKey: item.owner_username || username || null,
        },
        modelConfig,
        beforePacket: memoryContextPacket,
        runId: run.id,
        userKey: item.owner_username || username || null,
        processStatus: 'failed',
        error,
      });
      memoryTrace = buildMemoryRunTrace(memoryContextPacket, afterMemoryPacket);
    } catch (memoryError) {
      memoryTrace = buildMemoryRunTrace(memoryContextPacket, {
        enabled: false,
        scope: agent?.memory_scope || 'shared',
        warnings: [String(memoryError?.message || memoryError)],
        skipped_reason: 'error',
      });
    }
    await updateAgentRunIfStatus(run.id, {
      status: 'failed',
      finished_at: new Date(),
      last_error: String(error?.message || error),
      guardrail_result_json: memoryTrace,
    }, 'running');
    await insertInboxMessage({
      inbox_item_id: item.id,
      role: 'system',
      message_type: 'status_update',
      agent_id: agent.id,
      content: `Errore nella continuazione della conversazione: ${String(error?.message || error)}`,
      metadata_json: { source: 'agent_reply_error' },
    });
    await updateInboxItem(item.id, {
      status: 'open',
      is_read: 0,
      last_message_at: new Date(),
    });
    return null;
  }
}

router.get('/', async (req, res) => {
  try {
    const ownerUsername = isSuperAdminUser(req.user) ? [req.user?.name, ADMIN_SHARED_OWNER] : req.user?.name;
    const items = await getInboxItemsForUser(ownerUsername, {
      status: req.query.status,
      category: req.query.category,
      task_id: req.query.task_id,
      includeResolved: String(req.query.include_resolved || '').trim().toLowerCase() === 'true',
      includeDismissed: String(req.query.include_dismissed || '').trim().toLowerCase() === 'true',
    });
    return res.json(items);
  } catch (error) {
    console.error('Errore nel recupero inbox:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/categories', async (req, res) => {
  try {
    const ownerUsername = isSuperAdminUser(req.user) ? [req.user?.name, ADMIN_SHARED_OWNER] : req.user?.name;
    const categories = await getInboxCategoriesForUser(ownerUsername, {
      includeResolved: String(req.query.include_resolved || '').trim().toLowerCase() === 'true',
      includeDismissed: String(req.query.include_dismissed || '').trim().toLowerCase() === 'true',
    });
    return res.json(categories);
  } catch (error) {
    console.error('Errore nel recupero categorie inbox:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await insertInboxItem({
      ...(req.body || {}),
      owner_username: req.user?.name || null,
    });
    const item = await getInboxItemById(created.id);
    if (req.body?.description) {
      await insertInboxMessage({
        inbox_item_id: created.id,
        role: 'system',
        message_type: 'message',
        content: String(req.body.description),
        metadata_json: { source: 'inbox_create' },
      });
    }
    return res.status(201).json(item);
  } catch (error) {
    console.error('Errore nella creazione inbox item:', error);
    return res.status(400).json({ error: error.message || 'Impossibile creare inbox item' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await loadOwnedInboxItem(req.params.id, req.user);
    if (!item) {
      return res.status(404).json({ error: 'Inbox item non trovato' });
    }
    await markInboxItemAsRead(item.id);
    const messages = await getInboxMessages(item.id);
    return res.json({
      ...(await getInboxItemById(item.id)),
      messages,
    });
  } catch (error) {
    console.error('Errore nel recupero inbox item:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const item = await loadOwnedInboxItem(req.params.id, req.user);
    if (!item) {
      return res.status(404).json({ error: 'Inbox item non trovato' });
    }
    await updateInboxItem(item.id, req.body || {});
    const updated = await getInboxItemById(item.id);
    return res.json(updated);
  } catch (error) {
    console.error('Errore aggiornamento inbox item:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare inbox item' });
  }
});

router.post('/:id/read', async (req, res) => {
  try {
    const item = await loadOwnedInboxItem(req.params.id, req.user);
    if (!item) {
      return res.status(404).json({ error: 'Inbox item non trovato' });
    }
    await markInboxItemAsRead(item.id);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore mark-as-read inbox:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/:id/reply', async (req, res) => {
  try {
    const item = await loadOwnedInboxItem(req.params.id, req.user);
    const content = String(req.body?.content || '').trim();
    if (!item) {
      return res.status(404).json({ error: 'Inbox item non trovato' });
    }
    if (!content) {
      return res.status(400).json({ error: 'content è obbligatorio.' });
    }

    await insertInboxMessage({
      inbox_item_id: item.id,
      role: 'user',
      message_type: 'message',
      username: req.user?.name || null,
      content,
      metadata_json: { source: 'user_reply' },
    });

    await updateInboxItem(item.id, {
      status: item.requires_reply ? 'pending_agent' : item.status,
      is_read: 1,
      last_message_at: new Date(),
    });

    await mirrorInboxMessageToLinkedDomains(item, {
      event_type: 'inbox_reply',
      actor_type: 'user',
      actor_id: req.user?.name || null,
      content,
      payload_json: { inbox_item_id: item.id },
      agent_message_role: 'user',
      agent_event_type: 'inbox_reply',
    });

    await continueInboxConversation(item, req.user?.name || null, content);

    const updated = await getInboxItemById(item.id);
    const messages = await getInboxMessages(item.id);
    return res.json({ ...updated, messages });
  } catch (error) {
    console.error('Errore reply inbox:', error);
    return res.status(400).json({ error: error.message || 'Impossibile inviare la risposta' });
  }
});

router.post('/:id/resolve', async (req, res) => {
  try {
    const item = await loadOwnedInboxItem(req.params.id, req.user);
    if (!item) {
      return res.status(404).json({ error: 'Inbox item non trovato' });
    }
    await updateInboxItem(item.id, {
      status: normalizeItemStatus(req.body?.status, 'resolved'),
      is_read: 1,
    });
    return res.json(await getInboxItemById(item.id));
  } catch (error) {
    console.error('Errore resolve inbox item:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare lo stato' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const item = await loadOwnedInboxItem(req.params.id, req.user);
    if (!item) {
      return res.status(404).json({ error: 'Inbox item non trovato' });
    }
    const result = await deleteInboxItem(item.id);
    return res.json({ deleted: result.changes > 0 });
  } catch (error) {
    console.error('Errore delete inbox item:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.delete('/', async (req, res) => {
  try {
    const ownerUsername = isSuperAdminUser(req.user) ? [req.user?.name, ADMIN_SHARED_OWNER] : req.user?.name;
    const category = String(req.query.category || req.body?.category || '').trim();
    const result = await deleteInboxItemsForUser(ownerUsername, {
      category: category || null,
    });
    return res.json({ deleted: result.changes });
  } catch (error) {
    console.error('Errore delete bulk inbox:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

module.exports = router;
