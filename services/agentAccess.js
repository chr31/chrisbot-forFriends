const {
  getAllAgents,
  getAgentPermissions,
  getAgentToolNames,
  getAgentRelations,
} = require('../database/db_agents');
const { ADMIN_GROUP_NAME, getUserGroups, isSuperAdminUser, expandAzureGroupReferences } = require('../utils/adminAccess');

async function buildAgentDetails(agent) {
  if (!agent) return null;
  const [tool_names, relations, permissions] = await Promise.all([
    getAgentToolNames(agent.id),
    agent.kind === 'orchestrator' ? getAgentRelations(agent.id) : Promise.resolve([]),
    getAgentPermissions(agent.id),
  ]);
  return {
    ...agent,
    tool_names,
    relations,
    permissions,
  };
}

function getNormalizedUsername(userOrUsername) {
  if (typeof userOrUsername === 'string') return String(userOrUsername || '').trim();
  return String(userOrUsername?.name || '').trim();
}

function getUserIdentifiers(userOrUsername) {
  if (typeof userOrUsername === 'string') {
    const normalized = String(userOrUsername || '').trim().toLowerCase();
    return normalized ? { user: [normalized], upn: [normalized] } : { user: [], upn: [] };
  }

  const normalizedName = String(userOrUsername?.name || '').trim().toLowerCase();
  const normalizedEmail = String(userOrUsername?.email || '').trim().toLowerCase();
  return {
    user: normalizedName ? [normalizedName] : [],
    upn: Array.from(new Set([normalizedName, normalizedEmail].filter(Boolean))),
  };
}

function hasPermissionRole(permissions, userOrUsername, role) {
  const identifiers = getUserIdentifiers(userOrUsername);
  return permissions.some((entry) =>
    (entry.subject_type === 'user' || entry.subject_type === 'upn') &&
    identifiers[entry.subject_type]?.includes(String(entry.subject_id).trim().toLowerCase()) &&
    (entry.role === role || entry.role === 'manage')
  );
}

function hasAllowedGroupAccess(agent, userOrUsername) {
  const userGroups = getUserGroups(userOrUsername);
  if (userGroups.includes(ADMIN_GROUP_NAME)) return true;
  const allowedGroups = expandAzureGroupReferences(
    Array.isArray(agent?.allowed_group_names) ? agent.allowed_group_names : []
  );
  if (allowedGroups.length === 0) return false;
  return allowedGroups.some((groupName) => userGroups.includes(String(groupName || '').trim().toLowerCase()));
}

async function canUserAccessAgent(agent, userOrUsername, purpose = 'chat') {
  if (!agent) return false;
  if (purpose === 'chat' && !agent.is_active) return false;
  const normalizedUser = getNormalizedUsername(userOrUsername);
  if (isSuperAdminUser(userOrUsername)) return true;
  if (!normalizedUser) return false;
  if (String(agent.created_by || '') === normalizedUser) return true;
  if (hasAllowedGroupAccess(agent, userOrUsername)) return true;

  if (agent.visibility_scope === 'public' && purpose === 'chat') return true;

  const permissions = await getAgentPermissions(agent.id);
  if (purpose === 'manage') {
    return hasPermissionRole(permissions, userOrUsername, 'manage');
  }
  if (hasPermissionRole(permissions, userOrUsername, 'chat')) return true;
  return agent.visibility_scope === 'public';
}

async function getAccessibleAgentsForUser(userOrUsername) {
  const agents = await getAllAgents();
  const decisions = await Promise.all(
    agents.map(async (agent) => ({
      agent,
      allowed: await canUserAccessAgent(agent, userOrUsername, 'chat'),
    }))
  );

  const visibleAgents = decisions.filter((entry) => entry.allowed).map((entry) => entry.agent);
  const enriched = await Promise.all(visibleAgents.map(buildAgentDetails));
  return enriched;
}

module.exports = {
  buildAgentDetails,
  canUserAccessAgent,
  getAccessibleAgentsForUser,
};
