const ADMIN_GROUP_NAME = 'chrisbot.admin';
const ADMIN_SHARED_OWNER = '__admin_shared__';
const { getPortalAccessSettingsSync } = require('../services/appSettings');

function normalizeGroupList(rawValue) {
  return Array.from(
    new Set(
      String(rawValue || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function getConfiguredSuperAdmins() {
  const portalSettings = getPortalAccessSettingsSync();
  return normalizeGroupList(portalSettings?.local_admin_username || '');
}

function getConfiguredPortalLoginUpns() {
  return normalizeGroupList(getPortalAccessSettingsSync()?.allowed_login_upns || '');
}

function getConfiguredPortalLoginGroups() {
  return expandAzureGroupReferences(
    normalizeGroupList(getPortalAccessSettingsSync()?.allowed_login_groups || '', [ADMIN_GROUP_NAME])
  );
}

function getConfiguredSuperAdminUpns() {
  const configured = normalizeGroupList(getPortalAccessSettingsSync()?.super_admin_upns || '');
  return configured.length > 0 ? configured : getConfiguredSuperAdmins();
}

function getConfiguredSuperAdminGroups() {
  return expandAzureGroupReferences(
    normalizeGroupList(getPortalAccessSettingsSync()?.super_admin_groups || '', [ADMIN_GROUP_NAME])
  );
}

function getAzureGroupDirectory() {
  const directory = getPortalAccessSettingsSync()?.group_directory;
  return Array.isArray(directory)
    ? directory.map((entry) => ({
        name: String(entry?.name || '').trim().toLowerCase(),
        object_id: String(entry?.object_id || '').trim().toLowerCase(),
      })).filter((entry) => entry.name && entry.object_id)
    : [];
}

function expandAzureGroupReferences(values) {
  const refs = normalizeGroupList(values || '');
  const directory = getAzureGroupDirectory();
  const expanded = new Set(refs);

  refs.forEach((ref) => {
    directory.forEach((entry) => {
      if (entry.name === ref || entry.object_id === ref) {
        expanded.add(entry.name);
        expanded.add(entry.object_id);
      }
    });
  });

  return Array.from(expanded);
}

function getStaticGroupsForUser(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) return [];
  const portalSettings = getPortalAccessSettingsSync();
  const configuredFrontendUser = String(portalSettings?.local_admin_username || '').trim().toLowerCase();
  const groups = [...getConfiguredPortalLoginGroups()];
  if (configuredFrontendUser && configuredFrontendUser === normalized) {
    const superAdminGroups = getConfiguredSuperAdminGroups();
    superAdminGroups.forEach((group) => {
      if (!groups.includes(group)) groups.push(group);
    });
    if (!groups.includes(ADMIN_GROUP_NAME) && superAdminGroups.includes(ADMIN_GROUP_NAME)) {
      groups.push(ADMIN_GROUP_NAME);
    }
    return Array.from(new Set(groups));
  }
  return isSuperAdminUsername(normalized) ? Array.from(new Set([ADMIN_GROUP_NAME, ...getConfiguredSuperAdminGroups()])) : [];
}

function isSuperAdminUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) return false;
  return getConfiguredSuperAdmins().includes(normalized) || getConfiguredSuperAdminUpns().includes(normalized);
}

function getUserGroups(userOrUsername) {
  if (!userOrUsername) return [];
  if (typeof userOrUsername === 'string') {
    return getStaticGroupsForUser(userOrUsername);
  }

  const tokenGroups = Array.isArray(userOrUsername.groups)
    ? userOrUsername.groups.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const staticGroups = getStaticGroupsForUser(userOrUsername.name);
  return Array.from(new Set([...tokenGroups, ...staticGroups]));
}

function isSuperAdminUser(userOrUsername) {
  const username = typeof userOrUsername === 'string' ? userOrUsername : userOrUsername?.name;
  const groups = getUserGroups(userOrUsername);
  return isSuperAdminUsername(username)
    || groups.includes(ADMIN_GROUP_NAME)
    || groups.some((group) => getConfiguredSuperAdminGroups().includes(group));
}

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdminUser(req.user)) {
    return res.status(403).json({ error: 'Accesso riservato ai super amministratori.' });
  }
  return next();
}

module.exports = {
  ADMIN_GROUP_NAME,
  ADMIN_SHARED_OWNER,
  getConfiguredSuperAdmins,
  getConfiguredPortalLoginUpns,
  getConfiguredPortalLoginGroups,
  getConfiguredSuperAdminUpns,
  getConfiguredSuperAdminGroups,
  getAzureGroupDirectory,
  expandAzureGroupReferences,
  getStaticGroupsForUser,
  getUserGroups,
  isSuperAdminUsername,
  isSuperAdminUser,
  requireSuperAdmin,
};
