const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const {
  upsertWebPushSubscription,
  deleteWebPushSubscription,
} = require('../database/db_web_push');
const { getPublicVapidKey, ensureWebPushConfigured } = require('../services/webPushService');

router.use(authenticateToken);

router.get('/public-key', async (_req, res) => {
  const publicKey = getPublicVapidKey();
  if (!publicKey || !ensureWebPushConfigured()) {
    return res.status(503).json({ error: 'Web Push non configurato sul backend.' });
  }
  return res.json({ publicKey });
});

router.post('/subscribe', async (req, res) => {
  try {
    await upsertWebPushSubscription({
      owner_username: req.user?.name || null,
      subscription: req.body?.subscription || null,
      user_agent: req.headers['user-agent'] || null,
    });
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore salvataggio subscription Web Push:', error);
    return res.status(400).json({ error: error.message || 'Subscription non valida' });
  }
});

router.delete('/subscribe', async (req, res) => {
  try {
    const endpoint = String(req.body?.endpoint || req.query?.endpoint || '').trim();
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint è obbligatorio.' });
    }
    const result = await deleteWebPushSubscription(endpoint, req.user?.name || null);
    return res.json({ ok: true, deleted: result.changes || 0 });
  } catch (error) {
    console.error('Errore rimozione subscription Web Push:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

module.exports = router;
