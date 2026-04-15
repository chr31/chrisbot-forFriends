// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const authenticateToken = require('../middleware/authenticateToken');
const {
  isSuperAdminUser,
  getConfiguredSuperAdmins,
  getUserGroups,
  getConfiguredPortalLoginUpns,
  getConfiguredPortalLoginGroups,
  getConfiguredSuperAdminUpns,
  getConfiguredSuperAdminGroups,
} = require('../utils/adminAccess');
const {
  isAzureConfigured,
  createStateToken,
  verifyStateToken,
  buildAuthorizeUrl,
  redeemAuthorizationCode,
  validateIdToken,
  createFrontendCallbackUrl,
} = require('../services/azureAuth');
const { getPortalAccessSettingsSync, updatePortalAccessSettings } = require('../services/appSettings');

function normalizeClaimsGroups(input) {
  if (!Array.isArray(input)) return [];
  return Array.from(new Set(input.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)));
}

function buildAppTokenUser(user) {
  const normalizedGroups = getUserGroups(user);
  return {
    name: user.name,
    email: user.email || null,
    oid: user.oid || null,
    groups: normalizedGroups,
    auth_provider: user.auth_provider || 'local',
    is_super_admin: isSuperAdminUser({ ...user, groups: normalizedGroups }),
  };
}

function getNormalizedUserIdentifiers(claims) {
  return Array.from(
    new Set(
      [
        claims?.preferred_username,
        claims?.email,
        claims?.upn,
        claims?.name,
        claims?.oid,
      ]
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function signAppToken(user) {
  return jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '7d' });
}

function getLocalAdminCredentials() {
  const settings = getPortalAccessSettingsSync();
  return {
    username: String(settings?.local_admin_username || '').trim(),
    password: String(settings?.local_admin_password || '').trim(),
  };
}

function isLocalLoginEnabled() {
  return getPortalAccessSettingsSync()?.local_login_enabled === true;
}

function isLocalAdminConfigured() {
  const credentials = getLocalAdminCredentials();
  return Boolean(credentials.username && credentials.password);
}

function isInitialLocalAccountSetupRequired() {
  return !isAzureConfigured() && !isLocalAdminConfigured();
}

router.get('/providers', (_req, res) => {
  return res.json({
    local: isLocalLoginEnabled() && isLocalAdminConfigured(),
    azure: isAzureConfigured(),
    local_login_enabled: isLocalLoginEnabled(),
    local_account_configured: isLocalAdminConfigured(),
    setup_required: isInitialLocalAccountSetupRequired(),
  });
});

// Endpoint per il login dell'utente
router.post('/login', (req, res) => {
  if (!isLocalLoginEnabled()) {
    return res.status(403).json({ error: 'Login locale disabilitato.' });
  }

  const { username, password } = req.body;
  const configuredCredentials = getLocalAdminCredentials();

  if (!isLocalAdminConfigured()) {
    return res.status(503).json({ error: 'Account locale non configurato.' });
  }

  if (username === configuredCredentials.username && password === configuredCredentials.password) {
    const user = buildAppTokenUser({
      name: username,
      groups: getUserGroups(username),
      auth_provider: 'local',
    });

    const accessToken = signAppToken(user);

    res.json({
      accessToken,
      user: {
        name: username,
        is_super_admin: user.is_super_admin,
        groups: user.groups,
        auth_provider: user.auth_provider,
      },
    });
  } else {
    return res.status(401).json({ error: 'Credenziali non valide.' });
  }
});

router.post('/setup-local-account', async (req, res) => {
  try {
    if (!isInitialLocalAccountSetupRequired()) {
      return res.status(403).json({ error: 'Configurazione iniziale non disponibile.' });
    }

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '').trim();
    if (!username || !password) {
      return res.status(400).json({ error: 'Username e password sono obbligatori.' });
    }

    const settings = getPortalAccessSettingsSync();
    const normalizedUsername = username.toLowerCase();
    const currentSuperAdmins = Array.isArray(settings?.super_admin_upns) ? settings.super_admin_upns : [];
    const nextSuperAdmins = currentSuperAdmins.includes(normalizedUsername)
      ? currentSuperAdmins
      : [...currentSuperAdmins, normalizedUsername];
    await updatePortalAccessSettings({
      ...settings,
      local_login_enabled: true,
      local_admin_username: username,
      local_admin_password: password,
      super_admin_upns: nextSuperAdmins,
    });

    const user = buildAppTokenUser({
      name: username,
      groups: getUserGroups(username),
      auth_provider: 'local',
    });
    const accessToken = signAppToken(user);

    return res.status(201).json({
      accessToken,
      user: {
        name: username,
        is_super_admin: user.is_super_admin,
        groups: user.groups,
        auth_provider: user.auth_provider,
      },
    });
  } catch (error) {
    console.error('Errore setup account locale iniziale:', error);
    return res.status(400).json({ error: error.message || 'Impossibile creare l’account locale.' });
  }
});

router.get('/azure/start', (req, res) => {
  try {
    if (!isAzureConfigured()) {
      return res.status(503).json({ error: 'Azure login non configurato sul backend.' });
    }
    const nonce = require('crypto').randomUUID();
    const state = createStateToken({
      nonce,
      return_to: String(req.query.return_to || '/agent-chat/new'),
    });
    return res.redirect(buildAuthorizeUrl(state, nonce));
  } catch (error) {
    console.error('Errore avvio login Azure:', error);
    return res.status(500).json({ error: 'Impossibile avviare il login Azure.' });
  }
});

router.get('/azure/callback', async (req, res) => {
  try {
    if (!isAzureConfigured()) {
      return res.redirect(createFrontendCallbackUrl({ error: 'azure_not_configured' }));
    }

    if (req.query.error) {
      return res.redirect(createFrontendCallbackUrl({ error: String(req.query.error_description || req.query.error) }));
    }

    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();
    if (!code || !state) {
      return res.redirect(createFrontendCallbackUrl({ error: 'missing_code_or_state' }));
    }

    const statePayload = verifyStateToken(state);
    const tokenResponse = await redeemAuthorizationCode(code);
    const idTokenClaims = await validateIdToken(tokenResponse.id_token, statePayload.nonce);
    const azureGroups = normalizeClaimsGroups(idTokenClaims.groups);
    const userIdentifiers = getNormalizedUserIdentifiers(idTokenClaims);
    const allowedPortalUpns = getConfiguredPortalLoginUpns();
    const allowedPortalGroups = getConfiguredPortalLoginGroups();
    const superAdminUpns = getConfiguredSuperAdminUpns();
    const superAdminGroups = getConfiguredSuperAdminGroups();
    const hasGroupsOverage = Boolean(idTokenClaims.hasgroups || (idTokenClaims._claim_names && idTokenClaims._claim_names.groups));

    if (hasGroupsOverage) {
      return res.redirect(createFrontendCallbackUrl({ error: 'azure_groups_overage_configure_group_claims' }));
    }

    const canLogin = (allowedPortalGroups.length === 0 && allowedPortalUpns.length === 0)
      || userIdentifiers.some((identifier) => allowedPortalUpns.includes(identifier))
      || userIdentifiers.some((identifier) => superAdminUpns.includes(identifier))
      || azureGroups.some((group) => allowedPortalGroups.includes(group))
      || azureGroups.some((group) => superAdminGroups.includes(group));

    if (!canLogin) {
      return res.redirect(createFrontendCallbackUrl({ error: 'azure_user_not_allowed' }));
    }

    const user = buildAppTokenUser({
      name: String(idTokenClaims.preferred_username || idTokenClaims.email || idTokenClaims.upn || idTokenClaims.name || idTokenClaims.oid || 'unknown'),
      email: idTokenClaims.preferred_username || idTokenClaims.email || null,
      oid: idTokenClaims.oid || idTokenClaims.sub || null,
      groups: azureGroups,
      auth_provider: 'azure',
    });
    const accessToken = signAppToken(user);
    return res.redirect(createFrontendCallbackUrl({ accessToken }));
  } catch (error) {
    console.error('Errore callback login Azure:', error);
    return res.redirect(createFrontendCallbackUrl({ error: error.message || 'azure_login_failed' }));
  }
});

router.get('/me', authenticateToken, (req, res) => {
  return res.json({
    user: {
      name: req.user?.name || null,
      email: req.user?.email || null,
      auth_provider: req.user?.auth_provider || 'local',
      is_super_admin: isSuperAdminUser(req.user),
      groups: getUserGroups(req.user),
    },
    super_admin_users: getConfiguredSuperAdmins(),
  });
});

module.exports = router;
