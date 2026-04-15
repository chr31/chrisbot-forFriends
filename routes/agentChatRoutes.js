const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { ADMIN_SHARED_OWNER, isSuperAdminUser } = require('../utils/adminAccess');
const {
  getAgentChatByChatId,
  getMessagesByAgentChatId,
  markAgentChatAsRead,
  getAgentChatSummaries,
  deleteAgentChat,
  deleteAllAgentChats,
} = require('../database/db_agent_chats');
const { getLatestAgentRunByChatId, getAgentRunsByChatId } = require('../database/db_agent_runs');
const { executeAgentChat } = require('../services/agentChatExecutor');

router.use(authenticateToken);

router.get('/', async (req, res) => {
  try {
    const rows = await getAgentChatSummaries(
      isSuperAdminUser(req.user) ? [req.user?.name, ADMIN_SHARED_OWNER] : req.user?.name
    );
    return res.json(rows);
  } catch (error) {
    console.error('Errore nel recupero delle chat agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/runs/:chatId', async (req, res) => {
  try {
    const chat = await getAgentChatByChatId(req.params.chatId);
    if (!chat || (chat.owner_username !== req.user?.name && !(chat.owner_username === ADMIN_SHARED_OWNER && isSuperAdminUser(req.user)))) {
      return res.status(404).json({ error: 'Chat non trovata' });
    }
    const includeTree = String(req.query.tree || '').trim().toLowerCase() === 'true';
    if (includeTree) {
      const runs = await getAgentRunsByChatId(req.params.chatId);
      return res.json(runs);
    }
    const run = await getLatestAgentRunByChatId(req.params.chatId);
    if (!run) {
      return res.status(404).json({ error: 'Nessun run trovato per questa chat' });
    }
    return res.json(run);
  } catch (error) {
    console.error('Errore nel recupero run agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/meta/:chatId', async (req, res) => {
  try {
    const chat = await getAgentChatByChatId(req.params.chatId);
    if (!chat || (chat.owner_username !== req.user?.name && !(chat.owner_username === ADMIN_SHARED_OWNER && isSuperAdminUser(req.user)))) {
      return res.status(404).json({ error: 'Chat non trovata' });
    }
    return res.json({
      chat_id: chat.chat_id,
      agent_id: chat.agent_id,
      config_json: chat.config_json || {},
    });
  } catch (error) {
    console.error('Errore nel recupero meta chat agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/:chatId/read', async (req, res) => {
  try {
    const chat = await getAgentChatByChatId(req.params.chatId);
    if (!chat || (chat.owner_username !== req.user?.name && !(chat.owner_username === ADMIN_SHARED_OWNER && isSuperAdminUser(req.user)))) {
      return res.status(404).json({ error: 'Chat non trovata' });
    }
    await markAgentChatAsRead(req.params.chatId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore mark as read agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.delete('/:chatId', async (req, res) => {
  try {
    const ownerUsername = isSuperAdminUser(req.user) ? [req.user?.name, ADMIN_SHARED_OWNER] : req.user?.name;
    const result = await deleteAgentChat(req.params.chatId, ownerUsername);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Chat non trovata' });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore delete chat agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.delete('/', async (req, res) => {
  try {
    const ownerUsername = isSuperAdminUser(req.user) ? [req.user?.name, ADMIN_SHARED_OWNER] : req.user?.name;
    const result = await deleteAllAgentChats(ownerUsername);
    return res.json({ ok: true, deleted: result.changes || 0 });
  } catch (error) {
    console.error('Errore delete massivo chat agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/:chatId', async (req, res) => {
  try {
    const chat = await getAgentChatByChatId(req.params.chatId);
    if (!chat || (chat.owner_username !== req.user?.name && !(chat.owner_username === ADMIN_SHARED_OWNER && isSuperAdminUser(req.user)))) {
      return res.status(404).json({ error: 'Chat non trovata' });
    }
    const messages = await getMessagesByAgentChatId(req.params.chatId);
    return res.json(messages);
  } catch (error) {
    console.error('Errore nel recupero storico chat agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const result = await executeAgentChat({
      ...(req.body || {}),
      user: req.user,
      owner_username: req.user?.name,
    });
    return res.json(result);
  } catch (error) {
    console.error('Errore durante l\'esecuzione chat agente:', error);
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Errore del server durante la chat agente' });
  }
});

module.exports = router;
