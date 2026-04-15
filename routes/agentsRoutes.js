const express = require('express');
const router = express.Router();
const authenticateToken = require('../middleware/authenticateToken');
const { requireSuperAdmin } = require('../utils/adminAccess');
const { listMcpToolMetadata, reconnectAndRefreshToolCache } = require('../utils/mcpClient');
const {
  insertAgent,
  updateAgent,
  getAgentById,
  getAllAgents,
  deleteAgent,
  replaceAgentTools,
  replaceAgentRelations,
  replaceAgentPermissions,
} = require('../database/db_agents');
const { buildAgentDetails, canUserAccessAgent, getAccessibleAgentsForUser } = require('../services/agentAccess');

router.use(authenticateToken);

router.get('/catalog', async (req, res) => {
  try {
    const agents = await getAccessibleAgentsForUser(req.user);
    const catalog = agents
      .filter((agent) => agent.direct_chat_enabled && agent.is_active)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        slug: agent.slug,
        kind: agent.kind,
        user_description: agent.user_description || '',
        default_model_config: agent.default_model_config,
        direct_chat_enabled: agent.direct_chat_enabled,
        is_active: agent.is_active,
      }));
    return res.json(catalog);
  } catch (error) {
    console.error('Errore nel recupero catalogo agenti:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.use(requireSuperAdmin);

function normalizeCreatePayload(body, username) {
  return {
    name: body?.name,
    slug: body?.slug,
    kind: body?.kind,
    user_description: body?.user_description,
    allowed_group_names_csv: body?.allowed_group_names_csv,
    system_prompt: body?.system_prompt,
    model_config: body?.default_model_config,
    guardrails: body?.guardrails,
    visibility_scope: body?.visibility_scope,
    direct_chat_enabled: body?.direct_chat_enabled,
    is_active: body?.is_active,
    created_by: username,
  };
}

async function syncAgentAssociations(agentId, body) {
  if (body?.tool_names !== undefined) {
    await replaceAgentTools(agentId, body.tool_names);
  }
  if (body?.kind === 'orchestrator' || body?.relations !== undefined || body?.child_agent_ids !== undefined) {
    const relations = body?.relations !== undefined ? body.relations : (body?.child_agent_ids || []);
    await replaceAgentRelations(agentId, relations);
  }
  if (body?.permissions !== undefined) {
    await replaceAgentPermissions(agentId, body.permissions);
  }
}

router.get('/tools', async (_req, res) => {
  try {
    let tools = await listMcpToolMetadata();
    if (!Array.isArray(tools) || tools.length === 0) {
      await reconnectAndRefreshToolCache();
      tools = await listMcpToolMetadata();
    }
    return res.json(tools);
  } catch (error) {
    console.error('Errore nel recuperare i tool per gli agenti:', error.message);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/', async (req, res) => {
  try {
    const agents = await getAllAgents();
    const enriched = await Promise.all(agents.map(buildAgentDetails));
    return res.json(enriched);
  } catch (error) {
    console.error('Errore nel recuperare gli agenti:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const agent = await getAgentById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agente non trovato' });
    }
    const canAccess = await canUserAccessAgent(agent, req.user, 'chat');
    const canManage = await canUserAccessAgent(agent, req.user, 'manage');
    if (!canAccess && !canManage) {
      return res.status(403).json({ error: 'Accesso negato' });
    }
    const details = await buildAgentDetails(agent);
    return res.json(details);
  } catch (error) {
    console.error('Errore nel recuperare il dettaglio agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = normalizeCreatePayload(req.body, req.user?.name);
    const created = await insertAgent(payload);
    await syncAgentAssociations(created.id, req.body || {});
    const agent = await buildAgentDetails(await getAgentById(created.id));
    return res.status(201).json(agent);
  } catch (error) {
    console.error('Errore nella creazione agente:', error);
    return res.status(400).json({ error: error.message || 'Impossibile creare l\'agente' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const agent = await getAgentById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agente non trovato' });
    }
    const canManage = await canUserAccessAgent(agent, req.user, 'manage');
    if (!canManage) {
      return res.status(403).json({ error: 'Accesso negato' });
    }
    await updateAgent(req.params.id, req.body || {});
    await syncAgentAssociations(req.params.id, req.body || {});
    const updated = await buildAgentDetails(await getAgentById(req.params.id));
    return res.json(updated);
  } catch (error) {
    console.error('Errore nell\'aggiornamento agente:', error);
    return res.status(400).json({ error: error.message || 'Impossibile aggiornare l\'agente' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const agent = await getAgentById(req.params.id);
    if (!agent) {
      return res.status(404).json({ error: 'Agente non trovato' });
    }
    const canManage = await canUserAccessAgent(agent, req.user, 'manage');
    if (!canManage) {
      return res.status(403).json({ error: 'Accesso negato' });
    }
    const result = await deleteAgent(req.params.id);
    return res.json({ deleted: result.changes > 0 });
  } catch (error) {
    console.error('Errore nell\'eliminazione agente:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

module.exports = router;
