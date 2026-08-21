const { getAgentById, updateAgent } = require('../../database/db_agents');

function requireAgentId(args = {}) {
  const agentId = Number(args._agentId);
  if (!Number.isFinite(agentId) || agentId <= 0) {
    throw new Error('Tool interno utilizzabile solo da un agente valido.');
  }
  return agentId;
}

async function getAgentStateField(agentId, field) {
  const agent = await getAgentById(agentId);
  if (!agent) {
    throw new Error('Agente non trovato.');
  }
  return String(agent[field] || '');
}

async function replaceAgentStateField(agentId, field, nextValue) {
  await updateAgent(agentId, { [field]: String(nextValue || '') });
  return String(nextValue || '');
}

async function getGoals(args = {}) {
  return getAgentStateField(requireAgentId(args), 'goals');
}

async function editGoals(args = {}) {
  return replaceAgentStateField(requireAgentId(args), 'goals', args.text);
}

module.exports = {
  getGoals,
  editGoals,
};
