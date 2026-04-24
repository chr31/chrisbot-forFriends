const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireSuperAdmin } = require('../utils/adminAccess');
const {
  getSettingsSnapshot,
  updatePortalAccessSettings,
  updateMcpRuntimeSettings,
  updateOllamaRuntimeSettings,
  updateOpenAiRuntimeSettings,
  updateTelegramRuntimeSettings,
  revealSettingsSecret,
} = require('../services/appSettings');
const { getAiOptionsSnapshot } = require('../services/aiModelCatalog');
const {
  listTelegramUserLinks,
  upsertTelegramUserLink,
  deleteTelegramUserLink,
  listTelegramGroupTargets,
  upsertTelegramGroupTarget,
  deleteTelegramGroupTarget,
} = require('../database/db_telegram');
const { reconnectAndRefreshToolCache, getMcpConnectionStatuses } = require('../utils/mcpClient');
const { getOllamaConnectionStatuses } = require('../services/ollamaRuntime');
const { refreshTelegramBotRuntime } = require('../services/telegramBot');

router.use(authenticateToken);

router.get('/ai/options', async (_req, res) => {
  try {
    return res.json(getAiOptionsSnapshot());
  } catch (error) {
    console.error('Errore recupero opzioni AI:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.use(requireSuperAdmin);

router.get('/', async (_req, res) => {
  try {
    return res.json(getSettingsSnapshot());
  } catch (error) {
    console.error('Errore recupero impostazioni:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/mcp/status', async (_req, res) => {
  try {
    return res.json({
      connections: getMcpConnectionStatuses(),
    });
  } catch (error) {
    console.error('Errore recupero stato MCP:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/ollama/status', async (_req, res) => {
  try {
    return res.json({
      connections: await getOllamaConnectionStatuses(),
    });
  } catch (error) {
    console.error('Errore recupero stato Ollama:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/secrets/reveal', async (req, res) => {
  try {
    const value = revealSettingsSecret(req.body || {});
    console.info('Reveal secret impostazioni', {
      user: req.user?.name || 'unknown',
      area: req.body?.area,
      field: req.body?.field,
      connection_id: req.body?.connection_id,
      at: new Date().toISOString(),
    });
    return res.json({ value, expires_in_ms: 15000 });
  } catch (error) {
    console.error('Errore reveal secret impostazioni:', error);
    return res.status(400).json({ error: error.message || 'Impossibile rivelare il secret' });
  }
});

router.put('/portal-access', async (req, res) => {
  try {
    await updatePortalAccessSettings(req.body || {});
    return res.json(getSettingsSnapshot().portal_access);
  } catch (error) {
    console.error('Errore aggiornamento impostazioni portale:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare le impostazioni del portale' });
  }
});

router.put('/mcp', async (req, res) => {
  try {
    await updateMcpRuntimeSettings(req.body || {});
    await reconnectAndRefreshToolCache();
    return res.json(getSettingsSnapshot().mcp_runtime);
  } catch (error) {
    console.error('Errore aggiornamento impostazioni MCP:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare le impostazioni MCP' });
  }
});

router.put('/ollama', async (req, res) => {
  try {
    const updated = await updateOllamaRuntimeSettings(req.body || {});
    return res.json(updated);
  } catch (error) {
    console.error('Errore aggiornamento impostazioni Ollama:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare le impostazioni Ollama' });
  }
});

router.put('/openai', async (req, res) => {
  try {
    await updateOpenAiRuntimeSettings(req.body || {});
    return res.json(getSettingsSnapshot().openai_runtime);
  } catch (error) {
    console.error('Errore aggiornamento impostazioni OpenAI:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare le impostazioni OpenAI' });
  }
});

router.get('/telegram/users', async (_req, res) => {
  try {
    return res.json({ items: await listTelegramUserLinks() });
  } catch (error) {
    console.error('Errore elenco mapping Telegram:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/telegram/groups', async (_req, res) => {
  try {
    return res.json({ items: await listTelegramGroupTargets() });
  } catch (error) {
    console.error('Errore elenco gruppi Telegram:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.put('/telegram', async (req, res) => {
  try {
    await updateTelegramRuntimeSettings(req.body || {});
    refreshTelegramBotRuntime();
    return res.json(getSettingsSnapshot().telegram_runtime);
  } catch (error) {
    console.error('Errore aggiornamento impostazioni Telegram:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare le impostazioni Telegram' });
  }
});

router.post('/telegram/users', async (req, res) => {
  try {
    const saved = await upsertTelegramUserLink(req.body || {});
    return res.json(saved);
  } catch (error) {
    console.error('Errore salvataggio mapping Telegram:', error);
    return res.status(400).json({ error: error.message || 'Impossibile salvare il mapping Telegram' });
  }
});

router.delete('/telegram/users/:id', async (req, res) => {
  try {
    const result = await deleteTelegramUserLink(req.params.id);
    if (!result.changes) {
      return res.status(404).json({ error: 'Mapping non trovato' });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore eliminazione mapping Telegram:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/telegram/groups', async (req, res) => {
  try {
    const saved = await upsertTelegramGroupTarget(req.body || {});
    return res.json(saved);
  } catch (error) {
    console.error('Errore salvataggio gruppo Telegram:', error);
    return res.status(400).json({ error: error.message || 'Impossibile salvare il gruppo Telegram' });
  }
});

router.delete('/telegram/groups/:id', async (req, res) => {
  try {
    const result = await deleteTelegramGroupTarget(req.params.id);
    if (!result.changes) {
      return res.status(404).json({ error: 'Gruppo non trovato' });
    }
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore eliminazione gruppo Telegram:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

module.exports = router;
