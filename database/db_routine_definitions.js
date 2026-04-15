const pool = require('./mysql');

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
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

function hydrateRoutineDefinition(row) {
  if (!row) return null;
  return {
    ...row,
    entrypoint: toNullableString(row.entrypoint),
    runtime: toNullableString(row.runtime) || 'node20',
    template_id: toNullableString(row.template_id),
    checksum: toNullableString(row.checksum),
    sync_status: toNullableString(row.sync_status) || 'missing',
    last_sync_error: toNullableString(row.last_sync_error),
    config_json: parseJsonField(row.config_json, {}),
    permissions_json: parseJsonField(row.permissions_json, {}),
  };
}

async function initRoutineDefinitionsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS routine_definitions (
      name VARCHAR(128) NOT NULL PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT NULL,
      entrypoint VARCHAR(512) NOT NULL,
      runtime VARCHAR(64) NOT NULL DEFAULT 'node20',
      template_id VARCHAR(128) NULL,
      checksum VARCHAR(128) NULL,
      config_json JSON NULL,
      permissions_json JSON NULL,
      sync_status VARCHAR(32) NOT NULL DEFAULT 'missing',
      last_sync_error TEXT NULL,
      version INT NOT NULL DEFAULT 1,
      created_by VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_routine_definitions_sync_status (sync_status),
      INDEX idx_routine_definitions_runtime (runtime)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function getAllRoutineDefinitions() {
  const [rows] = await pool.query('SELECT * FROM routine_definitions ORDER BY title ASC, name ASC');
  return Array.isArray(rows) ? rows.map(hydrateRoutineDefinition) : [];
}

async function getRoutineDefinitionByName(name) {
  const [rows] = await pool.query(
    'SELECT * FROM routine_definitions WHERE name = ? LIMIT 1',
    [String(name || '').trim()]
  );
  return rows?.[0] ? hydrateRoutineDefinition(rows[0]) : null;
}

async function upsertRoutineDefinition(definition) {
  const name = String(definition?.name || '').trim();
  if (!name) {
    throw new Error('Nome routine mancante.');
  }

  await pool.query(
    `INSERT INTO routine_definitions (
      name, title, description, entrypoint, runtime, template_id, checksum,
      config_json, permissions_json, sync_status, last_sync_error, version, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      title = VALUES(title),
      description = VALUES(description),
      entrypoint = VALUES(entrypoint),
      runtime = VALUES(runtime),
      template_id = VALUES(template_id),
      checksum = VALUES(checksum),
      config_json = VALUES(config_json),
      permissions_json = VALUES(permissions_json),
      sync_status = VALUES(sync_status),
      last_sync_error = VALUES(last_sync_error),
      version = VALUES(version)`,
    [
      name,
      String(definition?.title || name).trim(),
      definition?.description === undefined ? null : toNullableString(definition.description),
      String(definition?.entrypoint || './index.js').trim(),
      String(definition?.runtime || 'node20').trim(),
      toNullableString(definition?.template_id),
      toNullableString(definition?.checksum),
      JSON.stringify(definition?.config_json || {}),
      JSON.stringify(definition?.permissions_json || {}),
      String(definition?.sync_status || 'ready').trim(),
      definition?.last_sync_error === undefined ? null : toNullableString(definition.last_sync_error),
      Number.isFinite(Number(definition?.version)) && Number(definition.version) > 0 ? Number(definition.version) : 1,
      toNullableString(definition?.created_by),
    ]
  );

  return getRoutineDefinitionByName(name);
}

async function updateRoutineDefinition(name, updates) {
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
  if (updates.entrypoint !== undefined) {
    entries.push('entrypoint = ?');
    values.push(String(updates.entrypoint || '').trim());
  }
  if (updates.runtime !== undefined) {
    entries.push('runtime = ?');
    values.push(String(updates.runtime || 'node20').trim());
  }
  if (updates.template_id !== undefined) {
    entries.push('template_id = ?');
    values.push(toNullableString(updates.template_id));
  }
  if (updates.checksum !== undefined) {
    entries.push('checksum = ?');
    values.push(toNullableString(updates.checksum));
  }
  if (updates.config_json !== undefined) {
    entries.push('config_json = ?');
    values.push(JSON.stringify(updates.config_json || {}));
  }
  if (updates.permissions_json !== undefined) {
    entries.push('permissions_json = ?');
    values.push(JSON.stringify(updates.permissions_json || {}));
  }
  if (updates.sync_status !== undefined) {
    entries.push('sync_status = ?');
    values.push(String(updates.sync_status || 'missing').trim());
  }
  if (updates.last_sync_error !== undefined) {
    entries.push('last_sync_error = ?');
    values.push(toNullableString(updates.last_sync_error));
  }
  if (updates.version !== undefined) {
    entries.push('version = ?');
    values.push(Number.isFinite(Number(updates.version)) && Number(updates.version) > 0 ? Number(updates.version) : 1);
  }

  if (entries.length === 0) return { changes: 0 };

  values.push(String(name || '').trim());
  const [result] = await pool.query(
    `UPDATE routine_definitions SET ${entries.join(', ')} WHERE name = ?`,
    values
  );
  return { changes: result.affectedRows };
}

async function deleteRoutineDefinition(name) {
  const [result] = await pool.query(
    'DELETE FROM routine_definitions WHERE name = ?',
    [String(name || '').trim()]
  );
  return { changes: result.affectedRows };
}

module.exports = {
  initRoutineDefinitionsTable,
  getAllRoutineDefinitions,
  getRoutineDefinitionByName,
  upsertRoutineDefinition,
  updateRoutineDefinition,
  deleteRoutineDefinition,
};
