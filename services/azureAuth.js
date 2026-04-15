const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { createPublicKey, verify: verifySignature } = require('crypto');
const { getPortalAccessSettingsSync } = require('./appSettings');

const OPENID_SCOPES = ['openid', 'profile', 'email'];
let discoveryCache = null;
let jwksCache = { at: 0, keys: [] };

function getAzureConfig() {
  const settings = getPortalAccessSettingsSync();
  const backendBaseUrl = String(settings?.backend_base_url || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '');
  const frontendBaseUrl = String(settings?.frontend_base_url || 'http://127.0.0.1:3001').replace(/\/$/, '');
  const tenantId = String(settings?.azure_tenant_id || 'common').trim() || 'common';
  const clientId = String(settings?.azure_client_id || '').trim();
  const clientSecret = String(settings?.azure_client_secret || '').trim();
  const redirectUri = String(settings?.azure_redirect_uri || `${backendBaseUrl}/api/auth/azure/callback`).trim();

  return {
    tenantId,
    clientId,
    clientSecret,
    frontendBaseUrl,
    redirectUri,
    authority: `https://login.microsoftonline.com/${tenantId}`,
  };
}

function isAzureConfigured() {
  const config = getAzureConfig();
  return Boolean(config.clientId && config.clientSecret && config.redirectUri);
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createStateToken(payload = {}) {
  return jwt.sign(
    {
      ...payload,
      type: 'azure_oauth_state',
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: '10m' }
  );
}

function verifyStateToken(stateToken) {
  return jwt.verify(stateToken, process.env.ACCESS_TOKEN_SECRET);
}

async function getDiscoveryDocument() {
  if (discoveryCache) return discoveryCache;
  const { authority } = getAzureConfig();
  const response = await axios.get(`${authority}/.well-known/openid-configuration`, { timeout: 10000 });
  discoveryCache = response.data;
  return discoveryCache;
}

async function getJwks() {
  const now = Date.now();
  if (jwksCache.keys.length > 0 && now - jwksCache.at < 60 * 60 * 1000) {
    return jwksCache.keys;
  }
  const discovery = await getDiscoveryDocument();
  const response = await axios.get(discovery.jwks_uri, { timeout: 10000 });
  jwksCache = {
    at: now,
    keys: Array.isArray(response.data?.keys) ? response.data.keys : [],
  };
  return jwksCache.keys;
}

function jwkToPem(jwk) {
  return createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' });
}

function decodeJwtSection(token, index) {
  const part = String(token || '').split('.')[index] || '';
  const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

async function validateIdToken(idToken, nonce) {
  const header = decodeJwtSection(idToken, 0);
  const payload = decodeJwtSection(idToken, 1);
  const signingInput = String(idToken).split('.').slice(0, 2).join('.');
  const signature = String(idToken).split('.')[2] || '';

  const discovery = await getDiscoveryDocument();
  const keys = await getJwks();
  const jwk = keys.find((entry) => entry.kid === header.kid);
  if (!jwk) {
    throw new Error('Chiave firma Azure non trovata.');
  }

  const pem = jwkToPem(jwk);
  const isValid = verifySignature(
    'RSA-SHA256',
    Buffer.from(signingInput),
    pem,
    Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  );

  if (!isValid) {
    throw new Error('Firma ID token Azure non valida.');
  }

  const { clientId, tenantId } = getAzureConfig();
  const now = Math.floor(Date.now() / 1000);
  const expectedIssuerPrefix = `https://login.microsoftonline.com/${tenantId}`;
  if (payload.aud !== clientId) {
    throw new Error('Audience ID token Azure non valida.');
  }
  if (typeof payload.iss !== 'string' || (!payload.iss.startsWith(expectedIssuerPrefix) && payload.iss !== discovery.issuer)) {
    throw new Error('Issuer ID token Azure non valido.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    throw new Error('ID token Azure scaduto.');
  }
  if (nonce && payload.nonce !== nonce) {
    throw new Error('Nonce ID token Azure non valido.');
  }

  return payload;
}

function buildAuthorizeUrl(stateToken, nonce) {
  const config = getAzureConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    response_mode: 'query',
    scope: OPENID_SCOPES.join(' '),
    state: stateToken,
  });
  if (nonce) {
    params.set('nonce', String(nonce));
  }

  return `${config.authority}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function redeemAuthorizationCode(code) {
  const config = getAzureConfig();
  const discovery = await getDiscoveryDocument();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'authorization_code',
    code: String(code || ''),
    redirect_uri: config.redirectUri,
    scope: OPENID_SCOPES.join(' '),
  });

  const response = await axios.post(discovery.token_endpoint, body.toString(), {
    timeout: 15000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  return response.data;
}

function createFrontendCallbackUrl({ accessToken, error }) {
  const { frontendBaseUrl } = getAzureConfig();
  const url = new URL(`${frontendBaseUrl}/login`);
  if (error) {
    url.searchParams.set('auth_error', error);
    return url.toString();
  }
  url.hash = new URLSearchParams({ accessToken }).toString();
  return url.toString();
}

module.exports = {
  getAzureConfig,
  isAzureConfigured,
  createStateToken,
  verifyStateToken,
  buildAuthorizeUrl,
  redeemAuthorizationCode,
  validateIdToken,
  createFrontendCallbackUrl,
};
