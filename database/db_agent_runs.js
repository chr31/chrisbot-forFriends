const pool = require('./mysql');

function normalizeStatus(value, defaultValue = 'running') {
  const normalized = String(value || defaultValue).trim().toLowerCase();
  return ['running', 'completed', 'failed', 'cancelled'].includes(normalized) ? normalized : defaultValue;
}

async function initAgentRunsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      chat_id VARCHAR(255) NOT NULL,
      agent_id BIGINT UNSIGNED NOT NULL,
      parent_run_id BIGINT UNSIGNED NULL,
      status ENUM('running', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'running',
      model_name VARCHAR(128) NOT NULL DEFAULT 'qwen3.5',
      model_provider VARCHAR(32) NOT NULL DEFAULT 'ollama',
      depth INT NOT NULL DEFAULT 0,
      started_at DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      last_error TEXT NULL,
      guardrail_result_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_agent_runs_chat (chat_id),
      INDEX idx_agent_runs_agent (agent_id),
      INDEX idx_agent_runs_status (status),
      INDEX idx_agent_runs_parent (parent_run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  try {
    await pool.query(`
      ALTER TABLE agent_runs
      ADD COLUMN model_name VARCHAR(128) NOT NULL DEFAULT 'qwen3.5' AFTER status
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  await pool.query(`
    UPDATE agent_runs
       SET model_name = COALESCE(NULLIF(model_name, ''), model)
     WHERE model IS NOT NULL
  `).catch((error) => {
    if (error && error.code !== 'ER_BAD_FIELD_ERROR' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  });

  try {
    await pool.query(`
      ALTER TABLE agent_runs
      DROP COLUMN model
    `);
  } catch (error) {
    if (error && error.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && error.code !== 'ER_BAD_FIELD_ERROR' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agent_runs
      ADD COLUMN model_provider VARCHAR(32) NOT NULL DEFAULT 'ollama' AFTER model_name
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }
}

async function insertAgentRun({ chat_id, agent_id, parent_run_id, status, model_name, model_provider, depth, started_at, guardrail_result_json }) {
  const [result] = await pool.query(
    `INSERT INTO agent_runs
      (chat_id, agent_id, parent_run_id, status, model_name, model_provider, depth, started_at, guardrail_result_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(chat_id),
      agent_id,
      parent_run_id || null,
      normalizeStatus(status),
      String(model_name || 'qwen3.5'),
      String(model_provider || 'ollama'),
      Number.isFinite(depth) ? Math.trunc(depth) : 0,
      started_at || new Date(),
      guardrail_result_json ? JSON.stringify(guardrail_result_json) : null,
    ]
  );
  return { id: result.insertId };
}

async function updateAgentRunIfStatus(id, updates, expectedStatus) {
  const entries = [];
  const values = [];
  if (updates.status !== undefined) {
    entries.push('status = ?');
    values.push(normalizeStatus(updates.status));
  }
  if (updates.finished_at !== undefined) {
    entries.push('finished_at = ?');
    values.push(updates.finished_at);
  }
  if (updates.last_error !== undefined) {
    entries.push('last_error = ?');
    values.push(String(updates.last_error || ''));
  }
  if (updates.guardrail_result_json !== undefined) {
    entries.push('guardrail_result_json = ?');
    values.push(JSON.stringify(updates.guardrail_result_json || {}));
  }
  if (entries.length === 0) return { changes: 0 };
  values.push(id, normalizeStatus(expectedStatus));
  const [result] = await pool.query(
    `UPDATE agent_runs SET ${entries.join(', ')} WHERE id = ? AND status = ?`,
    values
  );
  return { changes: result.affectedRows };
}

async function getLatestAgentRunByChatId(chatId) {
  const [rows] = await pool.query('SELECT * FROM agent_runs WHERE chat_id = ? ORDER BY id DESC LIMIT 1', [chatId]);
  return rows?.[0] || null;
}

async function getAgentRunsByChatId(chatId) {
  const [rows] = await pool.query(
    `SELECT
      r.*,
      a.name AS agent_name,
      a.kind AS agent_kind
     FROM agent_runs r
     LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.chat_id = ?
     ORDER BY r.started_at ASC, r.id ASC`,
    [chatId]
  );
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  initAgentRunsTable,
  insertAgentRun,
  updateAgentRunIfStatus,
  getLatestAgentRunByChatId,
  getAgentRunsByChatId,
};
