const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireSuperAdmin } = require('../utils/adminAccess');
const {
  getAliveAgentCatalog,
  getAliveAgentDetail,
  playAliveAgent,
  setAliveChatPaused,
  submitAliveAgentMessage,
  clearAliveAgentHistory,
} = require('../services/aliveAgentService');

router.use(authenticateToken);
router.use(requireSuperAdmin);

router.get('/', async (_req, res) => {
  try {
    const rows = await getAliveAgentCatalog();
    return res.json(rows);
  } catch (error) {
    console.error('Errore nel recupero catalogo alive agents:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/:agentId', async (req, res) => {
  try {
    const detail = await getAliveAgentDetail(req.params.agentId);
    if (!detail) {
      return res.status(404).json({ error: 'Agente alive non trovato' });
    }
    return res.json(detail);
  } catch (error) {
    console.error('Errore nel recupero dettaglio alive agent:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/:agentId/play', async (req, res) => {
  try {
    const result = await playAliveAgent(req.params.agentId, req.body || {});
    return res.json(result);
  } catch (error) {
    console.error('Errore play alive agent:', error);
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Errore del server' });
  }
});

router.post('/:agentId/pause', async (req, res) => {
  try {
    await setAliveChatPaused(req.params.agentId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore pause alive agent:', error);
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Errore del server' });
  }
});

router.post('/:agentId/messages', async (req, res) => {
  try {
    const result = await submitAliveAgentMessage(req.params.agentId, {
      user_message: req.body?.user_message,
      model_config: req.body?.model_config,
    });
    return res.json(result);
  } catch (error) {
    console.error('Errore invio messaggio alive agent:', error);
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Errore del server' });
  }
});

router.delete('/:agentId/messages', async (req, res) => {
  try {
    const result = await clearAliveAgentHistory(req.params.agentId);
    return res.json({ ok: true, deleted: result?.changes || 0 });
  } catch (error) {
    console.error('Errore reset chat alive agent:', error);
    return res.status(error?.statusCode || 500).json({ error: error?.message || 'Errore del server' });
  }
});

module.exports = router;
