const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireSuperAdmin } = require('../utils/adminAccess');
const {
  getControlSchemaContext,
  retrieveControlInfo,
  updateControlSchema,
  executeControlAction,
} = require('../services/control/controlOrchestrator');

function parseToolString(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return { ok: false, error: value };
  }
}

router.use(authenticateToken);
router.use(requireSuperAdmin);

router.get('/schema/context', async (_req, res) => {
  const result = parseToolString(await getControlSchemaContext());
  return res.status(result?.ok === false ? 400 : 200).json(result);
});

router.post('/retrieve', async (req, res) => {
  const result = parseToolString(await retrieveControlInfo(req.body || {}));
  return res.status(result?.ok === false ? 400 : 200).json(result);
});

router.post('/schema', async (req, res) => {
  const result = parseToolString(await updateControlSchema(req.body || {}));
  return res.status(result?.ok === false ? 400 : 200).json(result);
});

router.post('/execute', async (req, res) => {
  const result = parseToolString(await executeControlAction(req.body || {}));
  return res.status(result?.ok === false ? 400 : 200).json(result);
});

module.exports = router;
