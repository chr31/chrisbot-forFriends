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

async function initAgentChatsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_chats (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL UNIQUE,
      agent_id BIGINT UNSIGNED NOT NULL,
      owner_username VARCHAR(255) NULL,
      title VARCHAR(255) NULL,
      config_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_agent_chats_agent (agent_id),
      INDEX idx_agent_chats_owner (owner_username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  try {
    await pool.query(`
      ALTER TABLE agent_chats
      DROP INDEX idx_agent_chats_archived
    `);
  } catch (error) {
    if (error && error.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && error.code !== 'ER_NO_SUCH_TABLE' && error.code !== 'ER_DROP_INDEX_FK') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agent_chats
      DROP COLUMN is_archived
    `);
  } catch (error) {
    if (error && error.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && error.code !== 'ER_BAD_FIELD_ERROR' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agent_chats
      ADD COLUMN config_json JSON NULL AFTER title
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      agent_id BIGINT UNSIGNED NULL,
      role VARCHAR(32) NOT NULL,
      event_type VARCHAR(32) NOT NULL DEFAULT 'message',
      content LONGTEXT NOT NULL,
      metadata_json JSON NULL,
      reasoning LONGTEXT NULL,
      total_tokens INT NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_agent_messages_chat (chat_id, created_at, id),
      INDEX idx_agent_messages_agent (agent_id),
      INDEX idx_agent_messages_unread (chat_id, role, is_read)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function createAgentChat({ chat_id, agent_id, owner_username, title, config_json }) {
  const [result] = await pool.query(
    'INSERT INTO agent_chats (chat_id, agent_id, owner_username, title, config_json) VALUES (?, ?, ?, ?, ?)',
    [chat_id, agent_id, owner_username || null, title || null, config_json ? JSON.stringify(config_json) : null]
  );
  return { id: result.insertId };
}

async function touchAgentChat(chatId, title) {
  if (title !== undefined) {
    await pool.query(
      'UPDATE agent_chats SET title = COALESCE(?, title), updated_at = CURRENT_TIMESTAMP(3) WHERE chat_id = ?',
      [title || null, chatId]
    );
    return;
  }
  await pool.query('UPDATE agent_chats SET updated_at = CURRENT_TIMESTAMP(3) WHERE chat_id = ?', [chatId]);
}

async function updateAgentChatConfig(chatId, configJson) {
  const [result] = await pool.query(
    'UPDATE agent_chats SET config_json = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE chat_id = ?',
    [configJson ? JSON.stringify(configJson) : null, chatId]
  );
  return { changes: result.affectedRows };
}

async function getAgentChatByChatId(chatId) {
  const [rows] = await pool.query(
    `SELECT c.*, a.name AS agent_name, a.slug AS agent_slug, a.kind AS agent_kind
     FROM agent_chats c
     JOIN agents a ON a.id = c.agent_id
     WHERE c.chat_id = ?
     LIMIT 1`,
    [chatId]
  );
  const row = rows?.[0] || null;
  if (!row) return null;
  return {
    ...row,
    config_json: parseJsonField(row.config_json, null),
  };
}

async function getMessagesByAgentChatId(chatId) {
  const [rows] = await pool.query(
    `SELECT
      m.role,
      m.content,
      m.reasoning,
      m.total_tokens,
      m.event_type,
      m.metadata_json,
      m.created_at,
      m.agent_id,
      a.name AS agent_name,
      a.kind AS agent_kind
     FROM agent_messages m
     LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.chat_id = ?
     ORDER BY m.created_at ASC, m.id ASC`,
    [chatId]
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        metadata_json: parseJsonField(row.metadata_json, null),
      }))
    : [];
}

async function insertAgentMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return { inserted: 0 };
  const values = messages.map((msg) => [
    msg.chat_id,
    msg.agent_id || null,
    msg.role,
    msg.event_type || 'message',
    String(msg.content ?? ''),
    msg.metadata_json ? JSON.stringify(msg.metadata_json) : null,
    msg.reasoning || null,
    Number.isFinite(msg.total_tokens) ? Math.trunc(msg.total_tokens) : null,
    msg.role === 'assistant' ? 0 : 1,
    msg.created_at ? new Date(msg.created_at) : new Date(),
  ]);
  await pool.query(
    `INSERT INTO agent_messages
      (chat_id, agent_id, role, event_type, content, metadata_json, reasoning, total_tokens, is_read, created_at)
     VALUES ?`,
    [values]
  );
  if (messages[0]?.chat_id) {
    await touchAgentChat(messages[0].chat_id);
  }
  return { inserted: values.length };
}

async function markAgentChatAsRead(chatId) {
  const [result] = await pool.query(
    'UPDATE agent_messages SET is_read = 1 WHERE chat_id = ? AND role = ?',
    [chatId, 'assistant']
  );
  return { updated: result.affectedRows };
}

async function getAgentChatSummaries(ownerUsername) {
  const params = [];
  const whereParts = [];
  if (ownerUsername) {
    const owners = Array.isArray(ownerUsername)
      ? ownerUsername.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [String(ownerUsername || '').trim()].filter(Boolean);
    if (owners.length > 1) {
      whereParts.push(`c.owner_username IN (${owners.map(() => '?').join(', ')})`);
      params.push(...owners);
    } else if (owners.length === 1) {
      whereParts.push('c.owner_username = ?');
      params.push(owners[0]);
    }
  }
  const ownerWhere = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';

  const [rows] = await pool.query(
    `
    WITH UnreadCounts AS (
      SELECT chat_id, COUNT(*) AS unreadCount
      FROM agent_messages
      WHERE is_read = 0 AND role = 'assistant'
      GROUP BY chat_id
    ),
    LastDates AS (
      SELECT chat_id, MAX(created_at) AS last_date
      FROM agent_messages
      GROUP BY chat_id
    )
    SELECT
      c.chat_id AS id,
      c.title,
      c.agent_id,
      a.name AS agent_name,
      a.slug AS agent_slug,
      a.kind AS agent_kind,
      COALESCE(u.unreadCount, 0) AS unreadCount,
      ld.last_date
    FROM agent_chats c
    JOIN agents a ON a.id = c.agent_id
    LEFT JOIN UnreadCounts u ON u.chat_id = c.chat_id
    LEFT JOIN LastDates ld ON ld.chat_id = c.chat_id
    ${ownerWhere}
    ORDER BY COALESCE(ld.last_date, c.updated_at) DESC, c.id DESC
    `,
    params
  );
  return Array.isArray(rows) ? rows : [];
}

async function deleteAgentChat(chatId, ownerUsername) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const owners = Array.isArray(ownerUsername)
      ? ownerUsername.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [String(ownerUsername || '').trim()].filter(Boolean);
    await conn.query('DELETE FROM agent_messages WHERE chat_id = ?', [chatId]);
    await conn.query('DELETE FROM agent_runs WHERE chat_id = ?', [chatId]);
    const [result] = await conn.query(
      `DELETE FROM agent_chats WHERE chat_id = ? AND owner_username IN (${owners.map(() => '?').join(', ')})`,
      [chatId, ...owners]
    );
    await conn.commit();
    return { changes: result.affectedRows };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function deleteAllAgentChats(ownerUsername) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const owners = Array.isArray(ownerUsername)
      ? ownerUsername.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [String(ownerUsername || '').trim()].filter(Boolean);
    if (owners.length === 0) {
      await conn.rollback();
      return { changes: 0 };
    }

    const ownerPlaceholders = owners.map(() => '?').join(', ');
    const whereClause = `owner_username IN (${ownerPlaceholders})`;

    const [rows] = await conn.query(
      `SELECT chat_id FROM agent_chats WHERE ${whereClause}`,
      owners
    );
    const chatIds = Array.isArray(rows)
      ? rows.map((row) => String(row.chat_id || '').trim()).filter(Boolean)
      : [];

    if (chatIds.length === 0) {
      await conn.commit();
      return { changes: 0 };
    }

    const chatPlaceholders = chatIds.map(() => '?').join(', ');
    await conn.query(`DELETE FROM agent_messages WHERE chat_id IN (${chatPlaceholders})`, chatIds);
    await conn.query(`DELETE FROM agent_runs WHERE chat_id IN (${chatPlaceholders})`, chatIds);
    const [result] = await conn.query(
      `DELETE FROM agent_chats WHERE chat_id IN (${chatPlaceholders})`,
      chatIds
    );
    await conn.commit();
    return { changes: result.affectedRows };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  initAgentChatsTables,
  createAgentChat,
  touchAgentChat,
  updateAgentChatConfig,
  getAgentChatByChatId,
  getMessagesByAgentChatId,
  insertAgentMessages,
  markAgentChatAsRead,
  getAgentChatSummaries,
  deleteAgentChat,
  deleteAllAgentChats,
};
