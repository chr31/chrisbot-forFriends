const pool = require('./mysql');
const { enqueueWebPushNotification } = require('./db_web_push');
const { broadcastTelegramNotification } = require('../services/telegramNotifications');

const VALID_ITEM_STATUSES = new Set(['open', 'pending_user', 'pending_agent', 'resolved', 'dismissed']);
const VALID_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_MESSAGE_ROLES = new Set(['user', 'agent', 'system']);
const VALID_MESSAGE_TYPES = new Set(['message', 'status_update', 'decision']);

function normalizeItemStatus(value, fallback = 'open') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_ITEM_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizePriority(value, fallback = 'normal') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_PRIORITIES.has(normalized) ? normalized : fallback;
}

function normalizeMessageRole(value, fallback = 'system') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_MESSAGE_ROLES.has(normalized) ? normalized : fallback;
}

function normalizeMessageType(value, fallback = 'message') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_MESSAGE_TYPES.has(normalized) ? normalized : fallback;
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

function normalizeCategory(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function toNullableString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function toNullableUnsignedInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeBooleanFlag(value, defaultValue = 0) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'si', 'sì', 'yes', 'y', 'on'].includes(lowered)) return 1;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return 0;
  }
  return defaultValue;
}

function toJsonString(value, fallback = {}) {
  return JSON.stringify(parseJsonField(value, fallback));
}

function hydrateInboxItem(row) {
  if (!row) return null;
  return {
    ...row,
    task_title: toNullableString(row.task_title),
    status: normalizeItemStatus(row.status, 'open'),
    priority: normalizePriority(row.priority, 'normal'),
    category: normalizeCategory(row.category),
    is_read: Number(row.is_read) === 1,
    metadata_json: parseJsonField(row.metadata_json, {}),
  };
}

function hydrateInboxMessage(row) {
  if (!row) return null;
  return {
    ...row,
    role: normalizeMessageRole(row.role, 'system'),
    message_type: normalizeMessageType(row.message_type, 'message'),
    metadata_json: parseJsonField(row.metadata_json, {}),
  };
}

async function initInboxTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      owner_username VARCHAR(255) NOT NULL,
      status ENUM('open', 'pending_user', 'pending_agent', 'resolved', 'dismissed') NOT NULL DEFAULT 'open',
      priority ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
      title VARCHAR(255) NOT NULL,
      description LONGTEXT NULL,
      category VARCHAR(255) NULL,
      agent_id BIGINT UNSIGNED NULL,
      chat_id VARCHAR(255) NULL,
      agent_run_id BIGINT UNSIGNED NULL,
      task_id BIGINT UNSIGNED NULL,
      task_run_id BIGINT UNSIGNED NULL,
      requires_reply TINYINT(1) NOT NULL DEFAULT 0,
      item_key VARCHAR(255) NULL,
      metadata_json JSON NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      last_message_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      UNIQUE KEY uniq_inbox_item_key (item_key),
      INDEX idx_inbox_items_owner (owner_username, status, last_message_at),
      INDEX idx_inbox_items_task (task_id),
      INDEX idx_inbox_items_chat (chat_id),
      INDEX idx_inbox_items_agent (agent_id),
      INDEX idx_inbox_items_category (category),
      INDEX idx_inbox_items_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    ALTER TABLE inbox_items
    ADD COLUMN category VARCHAR(255) NULL AFTER description
  `).catch((error) => {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') throw error;
  });

  await cleanupInboxConfirmationLegacyColumns();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      inbox_item_id BIGINT UNSIGNED NOT NULL,
      role ENUM('user', 'agent', 'system') NOT NULL DEFAULT 'system',
      message_type ENUM('message', 'status_update', 'decision') NOT NULL DEFAULT 'message',
      agent_id BIGINT UNSIGNED NULL,
      username VARCHAR(255) NULL,
      content LONGTEXT NOT NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_inbox_messages_item (inbox_item_id, created_at, id),
      INDEX idx_inbox_messages_agent (agent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function getInboxItemColumn(columnName) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'inbox_items'
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [columnName]
  );
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function cleanupInboxConfirmationLegacyColumns() {
  const confirmationStateColumn = await getInboxItemColumn('confirmation_state');
  if (confirmationStateColumn) {
    await pool.query('ALTER TABLE inbox_items DROP COLUMN confirmation_state');
  }

  const requiresConfirmationColumn = await getInboxItemColumn('requires_confirmation');
  if (requiresConfirmationColumn) {
    await pool.query('ALTER TABLE inbox_items DROP COLUMN requires_confirmation');
  }
}

async function insertInboxItem(input, options = {}) {
  const db = options.db || pool;
  const title = String(input?.title || '').trim();
  const ownerUsername = String(input?.owner_username || '').trim();
  const notificationBody = toNullableString(input?.notification_body)
    || toNullableString(input?.message)
    || toNullableString(input?.description)
    || title;
  if (!title) throw new Error('title is required');
  if (!ownerUsername) throw new Error('owner_username is required');

  const [result] = await db.query(
    `INSERT INTO inbox_items
      (owner_username, status, priority, title, description, category, agent_id, chat_id, agent_run_id, task_id, task_run_id, requires_reply, item_key, metadata_json, is_read, last_message_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ownerUsername,
      normalizeItemStatus(input?.status, 'open'),
      normalizePriority(input?.priority, 'normal'),
      title,
      toNullableString(input?.description),
      normalizeCategory(input?.category),
      toNullableUnsignedInt(input?.agent_id),
      toNullableString(input?.chat_id),
      toNullableUnsignedInt(input?.agent_run_id),
      toNullableUnsignedInt(input?.task_id),
      toNullableUnsignedInt(input?.task_run_id),
      normalizeBooleanFlag(input?.requires_reply, 0),
      toNullableString(input?.item_key),
      input?.metadata_json === undefined ? null : toJsonString(input.metadata_json, {}),
      normalizeBooleanFlag(input?.is_read, 0),
      input?.last_message_at || new Date(),
    ]
  );
  const createdId = result.insertId;
  if (!options.skipWebPush) {
    await enqueueWebPushNotification({
      owner_username: ownerUsername,
      title: `Inbox: ${title}`,
      body: notificationBody,
      url: '/notifications',
      tag: `inbox-item-${createdId}`,
      payload_json: {
        inbox_item_id: createdId,
        category: normalizeCategory(input?.category),
      },
    }).catch((error) => {
      console.error('Errore enqueue Web Push inbox item:', error);
    });
  }
  if (!options.skipTelegram) {
    await broadcastTelegramNotification({
      title: `Inbox: ${title}`,
      body: notificationBody,
      category: normalizeCategory(input?.category),
      priority: normalizePriority(input?.priority, 'normal'),
      owner_username: ownerUsername,
    }).catch((error) => {
      console.error('Errore broadcast Telegram inbox item:', error);
    });
  }
  return { id: createdId };
}

async function updateInboxItem(id, updates) {
  const entries = [];
  const values = [];

  if (updates.status !== undefined) {
    entries.push('status = ?');
    values.push(normalizeItemStatus(updates.status, 'open'));
  }
  if (updates.priority !== undefined) {
    entries.push('priority = ?');
    values.push(normalizePriority(updates.priority, 'normal'));
  }
  if (updates.title !== undefined) {
    entries.push('title = ?');
    values.push(String(updates.title || '').trim());
  }
  if (updates.description !== undefined) {
    entries.push('description = ?');
    values.push(toNullableString(updates.description));
  }
  if (updates.category !== undefined) {
    entries.push('category = ?');
    values.push(normalizeCategory(updates.category));
  }
  if (updates.agent_id !== undefined) {
    entries.push('agent_id = ?');
    values.push(toNullableUnsignedInt(updates.agent_id));
  }
  if (updates.chat_id !== undefined) {
    entries.push('chat_id = ?');
    values.push(toNullableString(updates.chat_id));
  }
  if (updates.agent_run_id !== undefined) {
    entries.push('agent_run_id = ?');
    values.push(toNullableUnsignedInt(updates.agent_run_id));
  }
  if (updates.task_id !== undefined) {
    entries.push('task_id = ?');
    values.push(toNullableUnsignedInt(updates.task_id));
  }
  if (updates.task_run_id !== undefined) {
    entries.push('task_run_id = ?');
    values.push(toNullableUnsignedInt(updates.task_run_id));
  }
  if (updates.requires_reply !== undefined) {
    entries.push('requires_reply = ?');
    values.push(normalizeBooleanFlag(updates.requires_reply, 0));
  }
  if (updates.metadata_json !== undefined) {
    entries.push('metadata_json = ?');
    values.push(updates.metadata_json === null ? null : toJsonString(updates.metadata_json, {}));
  }
  if (updates.is_read !== undefined) {
    entries.push('is_read = ?');
    values.push(normalizeBooleanFlag(updates.is_read, 0));
  }
  if (updates.last_message_at !== undefined) {
    entries.push('last_message_at = ?');
    values.push(updates.last_message_at || new Date());
  }
  if (updates.item_key !== undefined) {
    entries.push('item_key = ?');
    values.push(toNullableString(updates.item_key));
  }

  if (entries.length === 0) return { changes: 0 };
  values.push(id);
  const [result] = await pool.query(`UPDATE inbox_items SET ${entries.join(', ')} WHERE id = ?`, values);
  return { changes: result.affectedRows };
}

async function getInboxItemById(id) {
  const [rows] = await pool.query(
    `SELECT
      i.*,
      t.title AS task_title,
      COALESCE(NULLIF(i.category, ''), NULLIF(t.notification_type, '')) AS category,
      a.name AS agent_name,
      a.slug AS agent_slug,
      a.kind AS agent_kind
     FROM inbox_items i
     LEFT JOIN agents a ON a.id = i.agent_id
     LEFT JOIN tasks t ON t.id = i.task_id
     WHERE i.id = ?
     LIMIT 1`,
    [id]
  );
  return rows?.[0] ? hydrateInboxItem(rows[0]) : null;
}

async function getInboxItemByKey(itemKey) {
  const normalized = toNullableString(itemKey);
  if (!normalized) return null;
  const [rows] = await pool.query(
    `SELECT
      i.*,
      t.title AS task_title,
      COALESCE(NULLIF(i.category, ''), NULLIF(t.notification_type, '')) AS category,
      a.name AS agent_name,
      a.slug AS agent_slug,
      a.kind AS agent_kind
     FROM inbox_items i
     LEFT JOIN agents a ON a.id = i.agent_id
     LEFT JOIN tasks t ON t.id = i.task_id
     WHERE i.item_key = ?
     LIMIT 1`,
    [normalized]
  );
  return rows?.[0] ? hydrateInboxItem(rows[0]) : null;
}

async function getInboxItemsForUser(ownerUsername, options = {}) {
  const owners = Array.isArray(ownerUsername)
    ? ownerUsername.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [String(ownerUsername || '').trim()].filter(Boolean);
  const where = owners.length > 1
    ? [`i.owner_username IN (${owners.map(() => '?').join(', ')})`]
    : ['i.owner_username = ?'];
  const params = owners;

  if (!options.includeDismissed) {
    where.push(`i.status <> 'dismissed'`);
  }
  if (!options.includeResolved) {
    where.push(`i.status <> 'resolved'`);
  }
  if (options.status) {
    where.push('i.status = ?');
    params.push(normalizeItemStatus(options.status, 'open'));
  }
  if (options.category) {
    if (String(options.category).trim().toLowerCase() === '__uncategorized__') {
      where.push('(COALESCE(NULLIF(i.category, \'\'), NULLIF(t.notification_type, \'\')) IS NULL)');
    } else {
      where.push('COALESCE(NULLIF(i.category, \'\'), NULLIF(t.notification_type, \'\')) = ?');
      params.push(normalizeCategory(options.category));
    }
  }
  if (options.task_id) {
    where.push('i.task_id = ?');
    params.push(toNullableUnsignedInt(options.task_id));
  }

  const [rows] = await pool.query(
    `SELECT
      i.*,
      t.title AS task_title,
      COALESCE(NULLIF(i.category, ''), NULLIF(t.notification_type, '')) AS category,
      a.name AS agent_name,
      a.slug AS agent_slug,
      a.kind AS agent_kind,
      (SELECT COUNT(*) FROM inbox_messages m WHERE m.inbox_item_id = i.id) AS message_count
     FROM inbox_items i
     LEFT JOIN agents a ON a.id = i.agent_id
     LEFT JOIN tasks t ON t.id = i.task_id
     WHERE ${where.join(' AND ')}
     ORDER BY i.last_message_at DESC, i.id DESC`,
    params
  );
  return Array.isArray(rows) ? rows.map(hydrateInboxItem) : [];
}

async function insertInboxMessage(input) {
  const db = input?.db || pool;
  const inboxItemId = toNullableUnsignedInt(input?.inbox_item_id);
  const content = String(input?.content || '').trim();
  const normalizedRole = normalizeMessageRole(input?.role, 'system');
  const normalizedMessageType = normalizeMessageType(input?.message_type, 'message');
  if (!inboxItemId) throw new Error('inbox_item_id is required');
  if (!content) throw new Error('content is required');

  const [result] = await db.query(
    `INSERT INTO inbox_messages
      (inbox_item_id, role, message_type, agent_id, username, content, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      inboxItemId,
      normalizedRole,
      normalizedMessageType,
      toNullableUnsignedInt(input?.agent_id),
      toNullableString(input?.username),
      content,
      input?.metadata_json === undefined ? null : toJsonString(input.metadata_json, {}),
      input?.created_at || new Date(),
    ]
  );

  await db.query(
    'UPDATE inbox_items SET last_message_at = ?, is_read = 0, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
    [input?.created_at || new Date(), inboxItemId]
  );
  if (normalizedRole === 'agent') {
    const item = await getInboxItemById(inboxItemId).catch(() => null);
    if (item?.owner_username) {
      await enqueueWebPushNotification({
        owner_username: item.owner_username,
        title: `Inbox: ${item.title || 'Aggiornamento'}`,
        body: content,
        url: '/notifications',
        tag: `inbox-item-${inboxItemId}`,
        payload_json: {
          inbox_item_id: inboxItemId,
          message_type: normalizedMessageType,
        },
      }).catch((error) => {
        console.error('Errore enqueue Web Push inbox message:', error);
      });
    }
  }
  return { id: result.insertId };
}

async function getInboxMessages(inboxItemId) {
  const [rows] = await pool.query(
    `SELECT
      m.*,
      a.name AS agent_name,
      a.slug AS agent_slug
     FROM inbox_messages m
     LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.inbox_item_id = ?
     ORDER BY m.created_at ASC, m.id ASC`,
    [inboxItemId]
  );
  return Array.isArray(rows) ? rows.map(hydrateInboxMessage) : [];
}

async function markInboxItemAsRead(id) {
  const [result] = await pool.query('UPDATE inbox_items SET is_read = 1 WHERE id = ?', [id]);
  return { changes: result.affectedRows };
}

async function deleteInboxItem(id) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM inbox_messages WHERE inbox_item_id = ?', [id]);
    const [result] = await conn.query('DELETE FROM inbox_items WHERE id = ?', [id]);
    await conn.commit();
    return { changes: result.affectedRows };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function deleteInboxItemsForUser(ownerUsername, options = {}) {
  const owners = Array.isArray(ownerUsername)
    ? ownerUsername.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [String(ownerUsername || '').trim()].filter(Boolean);
  if (owners.length === 0) return { changes: 0 };

  const where = owners.length > 1
    ? [`i.owner_username IN (${owners.map(() => '?').join(', ')})`]
    : ['i.owner_username = ?'];
  const params = [...owners];

  if (options.category) {
    if (String(options.category).trim().toLowerCase() === '__uncategorized__') {
      where.push('(COALESCE(NULLIF(i.category, \'\'), NULLIF(t.notification_type, \'\')) IS NULL)');
    } else {
      where.push('COALESCE(NULLIF(i.category, \'\'), NULLIF(t.notification_type, \'\')) = ?');
      params.push(normalizeCategory(options.category));
    }
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT i.id
         FROM inbox_items i
         LEFT JOIN tasks t ON t.id = i.task_id
        WHERE ${where.join(' AND ')}`,
      params
    );
    const ids = Array.isArray(rows) ? rows.map((row) => row.id).filter(Boolean) : [];
    if (ids.length === 0) {
      await conn.commit();
      return { changes: 0 };
    }
    await conn.query(`DELETE FROM inbox_messages WHERE inbox_item_id IN (${ids.map(() => '?').join(', ')})`, ids);
    const [result] = await conn.query(`DELETE FROM inbox_items WHERE id IN (${ids.map(() => '?').join(', ')})`, ids);
    await conn.commit();
    return { changes: result.affectedRows };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function getInboxCategoriesForUser(ownerUsername, options = {}) {
  const owners = Array.isArray(ownerUsername)
    ? ownerUsername.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [String(ownerUsername || '').trim()].filter(Boolean);
  if (owners.length === 0) return [];

  const where = owners.length > 1
    ? [`i.owner_username IN (${owners.map(() => '?').join(', ')})`]
    : ['i.owner_username = ?'];
  const params = [...owners];

  if (!options.includeDismissed) {
    where.push(`i.status <> 'dismissed'`);
  }
  if (!options.includeResolved) {
    where.push(`i.status <> 'resolved'`);
  }

  const [rows] = await pool.query(
    `SELECT DISTINCT COALESCE(NULLIF(i.category, ''), NULLIF(t.notification_type, '')) AS category
       FROM inbox_items i
       LEFT JOIN tasks t ON t.id = i.task_id
      WHERE ${where.join(' AND ')}
      ORDER BY category ASC`,
    params
  );
  return Array.isArray(rows)
    ? rows.map((row) => normalizeCategory(row.category)).filter((value) => value !== null)
    : [];
}

module.exports = {
  initInboxTables,
  insertInboxItem,
  updateInboxItem,
  getInboxItemById,
  getInboxItemByKey,
  getInboxItemsForUser,
  insertInboxMessage,
  getInboxMessages,
  markInboxItemAsRead,
  deleteInboxItem,
  deleteInboxItemsForUser,
  getInboxCategoriesForUser,
  normalizeItemStatus,
  normalizePriority,
};
