const pool = require('./mysql');

const VALID_TASK_STATUSES = new Set([
  'draft',
  'pending',
  'scheduled',
  'running',
  'needs_confirmation',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);
const VALID_TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_ASSIGNMENT_ROLES = new Set(['owner', 'assignee', 'viewer']);
const VALID_SUBJECT_TYPES = new Set(['user', 'group']);
const VALID_RUN_STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);

function normalizeTaskStatus(value, fallback = 'draft') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_TASK_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeTaskPriority(value, fallback = 'normal') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_TASK_PRIORITIES.has(normalized) ? normalized : fallback;
}

function normalizeAssignmentRole(value, fallback = 'viewer') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_ASSIGNMENT_ROLES.has(normalized) ? normalized : fallback;
}

function normalizeSubjectType(value, fallback = 'user') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_SUBJECT_TYPES.has(normalized) ? normalized : fallback;
}

function normalizeRunStatus(value, fallback = 'queued') {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_RUN_STATUSES.has(normalized) ? normalized : fallback;
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

function parseJsonField(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
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

function toJsonString(value, fallback = {}) {
  const normalized = parseJsonField(value, fallback);
  return JSON.stringify(normalized);
}

function hydrateTask(row) {
  if (!row) return null;
  return {
    ...row,
    status: normalizeTaskStatus(row.status, 'draft'),
    priority: normalizeTaskPriority(row.priority, 'normal'),
    is_active: Number(row.is_active) === 1,
    notifications_enabled: Number(row.notifications_enabled) === 1,
    needs_confirmation: Number(row.needs_confirmation) === 1,
    notification_type: String(row.notification_type || '').trim(),
    legacy_source: toNullableString(row.legacy_source),
    schedule_json: parseJsonField(row.schedule_json, null),
    payload_json: parseJsonField(row.payload_json, {}),
    confirmation_request_json: parseJsonField(row.confirmation_request_json, null),
    latest_run_status: row.latest_run_status ? normalizeRunStatus(row.latest_run_status, 'queued') : null,
    latest_run_chat_id: toNullableString(row.latest_run_chat_id),
    latest_run_metadata_json: parseJsonField(row.latest_run_metadata_json, null),
  };
}

const TASK_WITH_LATEST_RUN_SELECT = `
  SELECT
    t.*,
    lr.id AS latest_run_id,
    lr.status AS latest_run_status,
    lr.trigger_type AS latest_run_trigger_type,
    lr.started_at AS latest_run_started_at,
    lr.finished_at AS latest_run_finished_at,
    lr.last_error AS latest_run_last_error,
    lr.chat_id AS latest_run_chat_id,
    lr.metadata_json AS latest_run_metadata_json
  FROM tasks t
  LEFT JOIN (
    SELECT tr1.*
    FROM task_runs tr1
    INNER JOIN (
      SELECT task_id, MAX(id) AS latest_run_id
      FROM task_runs
      GROUP BY task_id
    ) latest ON latest.latest_run_id = tr1.id
  ) lr ON lr.task_id = t.id
`;

async function initTasksTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      status ENUM('draft', 'pending', 'scheduled', 'running', 'needs_confirmation', 'blocked', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'draft',
      priority ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
      schedule_json JSON NULL,
      owner_agent_id BIGINT UNSIGNED NULL,
      worker_agent_id BIGINT UNSIGNED NULL,
      payload_json JSON NULL,
      notification_type VARCHAR(255) NULL,
      notifications_enabled TINYINT(1) NOT NULL DEFAULT 1,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      needs_confirmation TINYINT(1) NOT NULL DEFAULT 0,
      confirmation_request_json JSON NULL,
      legacy_source VARCHAR(64) NULL,
      legacy_source_id BIGINT UNSIGNED NULL,
      created_by VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_tasks_status (status),
      INDEX idx_tasks_priority (priority),
      INDEX idx_tasks_owner_agent (owner_agent_id),
      INDEX idx_tasks_worker_agent (worker_agent_id),
      INDEX idx_tasks_created_by (created_by),
      INDEX idx_tasks_legacy_source (legacy_source, legacy_source_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const additionalColumns = [
    ['notification_type', "ALTER TABLE tasks ADD COLUMN notification_type VARCHAR(255) NULL AFTER payload_json"],
    ['notifications_enabled', "ALTER TABLE tasks ADD COLUMN notifications_enabled TINYINT(1) NOT NULL DEFAULT 1 AFTER notification_type"],
    ['is_active', "ALTER TABLE tasks ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1 AFTER notifications_enabled"],
    ['legacy_source', "ALTER TABLE tasks ADD COLUMN legacy_source VARCHAR(64) NULL AFTER confirmation_request_json"],
    ['legacy_source_id', "ALTER TABLE tasks ADD COLUMN legacy_source_id BIGINT UNSIGNED NULL AFTER legacy_source"],
  ];

  for (const [columnName, sql] of additionalColumns) {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'tasks'
          AND COLUMN_NAME = ?
        LIMIT 1`,
      [columnName]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query(sql);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_runs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      task_id BIGINT UNSIGNED NOT NULL,
      agent_id BIGINT UNSIGNED NULL,
      status ENUM('queued', 'running', 'completed', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
      trigger_type VARCHAR(32) NOT NULL DEFAULT 'manual',
      started_at DATETIME(3) NULL,
      finished_at DATETIME(3) NULL,
      last_error TEXT NULL,
      chat_id VARCHAR(255) NULL,
      metadata_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_task_runs_task (task_id),
      INDEX idx_task_runs_status (status),
      INDEX idx_task_runs_agent (agent_id),
      INDEX idx_task_runs_chat (chat_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const taskRunAdditionalColumns = [
    ['chat_id', "ALTER TABLE task_runs ADD COLUMN chat_id VARCHAR(255) NULL AFTER last_error"],
  ];

  for (const [columnName, sql] of taskRunAdditionalColumns) {
    const [rows] = await pool.query(
      `SELECT COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'task_runs'
          AND COLUMN_NAME = ?
        LIMIT 1`,
      [columnName]
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query(sql);
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_events (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      task_id BIGINT UNSIGNED NOT NULL,
      task_run_id BIGINT UNSIGNED NULL,
      event_type VARCHAR(64) NOT NULL,
      actor_type VARCHAR(32) NULL,
      actor_id VARCHAR(255) NULL,
      content TEXT NULL,
      payload_json JSON NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_task_events_task (task_id, created_at),
      INDEX idx_task_events_run (task_run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_assignments (
      task_id BIGINT UNSIGNED NOT NULL,
      subject_type VARCHAR(32) NOT NULL DEFAULT 'user',
      subject_id VARCHAR(255) NOT NULL,
      role ENUM('owner', 'assignee', 'viewer') NOT NULL DEFAULT 'viewer',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (task_id, subject_type, subject_id, role),
      INDEX idx_task_assignments_subject (subject_type, subject_id),
      INDEX idx_task_assignments_role (role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function cleanupLegacyScheduledActionsTable() {
  try {
    await pool.query('DROP TABLE IF EXISTS scheduled_actions');
  } catch (error) {
    const code = error?.code || error?.errno;
    if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 1142) {
      console.warn('Permesso DROP negato per scheduled_actions, cleanup saltata.');
      return;
    }
    throw error;
  }
}

async function cleanupLegacyStructuredProcessesTables() {
  try {
    await pool.query('DROP TABLE IF EXISTS structured_process_runs');
    await pool.query('DROP TABLE IF EXISTS structured_processes');
  } catch (error) {
    const code = error?.code || error?.errno;
    if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 1142) {
      console.warn('Permesso DROP negato per structured_processes, cleanup saltata.');
      return;
    }
    throw error;
  }
}

async function insertTask(input) {
  const title = String(input?.title || '').trim();
  if (!title) throw new Error('title is required');

  const [result] = await pool.query(
    `INSERT INTO tasks
      (title, description, status, priority, schedule_json, owner_agent_id, worker_agent_id, payload_json, notification_type, notifications_enabled, is_active, needs_confirmation, confirmation_request_json, legacy_source, legacy_source_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title,
      toNullableString(input?.description),
      normalizeTaskStatus(input?.status, 'draft'),
      normalizeTaskPriority(input?.priority, 'normal'),
      input?.schedule_json === undefined ? null : toJsonString(input.schedule_json, null),
      toNullableUnsignedInt(input?.owner_agent_id),
      toNullableUnsignedInt(input?.worker_agent_id),
      toJsonString(input?.payload_json, {}),
      toNullableString(input?.notification_type),
      normalizeBooleanFlag(input?.notifications_enabled, 1),
      normalizeBooleanFlag(input?.is_active, 1),
      normalizeBooleanFlag(input?.needs_confirmation, 0),
      input?.confirmation_request_json === undefined ? null : toJsonString(input.confirmation_request_json, null),
      toNullableString(input?.legacy_source),
      toNullableUnsignedInt(input?.legacy_source_id),
      toNullableString(input?.created_by),
    ]
  );
  return { id: result.insertId };
}

async function updateTask(id, updates) {
  const entries = [];
  const values = [];

  if (updates.title !== undefined) {
    entries.push('title = ?');
    values.push(String(updates.title || '').trim());
  }
  if (updates.description !== undefined) {
    entries.push('description = ?');
    values.push(toNullableString(updates.description));
  }
  if (updates.status !== undefined) {
    entries.push('status = ?');
    values.push(normalizeTaskStatus(updates.status, 'draft'));
  }
  if (updates.priority !== undefined) {
    entries.push('priority = ?');
    values.push(normalizeTaskPriority(updates.priority, 'normal'));
  }
  if (updates.schedule_json !== undefined) {
    entries.push('schedule_json = ?');
    values.push(updates.schedule_json === null ? null : toJsonString(updates.schedule_json, null));
  }
  if (updates.owner_agent_id !== undefined) {
    entries.push('owner_agent_id = ?');
    values.push(toNullableUnsignedInt(updates.owner_agent_id));
  }
  if (updates.worker_agent_id !== undefined) {
    entries.push('worker_agent_id = ?');
    values.push(toNullableUnsignedInt(updates.worker_agent_id));
  }
  if (updates.payload_json !== undefined) {
    entries.push('payload_json = ?');
    values.push(toJsonString(updates.payload_json, {}));
  }
  if (updates.notification_type !== undefined) {
    entries.push('notification_type = ?');
    values.push(toNullableString(updates.notification_type));
  }
  if (updates.notifications_enabled !== undefined) {
    entries.push('notifications_enabled = ?');
    values.push(normalizeBooleanFlag(updates.notifications_enabled, 1));
  }
  if (updates.is_active !== undefined) {
    entries.push('is_active = ?');
    values.push(normalizeBooleanFlag(updates.is_active, 1));
  }
  if (updates.needs_confirmation !== undefined) {
    entries.push('needs_confirmation = ?');
    values.push(normalizeBooleanFlag(updates.needs_confirmation, 0));
  }
  if (updates.confirmation_request_json !== undefined) {
    entries.push('confirmation_request_json = ?');
    values.push(updates.confirmation_request_json === null ? null : toJsonString(updates.confirmation_request_json, null));
  }

  if (entries.length === 0) return { changes: 0 };
  values.push(id);
  const [result] = await pool.query(`UPDATE tasks SET ${entries.join(', ')} WHERE id = ?`, values);
  return { changes: result.affectedRows };
}

async function getTaskById(id) {
  const [rows] = await pool.query(`${TASK_WITH_LATEST_RUN_SELECT} WHERE t.id = ? LIMIT 1`, [id]);
  return rows?.[0] ? hydrateTask(rows[0]) : null;
}

async function getAllTasks() {
  const [rows] = await pool.query(`${TASK_WITH_LATEST_RUN_SELECT} ORDER BY t.updated_at DESC, t.id DESC`);
  return Array.isArray(rows) ? rows.map(hydrateTask) : [];
}

async function getTasksPage(page = 1, pageSize = 20) {
  const normalizedPage = Number.isFinite(Number(page)) && Number(page) > 0 ? Math.trunc(Number(page)) : 1;
  const normalizedPageSize = Number.isFinite(Number(pageSize)) && Number(pageSize) > 0
    ? Math.trunc(Number(pageSize))
    : 20;
  const offset = (normalizedPage - 1) * normalizedPageSize;

  const [[countRow]] = await pool.query('SELECT COUNT(*) AS total FROM tasks');
  const [rows] = await pool.query(
    `${TASK_WITH_LATEST_RUN_SELECT} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [normalizedPageSize, offset]
  );

  return {
    items: Array.isArray(rows) ? rows.map(hydrateTask) : [],
    total: Number(countRow?.total || 0),
    page: normalizedPage,
    page_size: normalizedPageSize,
  };
}

async function getSchedulableTasks() {
  const [rows] = await pool.query(
    `SELECT *
       FROM tasks
      WHERE schedule_json IS NOT NULL
        AND is_active = 1
        AND status IN ('scheduled', 'pending', 'failed')
      ORDER BY updated_at DESC, id DESC`
  );
  return Array.isArray(rows) ? rows.map(hydrateTask) : [];
}

async function findTaskByLegacySource(source, sourceId) {
  const [rows] = await pool.query(
    'SELECT * FROM tasks WHERE legacy_source = ? AND legacy_source_id = ? LIMIT 1',
    [String(source || ''), toNullableUnsignedInt(sourceId)]
  );
  return rows?.[0] ? hydrateTask(rows[0]) : null;
}

async function deleteTask(id) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM task_assignments WHERE task_id = ?', [id]);
    await conn.query('DELETE FROM task_events WHERE task_id = ?', [id]);
    await conn.query('DELETE FROM task_runs WHERE task_id = ?', [id]);
    const [result] = await conn.query('DELETE FROM tasks WHERE id = ?', [id]);
    await conn.commit();
    return { changes: result.affectedRows };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function replaceTaskAssignments(taskId, assignments) {
  const normalized = Array.from(
    new Map(
      (Array.isArray(assignments) ? assignments : [])
        .map((entry) => {
          if (!entry || !entry.subject_id) return null;
          const subject_type = normalizeSubjectType(entry.subject_type, 'user');
          const subject_id = String(entry.subject_id).trim();
          if (!subject_id) return null;
          const role = normalizeAssignmentRole(entry.role, 'viewer');
          return [`${subject_type}:${subject_id}:${role}`, { subject_type, subject_id, role }];
        })
        .filter(Boolean)
    ).values()
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM task_assignments WHERE task_id = ?', [taskId]);
    if (normalized.length > 0) {
      await conn.query(
        'INSERT INTO task_assignments (task_id, subject_type, subject_id, role) VALUES ?',
        [normalized.map((entry) => [taskId, entry.subject_type, entry.subject_id, entry.role])]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return normalized;
}

async function getTaskAssignments(taskId) {
  const [rows] = await pool.query(
    'SELECT subject_type, subject_id, role, created_at FROM task_assignments WHERE task_id = ? ORDER BY subject_type, subject_id, role',
    [taskId]
  );
  return Array.isArray(rows) ? rows : [];
}

async function insertTaskRun(input) {
  const [result] = await pool.query(
    `INSERT INTO task_runs
      (task_id, agent_id, status, trigger_type, started_at, finished_at, last_error, chat_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      toNullableUnsignedInt(input?.task_id),
      toNullableUnsignedInt(input?.agent_id),
      normalizeRunStatus(input?.status, 'queued'),
      toNullableString(input?.trigger_type) || 'manual',
      input?.started_at || null,
      input?.finished_at || null,
      toNullableString(input?.last_error),
      toNullableString(input?.chat_id),
      input?.metadata_json === undefined ? null : toJsonString(input.metadata_json, {}),
    ]
  );
  return { id: result.insertId };
}

async function getTaskRuns(taskId) {
  const [rows] = await pool.query('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC', [taskId]);
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        status: normalizeRunStatus(row.status, 'queued'),
        chat_id: toNullableString(row.chat_id),
        metadata_json: parseJsonField(row.metadata_json, {}),
      }))
    : [];
}

async function updateTaskRun(id, updates) {
  const entries = [];
  const values = [];
  if (updates.status !== undefined) {
    entries.push('status = ?');
    values.push(normalizeRunStatus(updates.status, 'queued'));
  }
  if (updates.started_at !== undefined) {
    entries.push('started_at = ?');
    values.push(updates.started_at);
  }
  if (updates.finished_at !== undefined) {
    entries.push('finished_at = ?');
    values.push(updates.finished_at);
  }
  if (updates.last_error !== undefined) {
    entries.push('last_error = ?');
    values.push(toNullableString(updates.last_error));
  }
  if (updates.chat_id !== undefined) {
    entries.push('chat_id = ?');
    values.push(toNullableString(updates.chat_id));
  }
  if (updates.metadata_json !== undefined) {
    entries.push('metadata_json = ?');
    values.push(updates.metadata_json === null ? null : toJsonString(updates.metadata_json, {}));
  }
  if (entries.length === 0) return { changes: 0 };
  values.push(id);
  const [result] = await pool.query(`UPDATE task_runs SET ${entries.join(', ')} WHERE id = ?`, values);
  return { changes: result.affectedRows };
}

async function updateTaskRunIfStatus(id, updates, expectedStatus) {
  const entries = [];
  const values = [];
  if (updates.status !== undefined) {
    entries.push('status = ?');
    values.push(normalizeRunStatus(updates.status, 'queued'));
  }
  if (updates.started_at !== undefined) {
    entries.push('started_at = ?');
    values.push(updates.started_at);
  }
  if (updates.finished_at !== undefined) {
    entries.push('finished_at = ?');
    values.push(updates.finished_at);
  }
  if (updates.last_error !== undefined) {
    entries.push('last_error = ?');
    values.push(toNullableString(updates.last_error));
  }
  if (updates.chat_id !== undefined) {
    entries.push('chat_id = ?');
    values.push(toNullableString(updates.chat_id));
  }
  if (updates.metadata_json !== undefined) {
    entries.push('metadata_json = ?');
    values.push(updates.metadata_json === null ? null : toJsonString(updates.metadata_json, {}));
  }
  if (entries.length === 0) return { changes: 0 };
  values.push(id, normalizeRunStatus(expectedStatus, 'queued'));
  const [result] = await pool.query(`UPDATE task_runs SET ${entries.join(', ')} WHERE id = ? AND status = ?`, values);
  return { changes: result.affectedRows };
}

async function insertTaskEvent(input) {
  const [result] = await pool.query(
    `INSERT INTO task_events
      (task_id, task_run_id, event_type, actor_type, actor_id, content, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      toNullableUnsignedInt(input?.task_id),
      toNullableUnsignedInt(input?.task_run_id),
      toNullableString(input?.event_type) || 'note',
      toNullableString(input?.actor_type),
      toNullableString(input?.actor_id),
      toNullableString(input?.content),
      input?.payload_json === undefined ? null : toJsonString(input.payload_json, {}),
    ]
  );
  return { id: result.insertId };
}

async function getTaskEvents(taskId) {
  const [rows] = await pool.query('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at DESC, id DESC', [taskId]);
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        payload_json: parseJsonField(row.payload_json, {}),
      }))
    : [];
}

module.exports = {
  initTasksTables,
  cleanupLegacyScheduledActionsTable,
  cleanupLegacyStructuredProcessesTables,
  insertTask,
  updateTask,
  getTaskById,
  getAllTasks,
  getTasksPage,
  getSchedulableTasks,
  findTaskByLegacySource,
  deleteTask,
  replaceTaskAssignments,
  getTaskAssignments,
  insertTaskRun,
  getTaskRuns,
  updateTaskRun,
  updateTaskRunIfStatus,
  insertTaskEvent,
  getTaskEvents,
  normalizeTaskStatus,
  normalizeTaskPriority,
};
