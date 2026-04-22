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

function createAliveChatId(agentId) {
  return `alive-agent-${Number(agentId)}`;
}

async function initAliveAgentChatsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alive_agent_chats (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL UNIQUE,
      agent_id BIGINT UNSIGNED NOT NULL UNIQUE,
      config_json JSON NULL,
      loop_status ENUM('play', 'pause') NOT NULL DEFAULT 'pause',
      is_processing TINYINT(1) NOT NULL DEFAULT 0,
      next_loop_at DATETIME(3) NULL,
      last_error TEXT NULL,
      last_started_at DATETIME(3) NULL,
      last_finished_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_alive_agent_chats_loop (loop_status, next_loop_at),
      INDEX idx_alive_agent_chats_processing (is_processing)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS alive_agent_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      agent_id BIGINT UNSIGNED NULL,
      role VARCHAR(32) NOT NULL,
      event_type VARCHAR(32) NOT NULL DEFAULT 'message',
      content LONGTEXT NOT NULL,
      metadata_json JSON NULL,
      reasoning LONGTEXT NULL,
      total_tokens INT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_alive_agent_messages_chat (chat_id, created_at, id),
      INDEX idx_alive_agent_messages_agent (agent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function ensureAliveAgentChat(agentId, configJson = null) {
  const chatId = createAliveChatId(agentId);
  await pool.query(
    `INSERT INTO alive_agent_chats (chat_id, agent_id, config_json)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       config_json = COALESCE(config_json, VALUES(config_json))`,
    [chatId, Number(agentId), configJson ? JSON.stringify(configJson) : null]
  );
  return getAliveAgentChatByAgentId(agentId);
}

function hydrateAliveChat(row) {
  if (!row) return null;
  return {
    ...row,
    config_json: parseJsonField(row.config_json, null),
    is_processing: Number(row.is_processing) === 1,
  };
}

async function getAliveAgentChatByAgentId(agentId) {
  const [rows] = await pool.query(
    `SELECT c.*, a.name AS agent_name, a.slug AS agent_slug, a.kind AS agent_kind
     FROM alive_agent_chats c
     JOIN agents a ON a.id = c.agent_id
     WHERE c.agent_id = ?
     LIMIT 1`,
    [Number(agentId)]
  );
  return hydrateAliveChat(rows?.[0] || null);
}

async function getAliveAgentChatByChatId(chatId) {
  const [rows] = await pool.query(
    `SELECT c.*, a.name AS agent_name, a.slug AS agent_slug, a.kind AS agent_kind
     FROM alive_agent_chats c
     JOIN agents a ON a.id = c.agent_id
     WHERE c.chat_id = ?
     LIMIT 1`,
    [String(chatId || '').trim()]
  );
  return hydrateAliveChat(rows?.[0] || null);
}

async function updateAliveAgentChatConfig(agentId, configJson) {
  const [result] = await pool.query(
    'UPDATE alive_agent_chats SET config_json = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE agent_id = ?',
    [configJson ? JSON.stringify(configJson) : null, Number(agentId)]
  );
  return { changes: result.affectedRows };
}

async function updateAliveAgentLoopState(agentId, updates = {}) {
  const entries = [];
  const values = [];
  if (updates.loop_status !== undefined) {
    entries.push('loop_status = ?');
    values.push(String(updates.loop_status) === 'play' ? 'play' : 'pause');
  }
  if (updates.is_processing !== undefined) {
    entries.push('is_processing = ?');
    values.push(updates.is_processing ? 1 : 0);
  }
  if (updates.next_loop_at !== undefined) {
    entries.push('next_loop_at = ?');
    values.push(updates.next_loop_at ? new Date(updates.next_loop_at) : null);
  }
  if (updates.last_error !== undefined) {
    entries.push('last_error = ?');
    values.push(updates.last_error ? String(updates.last_error) : null);
  }
  if (updates.last_started_at !== undefined) {
    entries.push('last_started_at = ?');
    values.push(updates.last_started_at ? new Date(updates.last_started_at) : null);
  }
  if (updates.last_finished_at !== undefined) {
    entries.push('last_finished_at = ?');
    values.push(updates.last_finished_at ? new Date(updates.last_finished_at) : null);
  }
  if (entries.length === 0) return { changes: 0 };
  values.push(Number(agentId));
  const [result] = await pool.query(
    `UPDATE alive_agent_chats SET ${entries.join(', ')}, updated_at = CURRENT_TIMESTAMP(3) WHERE agent_id = ?`,
    values
  );
  return { changes: result.affectedRows };
}

async function claimAliveAgentChatForProcessing(agentId) {
  const [result] = await pool.query(
    `UPDATE alive_agent_chats
        SET is_processing = 1,
            last_started_at = CURRENT_TIMESTAMP(3),
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP(3)
      WHERE agent_id = ?
        AND loop_status = 'play'
        AND is_processing = 0
        AND (next_loop_at IS NULL OR next_loop_at <= CURRENT_TIMESTAMP(3))`,
    [Number(agentId)]
  );
  return result.affectedRows > 0;
}

async function releaseAliveAgentChatProcessing(agentId, updates = {}) {
  const entries = ['is_processing = 0', 'updated_at = CURRENT_TIMESTAMP(3)'];
  const values = [];
  if (updates.loop_status !== undefined) {
    entries.push('loop_status = ?');
    values.push(String(updates.loop_status) === 'play' ? 'play' : 'pause');
  }
  if (updates.next_loop_at !== undefined) {
    entries.push('next_loop_at = ?');
    values.push(updates.next_loop_at ? new Date(updates.next_loop_at) : null);
  }
  if (updates.last_error !== undefined) {
    entries.push('last_error = ?');
    values.push(updates.last_error ? String(updates.last_error) : null);
  }
  if (updates.last_finished_at !== undefined) {
    entries.push('last_finished_at = ?');
    values.push(updates.last_finished_at ? new Date(updates.last_finished_at) : new Date());
  } else {
    entries.push('last_finished_at = CURRENT_TIMESTAMP(3)');
  }
  values.push(Number(agentId));
  const [result] = await pool.query(
    `UPDATE alive_agent_chats SET ${entries.join(', ')} WHERE agent_id = ?`,
    values
  );
  return { changes: result.affectedRows };
}

async function listDueAliveAgentChats(limit = 20) {
  const [rows] = await pool.query(
    `SELECT c.*, a.name AS agent_name, a.slug AS agent_slug, a.kind AS agent_kind
     FROM alive_agent_chats c
     JOIN agents a ON a.id = c.agent_id
     WHERE c.loop_status = 'play'
       AND c.is_processing = 0
       AND (c.next_loop_at IS NULL OR c.next_loop_at <= CURRENT_TIMESTAMP(3))
     ORDER BY COALESCE(c.next_loop_at, c.updated_at) ASC, c.id ASC
     LIMIT ?`,
    [Math.max(1, Math.trunc(limit))]
  );
  return Array.isArray(rows) ? rows.map(hydrateAliveChat) : [];
}

async function getAliveAgentMessages(chatId) {
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
     FROM alive_agent_messages m
     LEFT JOIN agents a ON a.id = m.agent_id
     WHERE m.chat_id = ?
     ORDER BY m.created_at ASC, m.id ASC`,
    [String(chatId || '').trim()]
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        metadata_json: parseJsonField(row.metadata_json, null),
      }))
    : [];
}

async function insertAliveAgentMessages(messages = []) {
  if (!Array.isArray(messages) || messages.length === 0) return { inserted: 0 };
  const values = messages.map((msg) => [
    String(msg.chat_id || '').trim(),
    msg.agent_id || null,
    String(msg.role || 'assistant'),
    String(msg.event_type || 'message'),
    String(msg.content ?? ''),
    msg.metadata_json ? JSON.stringify(msg.metadata_json) : null,
    msg.reasoning || null,
    Number.isFinite(msg.total_tokens) ? Math.trunc(msg.total_tokens) : null,
    msg.created_at ? new Date(msg.created_at) : new Date(),
  ]);
  await pool.query(
    `INSERT INTO alive_agent_messages
      (chat_id, agent_id, role, event_type, content, metadata_json, reasoning, total_tokens, created_at)
     VALUES ?`,
    [values]
  );
  return { inserted: values.length };
}

async function deleteAliveAgentChatHistory(agentId) {
  const chat = await getAliveAgentChatByAgentId(agentId);
  if (!chat) return { changes: 0 };
  await pool.query('DELETE FROM alive_agent_messages WHERE chat_id = ?', [chat.chat_id]);
  await pool.query('DELETE FROM agent_runs WHERE chat_id = ?', [chat.chat_id]);
  await pool.query(
    `UPDATE alive_agent_chats
        SET loop_status = 'pause',
            is_processing = 0,
            next_loop_at = NULL,
            last_error = NULL,
            last_finished_at = CURRENT_TIMESTAMP(3),
            updated_at = CURRENT_TIMESTAMP(3)
      WHERE agent_id = ?`,
    [Number(agentId)]
  );
  return { changes: 1 };
}

module.exports = {
  createAliveChatId,
  initAliveAgentChatsTables,
  ensureAliveAgentChat,
  getAliveAgentChatByAgentId,
  getAliveAgentChatByChatId,
  updateAliveAgentChatConfig,
  updateAliveAgentLoopState,
  claimAliveAgentChatForProcessing,
  releaseAliveAgentChatProcessing,
  listDueAliveAgentChats,
  getAliveAgentMessages,
  insertAliveAgentMessages,
  deleteAliveAgentChatHistory,
};
