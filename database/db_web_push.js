const pool = require('./mysql');
const crypto = require('crypto');

function toNullableString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function toJsonString(value) {
  return JSON.stringify(value === undefined ? null : value);
}

function parseJsonField(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function hashEndpoint(endpoint) {
  const normalized = toNullableString(endpoint);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

async function initWebPushTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_username VARCHAR(255) NOT NULL,
      endpoint VARCHAR(1024) NOT NULL,
      endpoint_hash CHAR(64) NOT NULL,
      p256dh VARCHAR(255) NOT NULL,
      auth VARCHAR(255) NOT NULL,
      user_agent VARCHAR(512) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_success_at DATETIME(3) NULL,
      last_error VARCHAR(512) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uniq_web_push_endpoint_hash (endpoint_hash),
      INDEX idx_web_push_owner (owner_username, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_push_queue (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_username VARCHAR(255) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NULL,
      url VARCHAR(1024) NULL,
      tag VARCHAR(255) NULL,
      payload_json JSON NULL,
      status ENUM('pending', 'processing', 'sent', 'failed') NOT NULL DEFAULT 'pending',
      attempts INT NOT NULL DEFAULT 0,
      last_error VARCHAR(512) NULL,
      sent_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_web_push_queue_status (status, created_at),
      INDEX idx_web_push_queue_owner (owner_username, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function upsertWebPushSubscription(input) {
  const ownerUsername = toNullableString(input?.owner_username);
  const endpoint = toNullableString(input?.subscription?.endpoint);
  const endpointHash = hashEndpoint(endpoint);
  const p256dh = toNullableString(input?.subscription?.keys?.p256dh);
  const auth = toNullableString(input?.subscription?.keys?.auth);
  if (!ownerUsername) throw new Error('owner_username is required');
  if (!endpoint || !endpointHash || !p256dh || !auth) throw new Error('Push subscription non valida');

  await pool.query(
    `INSERT INTO web_push_subscriptions
      (owner_username, endpoint, endpoint_hash, p256dh, auth, user_agent, is_active, last_error, last_success_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL)
     ON DUPLICATE KEY UPDATE
      owner_username = VALUES(owner_username),
      endpoint = VALUES(endpoint),
      p256dh = VALUES(p256dh),
      auth = VALUES(auth),
      user_agent = VALUES(user_agent),
      is_active = 1,
      last_error = NULL`,
    [ownerUsername, endpoint, endpointHash, p256dh, auth, toNullableString(input?.user_agent)]
  );
}

async function deleteWebPushSubscription(endpoint, ownerUsername = null) {
  const normalizedEndpoint = toNullableString(endpoint);
  const endpointHash = hashEndpoint(normalizedEndpoint);
  if (!normalizedEndpoint) return { changes: 0 };
  if (ownerUsername) {
    const [result] = await pool.query(
      'DELETE FROM web_push_subscriptions WHERE endpoint_hash = ? AND owner_username = ?',
      [endpointHash, String(ownerUsername).trim()]
    );
    return { changes: result.affectedRows || 0 };
  }
  const [result] = await pool.query('DELETE FROM web_push_subscriptions WHERE endpoint_hash = ?', [endpointHash]);
  return { changes: result.affectedRows || 0 };
}

async function getActiveWebPushSubscriptions(ownerUsername) {
  const normalized = toNullableString(ownerUsername);
  if (!normalized) return [];
  const [rows] = await pool.query(
    `SELECT id, owner_username, endpoint, p256dh, auth, user_agent, is_active, last_success_at, last_error
     FROM web_push_subscriptions
     WHERE owner_username = ? AND is_active = 1`,
    [normalized]
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      }))
    : [];
}

async function markWebPushSubscriptionSuccess(id) {
  await pool.query(
    'UPDATE web_push_subscriptions SET last_success_at = CURRENT_TIMESTAMP(3), last_error = NULL, is_active = 1 WHERE id = ?',
    [id]
  );
}

async function markWebPushSubscriptionError(id, errorMessage, deactivate = false) {
  await pool.query(
    'UPDATE web_push_subscriptions SET last_error = ?, is_active = ? WHERE id = ?',
    [toNullableString(errorMessage), deactivate ? 0 : 1, id]
  );
}

async function enqueueWebPushNotification(input) {
  const ownerUsername = toNullableString(input?.owner_username);
  const title = toNullableString(input?.title);
  if (!ownerUsername) throw new Error('owner_username is required');
  if (!title) throw new Error('title is required');
  const [result] = await pool.query(
    `INSERT INTO web_push_queue
      (owner_username, title, body, url, tag, payload_json, status, attempts, last_error, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL)`,
    [
      ownerUsername,
      title,
      toNullableString(input?.body),
      toNullableString(input?.url),
      toNullableString(input?.tag),
      input?.payload_json === undefined ? null : toJsonString(input.payload_json),
    ]
  );
  return { id: result.insertId };
}

async function claimPendingWebPushQueue(limit = 20) {
  const normalizedLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(100, Number(limit))) : 20;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT id, owner_username, title, body, url, tag, payload_json, attempts, created_at
       FROM web_push_queue
       WHERE status = 'pending'
       ORDER BY created_at ASC, id ASC
       LIMIT ?
       FOR UPDATE`,
      [normalizedLimit]
    );
    const ids = Array.isArray(rows) ? rows.map((row) => Number(row.id)).filter(Number.isFinite) : [];
    if (ids.length > 0) {
      await conn.query(
        `UPDATE web_push_queue
         SET status = 'processing', attempts = attempts + 1, last_error = NULL
         WHERE id IN (${ids.map(() => '?').join(', ')})`,
        ids
      );
    }
    await conn.commit();
    return Array.isArray(rows)
      ? rows.map((row) => ({
          ...row,
          payload_json: parseJsonField(row.payload_json, null),
        }))
      : [];
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function markWebPushQueueSent(id) {
  await pool.query(
    `UPDATE web_push_queue
     SET status = 'sent', sent_at = CURRENT_TIMESTAMP(3), last_error = NULL
     WHERE id = ?`,
    [id]
  );
}

async function markWebPushQueueFailed(id, errorMessage) {
  await pool.query(
    `UPDATE web_push_queue
     SET status = 'failed', last_error = ?
     WHERE id = ?`,
    [toNullableString(errorMessage), id]
  );
}

module.exports = {
  initWebPushTables,
  upsertWebPushSubscription,
  deleteWebPushSubscription,
  getActiveWebPushSubscriptions,
  markWebPushSubscriptionSuccess,
  markWebPushSubscriptionError,
  enqueueWebPushNotification,
  claimPendingWebPushQueue,
  markWebPushQueueSent,
  markWebPushQueueFailed,
};
