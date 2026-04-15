const pool = require('./mysql');

const LEGACY_ROUTINE_DEFAULTS = Object.freeze([]);

function hydrateLegacyRoutine(row) {
  if (!row) return null;
  return {
    ...row,
    is_active: Number(row.is_active) === 1,
    is_running: Number(row.is_running) === 1,
  };
}

async function initLegacyRoutineTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS legacy_routines (
      name VARCHAR(128) NOT NULL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      cron_expression VARCHAR(255) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 0,
      is_running TINYINT(1) NOT NULL DEFAULT 0,
      last_run_id BIGINT UNSIGNED NULL,
      last_started_at DATETIME(3) NULL,
      last_finished_at DATETIME(3) NULL,
      last_status VARCHAR(32) NULL,
      last_error TEXT NULL,
      last_triggered_by VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_legacy_routines_active (is_active),
      INDEX idx_legacy_routines_status (last_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  for (const routine of LEGACY_ROUTINE_DEFAULTS) {
    await pool.query(
      `INSERT INTO legacy_routines (name, title, description, cron_expression, is_active)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         description = VALUES(description)`,
      [
        routine.name,
        routine.title,
        routine.description,
        routine.cron_expression,
        routine.is_active,
      ]
    );
  }
}

async function getAllLegacyRoutines() {
  const [rows] = await pool.query(
    'SELECT * FROM legacy_routines ORDER BY title ASC, name ASC'
  );
  return Array.isArray(rows) ? rows.map(hydrateLegacyRoutine) : [];
}

async function getLegacyRoutineByName(name) {
  const [rows] = await pool.query(
    'SELECT * FROM legacy_routines WHERE name = ? LIMIT 1',
    [String(name || '').trim()]
  );
  return rows?.[0] ? hydrateLegacyRoutine(rows[0]) : null;
}

async function ensureLegacyRoutine(routine) {
  const name = String(routine?.name || '').trim();
  if (!name) {
    throw new Error('Nome routine mancante.');
  }

  await pool.query(
    `INSERT INTO legacy_routines (name, title, description, cron_expression, is_active)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title),
       description = VALUES(description)`,
    [
      name,
      String(routine?.title || name).trim(),
      routine?.description === undefined || routine?.description === null
        ? null
        : (String(routine.description).trim() || null),
      routine?.cron_expression ? String(routine.cron_expression).trim() : null,
      routine?.is_active ? 1 : 0,
    ]
  );

  return getLegacyRoutineByName(name);
}

async function updateLegacyRoutine(name, updates) {
  const entries = [];
  const values = [];

  if (updates.title !== undefined) {
    entries.push('title = ?');
    values.push(String(updates.title || '').trim());
  }
  if (updates.description !== undefined) {
    entries.push('description = ?');
    values.push(updates.description === null ? null : String(updates.description || '').trim() || null);
  }
  if (updates.cron_expression !== undefined) {
    entries.push('cron_expression = ?');
    values.push(updates.cron_expression === null ? null : String(updates.cron_expression || '').trim() || null);
  }
  if (updates.is_active !== undefined) {
    entries.push('is_active = ?');
    values.push(updates.is_active ? 1 : 0);
  }
  if (updates.is_running !== undefined) {
    entries.push('is_running = ?');
    values.push(updates.is_running ? 1 : 0);
  }
  if (updates.last_run_id !== undefined) {
    entries.push('last_run_id = ?');
    values.push(updates.last_run_id || null);
  }
  if (updates.last_started_at !== undefined) {
    entries.push('last_started_at = ?');
    values.push(updates.last_started_at || null);
  }
  if (updates.last_finished_at !== undefined) {
    entries.push('last_finished_at = ?');
    values.push(updates.last_finished_at || null);
  }
  if (updates.last_status !== undefined) {
    entries.push('last_status = ?');
    values.push(updates.last_status || null);
  }
  if (updates.last_error !== undefined) {
    entries.push('last_error = ?');
    values.push(updates.last_error || null);
  }
  if (updates.last_triggered_by !== undefined) {
    entries.push('last_triggered_by = ?');
    values.push(updates.last_triggered_by || null);
  }

  if (entries.length === 0) return { changes: 0 };

  values.push(String(name || '').trim());
  const [result] = await pool.query(
    `UPDATE legacy_routines SET ${entries.join(', ')} WHERE name = ?`,
    values
  );
  return { changes: result.affectedRows };
}

async function deleteLegacyRoutine(name) {
  const [result] = await pool.query(
    'DELETE FROM legacy_routines WHERE name = ?',
    [String(name || '').trim()]
  );
  return { changes: result.affectedRows };
}

module.exports = {
  LEGACY_ROUTINE_DEFAULTS,
  initLegacyRoutineTables,
  getAllLegacyRoutines,
  getLegacyRoutineByName,
  ensureLegacyRoutine,
  updateLegacyRoutine,
  deleteLegacyRoutine,
};
