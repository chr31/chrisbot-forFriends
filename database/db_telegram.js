const pool = require('./mysql');

function parseJsonField(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function normalizeNullableString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

async function initTelegramTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_user_links (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      subject_type ENUM('user', 'upn') NOT NULL DEFAULT 'user',
      subject_id VARCHAR(255) NOT NULL,
      telegram_user_id VARCHAR(64) NOT NULL,
      receive_notifications TINYINT(1) NOT NULL DEFAULT 0,
      telegram_username VARCHAR(255) NULL,
      telegram_first_name VARCHAR(255) NULL,
      telegram_last_name VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uniq_telegram_subject (subject_type, subject_id),
      UNIQUE KEY uniq_telegram_user_id (telegram_user_id),
      INDEX idx_telegram_subject_id (subject_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    ALTER TABLE telegram_user_links
    ADD COLUMN receive_notifications TINYINT(1) NOT NULL DEFAULT 0 AFTER telegram_user_id
  `).catch((error) => {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') throw error;
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_chat_sessions (
      telegram_chat_id VARCHAR(64) NOT NULL PRIMARY KEY,
      telegram_user_id VARCHAR(64) NOT NULL,
      subject_type ENUM('user', 'upn') NOT NULL DEFAULT 'user',
      subject_id VARCHAR(255) NOT NULL,
      active_agent_chat_id VARCHAR(255) NULL,
      active_agent_id BIGINT UNSIGNED NULL,
      last_command VARCHAR(64) NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_telegram_session_user (telegram_user_id),
      INDEX idx_telegram_session_subject (subject_type, subject_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS telegram_group_targets (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      label VARCHAR(255) NOT NULL,
      telegram_chat_id VARCHAR(64) NOT NULL UNIQUE,
      is_enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function listTelegramUserLinks() {
  const [rows] = await pool.query(`
    SELECT id, subject_type, subject_id, telegram_user_id, receive_notifications, telegram_username, telegram_first_name, telegram_last_name, created_at, updated_at
    FROM telegram_user_links
    ORDER BY subject_id ASC, id ASC
  `);
  return Array.isArray(rows) ? rows : [];
}

async function getTelegramUserLinkByTelegramUserId(telegramUserId) {
  const [rows] = await pool.query(
    `SELECT id, subject_type, subject_id, telegram_user_id, receive_notifications, telegram_username, telegram_first_name, telegram_last_name, created_at, updated_at
     FROM telegram_user_links
     WHERE telegram_user_id = ?
     LIMIT 1`,
    [String(telegramUserId || '').trim()]
  );
  return rows?.[0] || null;
}

async function upsertTelegramUserLink(input = {}) {
  const id = input?.id ? Number(input.id) : null;
  const subjectType = String(input.subject_type || 'user').trim().toLowerCase() === 'upn' ? 'upn' : 'user';
  const subjectId = normalizeNullableString(input.subject_id);
  const telegramUserId = normalizeNullableString(input.telegram_user_id);
  if (!subjectId) throw new Error('subject_id obbligatorio');
  if (!telegramUserId) throw new Error('telegram_user_id obbligatorio');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    if (Number.isFinite(id) && id > 0) {
      await conn.query('DELETE FROM telegram_user_links WHERE id <> ? AND subject_type = ? AND subject_id = ?', [id, subjectType, subjectId]);
      await conn.query('DELETE FROM telegram_user_links WHERE id <> ? AND telegram_user_id = ?', [id, telegramUserId]);
      const [updateResult] = await conn.query(
        `UPDATE telegram_user_links
         SET subject_type = ?, subject_id = ?, telegram_user_id = ?, receive_notifications = ?, telegram_username = ?, telegram_first_name = ?, telegram_last_name = ?
         WHERE id = ?`,
        [
          subjectType,
          subjectId,
          telegramUserId,
          input?.receive_notifications ? 1 : 0,
          normalizeNullableString(input.telegram_username),
          normalizeNullableString(input.telegram_first_name),
          normalizeNullableString(input.telegram_last_name),
          id,
        ]
      );
      if (!updateResult.affectedRows) {
        throw new Error('Mapping Telegram non trovato');
      }
    } else {
    await conn.query(
      'DELETE FROM telegram_user_links WHERE telegram_user_id = ? AND NOT (subject_type = ? AND subject_id = ?)',
      [telegramUserId, subjectType, subjectId]
    );
    await conn.query(
      `INSERT INTO telegram_user_links
        (subject_type, subject_id, telegram_user_id, receive_notifications, telegram_username, telegram_first_name, telegram_last_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        telegram_user_id = VALUES(telegram_user_id),
        receive_notifications = VALUES(receive_notifications),
        telegram_username = VALUES(telegram_username),
        telegram_first_name = VALUES(telegram_first_name),
        telegram_last_name = VALUES(telegram_last_name)`,
      [
        subjectType,
        subjectId,
        telegramUserId,
        input?.receive_notifications ? 1 : 0,
        normalizeNullableString(input.telegram_username),
        normalizeNullableString(input.telegram_first_name),
        normalizeNullableString(input.telegram_last_name),
      ]
    );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  const [rows] = await pool.query(
    `SELECT id, subject_type, subject_id, telegram_user_id, receive_notifications, telegram_username, telegram_first_name, telegram_last_name, created_at, updated_at
     FROM telegram_user_links
     WHERE subject_type = ? AND subject_id = ?
     LIMIT 1`,
    [subjectType, subjectId]
  );
  return rows?.[0] || null;
}

async function deleteTelegramUserLink(id) {
  const [result] = await pool.query('DELETE FROM telegram_user_links WHERE id = ?', [id]);
  return { changes: result.affectedRows };
}

async function listTelegramGroupTargets() {
  const [rows] = await pool.query(`
    SELECT id, label, telegram_chat_id, is_enabled, created_at, updated_at
    FROM telegram_group_targets
    ORDER BY label ASC, id ASC
  `);
  return Array.isArray(rows) ? rows : [];
}

async function upsertTelegramGroupTarget(input = {}) {
  const label = normalizeNullableString(input.label);
  const telegramChatId = normalizeNullableString(input.telegram_chat_id);
  if (!label) throw new Error('label obbligatorio');
  if (!telegramChatId) throw new Error('telegram_chat_id obbligatorio');

  await pool.query(
    `INSERT INTO telegram_group_targets (id, label, telegram_chat_id, is_enabled)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      label = VALUES(label),
      telegram_chat_id = VALUES(telegram_chat_id),
      is_enabled = VALUES(is_enabled)`,
    [
      input?.id || null,
      label,
      telegramChatId,
      input?.is_enabled === false ? 0 : 1,
    ]
  );

  const [rows] = await pool.query(
    `SELECT id, label, telegram_chat_id, is_enabled, created_at, updated_at
     FROM telegram_group_targets
     WHERE telegram_chat_id = ?
     LIMIT 1`,
    [telegramChatId]
  );
  return rows?.[0] || null;
}

async function deleteTelegramGroupTarget(id) {
  const [result] = await pool.query('DELETE FROM telegram_group_targets WHERE id = ?', [id]);
  return { changes: result.affectedRows };
}

async function listEnabledTelegramNotificationTargets() {
  const [userRows] = await pool.query(`
    SELECT telegram_user_id AS telegram_chat_id, subject_id AS label, 'user' AS target_type
    FROM telegram_user_links
    WHERE receive_notifications = 1
  `);
  const [groupRows] = await pool.query(`
    SELECT telegram_chat_id, label, 'group' AS target_type
    FROM telegram_group_targets
    WHERE is_enabled = 1
  `);
  return [...(Array.isArray(userRows) ? userRows : []), ...(Array.isArray(groupRows) ? groupRows : [])];
}

async function getTelegramChatSession(telegramChatId) {
  const [rows] = await pool.query(
    `SELECT telegram_chat_id, telegram_user_id, subject_type, subject_id, active_agent_chat_id, active_agent_id, last_command, metadata_json, created_at, updated_at
     FROM telegram_chat_sessions
     WHERE telegram_chat_id = ?
     LIMIT 1`,
    [String(telegramChatId || '').trim()]
  );
  const row = rows?.[0] || null;
  if (!row) return null;
  return {
    ...row,
    metadata_json: parseJsonField(row.metadata_json, {}),
  };
}

async function upsertTelegramChatSession(input = {}) {
  const telegramChatId = normalizeNullableString(input.telegram_chat_id);
  const telegramUserId = normalizeNullableString(input.telegram_user_id);
  const subjectType = String(input.subject_type || 'user').trim().toLowerCase() === 'upn' ? 'upn' : 'user';
  const subjectId = normalizeNullableString(input.subject_id);
  if (!telegramChatId) throw new Error('telegram_chat_id obbligatorio');
  if (!telegramUserId) throw new Error('telegram_user_id obbligatorio');
  if (!subjectId) throw new Error('subject_id obbligatorio');

  await pool.query(
    `INSERT INTO telegram_chat_sessions
      (telegram_chat_id, telegram_user_id, subject_type, subject_id, active_agent_chat_id, active_agent_id, last_command, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      telegram_user_id = VALUES(telegram_user_id),
      subject_type = VALUES(subject_type),
      subject_id = VALUES(subject_id),
      active_agent_chat_id = VALUES(active_agent_chat_id),
      active_agent_id = VALUES(active_agent_id),
      last_command = VALUES(last_command),
      metadata_json = VALUES(metadata_json)`,
    [
      telegramChatId,
      telegramUserId,
      subjectType,
      subjectId,
      normalizeNullableString(input.active_agent_chat_id),
      input.active_agent_id ?? null,
      normalizeNullableString(input.last_command),
      JSON.stringify(input.metadata_json || {}),
    ]
  );

  return getTelegramChatSession(telegramChatId);
}

module.exports = {
  initTelegramTables,
  listTelegramUserLinks,
  getTelegramUserLinkByTelegramUserId,
  upsertTelegramUserLink,
  deleteTelegramUserLink,
  listTelegramGroupTargets,
  upsertTelegramGroupTarget,
  deleteTelegramGroupTarget,
  listEnabledTelegramNotificationTargets,
  getTelegramChatSession,
  upsertTelegramChatSession,
};
