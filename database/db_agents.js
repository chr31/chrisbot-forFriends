const pool = require('./mysql');

const VALID_AGENT_KINDS = new Set(['worker', 'orchestrator']);
const VALID_VISIBILITY_SCOPES = new Set(['public', 'restricted', 'private']);
const VALID_PERMISSION_ROLES = new Set(['chat', 'manage']);
const VALID_PERMISSION_SUBJECT_TYPES = new Set(['user', 'upn']);
const VALID_MEMORY_SCOPES = new Set(['shared', 'dedicated']);
const { normalizeModelConfig, getDefaultModelConfig } = require('../services/aiModelCatalog');

function normalizeAgentKind(value) {
  const normalized = String(value || 'worker').trim().toLowerCase();
  return VALID_AGENT_KINDS.has(normalized) ? normalized : 'worker';
}

function normalizeVisibilityScope(value) {
  const normalized = String(value || 'public').trim().toLowerCase();
  return VALID_VISIBILITY_SCOPES.has(normalized) ? normalized : 'public';
}

function normalizePermissionRole(value) {
  const normalized = String(value || 'chat').trim().toLowerCase();
  return VALID_PERMISSION_ROLES.has(normalized) ? normalized : 'chat';
}

function normalizePermissionSubjectType(value) {
  const normalized = String(value || 'user').trim().toLowerCase();
  return VALID_PERMISSION_SUBJECT_TYPES.has(normalized) ? normalized : 'user';
}

function normalizeMemoryScope(value) {
  const normalized = String(value || 'shared').trim().toLowerCase();
  return VALID_MEMORY_SCOPES.has(normalized) ? normalized : 'shared';
}

function normalizeBooleanFlag(value, defaultValue = 0) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value ? 1 : 0;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['1', 'true', 'si', 'yes', 'y', 'on'].includes(lowered)) return 1;
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

function sanitizeGuardrailsConfig(value) {
  const source = parseJsonField(value, {});
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return {};
  }

  const nextValue = { ...source };
  delete nextValue.allow_direct_tool_access;
  return nextValue;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function hydrateAgent(row) {
  if (!row) return null;
  const {
    default_model_provider: _defaultModelProvider,
    default_model_name: _defaultModelName,
    default_ollama_server_id: _defaultOllamaServerId,
    ...rest
  } = row;
  const defaultModelConfig = normalizeModelConfig({
    model_provider: _defaultModelProvider,
    model_name: _defaultModelName,
    ollama_server_id: _defaultOllamaServerId,
  }, getDefaultModelConfig());
  return {
    ...rest,
    user_description: String(row.user_description || '').trim(),
    allowed_group_names_csv: String(row.allowed_group_names_csv || '').trim(),
    allowed_group_names: String(row.allowed_group_names_csv || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
    kind: normalizeAgentKind(row.kind),
    visibility_scope: normalizeVisibilityScope(row.visibility_scope),
    direct_chat_enabled: Number(row.direct_chat_enabled) === 1,
    is_active: Number(row.is_active) === 1,
    is_alive: Number(row.is_alive) === 1,
    alive_loop_seconds: Number.isFinite(Number(row.alive_loop_seconds)) ? Math.max(1, Math.trunc(Number(row.alive_loop_seconds))) : 60,
    alive_prompt: String(row.alive_prompt || '').trim(),
    alive_context_messages: Number.isFinite(Number(row.alive_context_messages)) ? Math.max(1, Math.trunc(Number(row.alive_context_messages))) : 12,
    alive_include_goals: Number(row.alive_include_goals) === 1,
    goals: String(row.goals || ''),
    memory_engine_enabled: Number(row.memory_engine_enabled) === 1,
    improve_memories_enabled: Number(row.improve_memories_enabled) === 1,
    memory_scope: normalizeMemoryScope(row.memory_scope),
    guardrails_json: sanitizeGuardrailsConfig(row.guardrails_json),
    default_model_config: defaultModelConfig,
  };
}

async function initAgentsTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      slug VARCHAR(80) NOT NULL UNIQUE,
      kind ENUM('worker', 'orchestrator') NOT NULL DEFAULT 'worker',
      user_description TEXT NULL,
      allowed_group_names_csv TEXT NULL,
      system_prompt LONGTEXT NOT NULL,
      default_model_provider VARCHAR(32) NOT NULL DEFAULT 'ollama',
      default_model_name VARCHAR(128) NOT NULL DEFAULT 'qwen3.5',
      default_ollama_server_id VARCHAR(128) NULL,
      guardrails_json JSON NULL,
      visibility_scope ENUM('public', 'restricted', 'private') NOT NULL DEFAULT 'public',
      direct_chat_enabled TINYINT(1) NOT NULL DEFAULT 1,
      is_alive TINYINT(1) NOT NULL DEFAULT 0,
      alive_loop_seconds INT NOT NULL DEFAULT 60,
      alive_prompt LONGTEXT NULL,
      alive_context_messages INT NOT NULL DEFAULT 12,
      alive_include_goals TINYINT(1) NOT NULL DEFAULT 0,
      goals LONGTEXT NULL,
      memory_engine_enabled TINYINT(1) NOT NULL DEFAULT 0,
      improve_memories_enabled TINYINT(1) NOT NULL DEFAULT 0,
      memory_scope ENUM('shared', 'dedicated') NOT NULL DEFAULT 'shared',
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by VARCHAR(255) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      INDEX idx_agents_kind (kind),
      INDEX idx_agents_visibility (visibility_scope),
      INDEX idx_agents_active (is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  const [userDescriptionColumns] = await pool.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'agents'
        AND COLUMN_NAME = 'user_description'
      LIMIT 1`
  );

  if (!Array.isArray(userDescriptionColumns) || userDescriptionColumns.length === 0) {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN user_description TEXT NULL AFTER kind
    `);
  }

  const [allowedGroupColumns] = await pool.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'agents'
        AND COLUMN_NAME = 'allowed_group_names_csv'
      LIMIT 1`
  );

  if (!Array.isArray(allowedGroupColumns) || allowedGroupColumns.length === 0) {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN allowed_group_names_csv TEXT NULL AFTER user_description
    `);
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN default_model_provider VARCHAR(32) NOT NULL DEFAULT 'ollama' AFTER system_prompt
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN default_model_name VARCHAR(128) NOT NULL DEFAULT 'qwen3.5' AFTER default_model_provider
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN default_ollama_server_id VARCHAR(128) NULL AFTER default_model_name
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN is_alive TINYINT(1) NOT NULL DEFAULT 0 AFTER direct_chat_enabled
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN alive_loop_seconds INT NOT NULL DEFAULT 60 AFTER is_alive
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN alive_prompt LONGTEXT NULL AFTER alive_loop_seconds
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN alive_context_messages INT NOT NULL DEFAULT 12 AFTER alive_prompt
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN alive_include_goals TINYINT(1) NOT NULL DEFAULT 0 AFTER alive_context_messages
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN goals LONGTEXT NULL AFTER alive_include_goals
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN memory_engine_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER goals
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN memory_scope ENUM('shared', 'dedicated') NOT NULL DEFAULT 'shared' AFTER memory_engine_enabled
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  try {
    await pool.query(`
      ALTER TABLE agents
      ADD COLUMN improve_memories_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER memory_engine_enabled
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  await pool.query(`
    UPDATE agents
       SET guardrails_json = JSON_REMOVE(guardrails_json, '$.allow_direct_tool_access')
     WHERE JSON_CONTAINS_PATH(guardrails_json, 'one', '$.allow_direct_tool_access')
  `).catch((error) => {
    if (error && error.code !== 'ER_BAD_FIELD_ERROR' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  });

  await pool.query(`
    UPDATE agents
       SET default_model_name = COALESCE(NULLIF(default_model_name, ''), default_model),
           default_model_provider = CASE
             WHEN default_model_provider IS NULL OR default_model_provider = '' THEN 'ollama'
             ELSE default_model_provider
           END
     WHERE default_model IS NOT NULL
  `).catch((error) => {
    if (error && error.code !== 'ER_BAD_FIELD_ERROR' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  });

  try {
    await pool.query(`
      ALTER TABLE agents
      DROP COLUMN default_model
    `);
  } catch (error) {
    if (error && error.code !== 'ER_CANT_DROP_FIELD_OR_KEY' && error.code !== 'ER_BAD_FIELD_ERROR' && error.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_tool_bindings (
      agent_id BIGINT UNSIGNED NOT NULL,
      tool_name VARCHAR(255) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (agent_id, tool_name),
      INDEX idx_agent_tool_bindings_agent (agent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_relations (
      orchestrator_agent_id BIGINT UNSIGNED NOT NULL,
      worker_agent_id BIGINT UNSIGNED NOT NULL,
      priority INT NOT NULL DEFAULT 0,
      routing_hint VARCHAR(255) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (orchestrator_agent_id, worker_agent_id),
      INDEX idx_agent_relations_orchestrator (orchestrator_agent_id),
      INDEX idx_agent_relations_worker (worker_agent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_permissions (
      agent_id BIGINT UNSIGNED NOT NULL,
      subject_type VARCHAR(32) NOT NULL DEFAULT 'user',
      subject_id VARCHAR(255) NOT NULL,
      role ENUM('chat', 'manage') NOT NULL DEFAULT 'chat',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (agent_id, subject_type, subject_id, role),
      INDEX idx_agent_permissions_agent (agent_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function ensureUniqueSlug(baseSlug, excludedId = null) {
  const seed = slugify(baseSlug) || 'agent';
  let attempt = 0;
  let candidate = seed;

  while (attempt < 1000) {
    const sql = excludedId
      ? 'SELECT id FROM agents WHERE slug = ? AND id <> ? LIMIT 1'
      : 'SELECT id FROM agents WHERE slug = ? LIMIT 1';
    const params = excludedId ? [candidate, excludedId] : [candidate];
    const [rows] = await pool.query(sql, params);
    if (!Array.isArray(rows) || rows.length === 0) return candidate;
    attempt += 1;
    candidate = `${seed.slice(0, 72)}-${attempt}`;
  }

  return `${seed.slice(0, 68)}-${Date.now().toString().slice(-6)}`;
}

async function insertAgent(input) {
  const name = String(input?.name || '').trim();
  const systemPrompt = String(input?.system_prompt || '').trim();
  const directChatEnabled = normalizeBooleanFlag(input?.direct_chat_enabled, 1);
  const isAlive = directChatEnabled ? normalizeBooleanFlag(input?.is_alive, 0) : 0;
  if (!name) throw new Error('name is required');
  if (!systemPrompt) throw new Error('system_prompt is required');

  const slug = await ensureUniqueSlug(input?.slug || name);
  const defaultModelConfig = normalizeModelConfig(input, getDefaultModelConfig());
  const [result] = await pool.query(
    `INSERT INTO agents
      (name, slug, kind, user_description, allowed_group_names_csv, system_prompt, default_model_provider, default_model_name, default_ollama_server_id, guardrails_json, visibility_scope, direct_chat_enabled, is_alive, alive_loop_seconds, alive_prompt, alive_context_messages, alive_include_goals, goals, memory_engine_enabled, improve_memories_enabled, memory_scope, is_active, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      slug,
      normalizeAgentKind(input?.kind),
      String(input?.user_description || '').trim() || null,
      String(input?.allowed_group_names_csv || '').trim() || null,
      systemPrompt,
      defaultModelConfig.provider,
      defaultModelConfig.model,
      defaultModelConfig.ollama_server_id,
      JSON.stringify(sanitizeGuardrailsConfig(input?.guardrails_json ?? input?.guardrails)),
      normalizeVisibilityScope(input?.visibility_scope),
      directChatEnabled,
      isAlive,
      Number.isFinite(Number(input?.alive_loop_seconds)) ? Math.max(1, Math.trunc(Number(input.alive_loop_seconds))) : 60,
      String(input?.alive_prompt || '').trim() || null,
      Number.isFinite(Number(input?.alive_context_messages)) ? Math.max(1, Math.trunc(Number(input.alive_context_messages))) : 12,
      normalizeBooleanFlag(input?.alive_include_goals, 0),
      String(input?.goals || '') || null,
      normalizeBooleanFlag(input?.memory_engine_enabled, 0),
      normalizeBooleanFlag(input?.improve_memories_enabled, 0),
      normalizeMemoryScope(input?.memory_scope),
      normalizeBooleanFlag(input?.is_active, 1),
      input?.created_by ? String(input.created_by) : null,
    ]
  );
  return { id: result.insertId };
}

async function updateAgent(id, updates) {
  const entries = [];
  const values = [];

  if (updates.name !== undefined) {
    entries.push('name = ?');
    values.push(String(updates.name).trim());
  }
  if (updates.slug !== undefined) {
    entries.push('slug = ?');
    values.push(await ensureUniqueSlug(updates.slug, id));
  }
  if (updates.kind !== undefined) {
    entries.push('kind = ?');
    values.push(normalizeAgentKind(updates.kind));
  }
  if (updates.user_description !== undefined) {
    entries.push('user_description = ?');
    values.push(String(updates.user_description || '').trim() || null);
  }
  if (updates.allowed_group_names_csv !== undefined) {
    entries.push('allowed_group_names_csv = ?');
    values.push(String(updates.allowed_group_names_csv || '').trim() || null);
  }
  if (updates.system_prompt !== undefined) {
    entries.push('system_prompt = ?');
    values.push(String(updates.system_prompt || '').trim());
  }
  if (
    updates.default_model_config !== undefined
    || updates.default_model_provider !== undefined
    || updates.default_model_name !== undefined
    || updates.default_ollama_server_id !== undefined
    || updates.model_config !== undefined
  ) {
    const currentAgent = await getAgentById(id);
    const defaultModelConfig = normalizeModelConfig(
      updates.default_model_config ? { model_config: updates.default_model_config } : updates,
      currentAgent?.default_model_config || getDefaultModelConfig()
    );
    entries.push('default_model_provider = ?');
    values.push(defaultModelConfig.provider);
    entries.push('default_model_name = ?');
    values.push(defaultModelConfig.model);
    entries.push('default_ollama_server_id = ?');
    values.push(defaultModelConfig.ollama_server_id);
  }
  if (updates.guardrails !== undefined || updates.guardrails_json !== undefined) {
    entries.push('guardrails_json = ?');
    values.push(JSON.stringify(sanitizeGuardrailsConfig(updates.guardrails_json ?? updates.guardrails)));
  }
  if (updates.visibility_scope !== undefined) {
    entries.push('visibility_scope = ?');
    values.push(normalizeVisibilityScope(updates.visibility_scope));
  }
  if (updates.direct_chat_enabled !== undefined) {
    entries.push('direct_chat_enabled = ?');
    values.push(normalizeBooleanFlag(updates.direct_chat_enabled, 1));
  }
  if (updates.is_alive !== undefined || updates.direct_chat_enabled !== undefined) {
    const currentAgent = await getAgentById(id);
    const nextDirectChatEnabled = updates.direct_chat_enabled !== undefined
      ? normalizeBooleanFlag(updates.direct_chat_enabled, 1)
      : normalizeBooleanFlag(currentAgent?.direct_chat_enabled, 1);
    const nextIsAlive = nextDirectChatEnabled
      ? normalizeBooleanFlag(updates.is_alive !== undefined ? updates.is_alive : currentAgent?.is_alive, 0)
      : 0;
    entries.push('is_alive = ?');
    values.push(nextIsAlive);
  }
  if (updates.alive_loop_seconds !== undefined) {
    entries.push('alive_loop_seconds = ?');
    values.push(Number.isFinite(Number(updates.alive_loop_seconds)) ? Math.max(1, Math.trunc(Number(updates.alive_loop_seconds))) : 60);
  }
  if (updates.alive_prompt !== undefined) {
    entries.push('alive_prompt = ?');
    values.push(String(updates.alive_prompt || '').trim() || null);
  }
  if (updates.alive_context_messages !== undefined) {
    entries.push('alive_context_messages = ?');
    values.push(Number.isFinite(Number(updates.alive_context_messages)) ? Math.max(1, Math.trunc(Number(updates.alive_context_messages))) : 12);
  }
  if (updates.alive_include_goals !== undefined) {
    entries.push('alive_include_goals = ?');
    values.push(normalizeBooleanFlag(updates.alive_include_goals, 0));
  }
  if (updates.goals !== undefined) {
    entries.push('goals = ?');
    values.push(String(updates.goals || '') || null);
  }
  if (updates.memory_engine_enabled !== undefined) {
    entries.push('memory_engine_enabled = ?');
    values.push(normalizeBooleanFlag(updates.memory_engine_enabled, 0));
  }
  if (updates.improve_memories_enabled !== undefined) {
    entries.push('improve_memories_enabled = ?');
    values.push(normalizeBooleanFlag(updates.improve_memories_enabled, 0));
  }
  if (updates.memory_scope !== undefined) {
    entries.push('memory_scope = ?');
    values.push(normalizeMemoryScope(updates.memory_scope));
  }
  if (updates.is_active !== undefined) {
    entries.push('is_active = ?');
    values.push(normalizeBooleanFlag(updates.is_active, 1));
  }

  if (entries.length === 0) return { changes: 0 };
  values.push(id);
  const [result] = await pool.query(`UPDATE agents SET ${entries.join(', ')} WHERE id = ?`, values);
  return { changes: result.affectedRows };
}

async function getAgentById(id) {
  const [rows] = await pool.query('SELECT * FROM agents WHERE id = ? LIMIT 1', [id]);
  return rows?.[0] ? hydrateAgent(rows[0]) : null;
}

async function getAgentBySlug(slug) {
  const [rows] = await pool.query('SELECT * FROM agents WHERE slug = ? LIMIT 1', [slug]);
  return rows?.[0] ? hydrateAgent(rows[0]) : null;
}

async function getAllAgents() {
  const [rows] = await pool.query('SELECT * FROM agents ORDER BY updated_at DESC, id DESC');
  return Array.isArray(rows) ? rows.map(hydrateAgent) : [];
}

async function deleteAgent(id) {
  await pool.query('DELETE FROM agent_permissions WHERE agent_id = ?', [id]);
  await pool.query('DELETE FROM agent_relations WHERE orchestrator_agent_id = ? OR worker_agent_id = ?', [id, id]);
  await pool.query('DELETE FROM agent_tool_bindings WHERE agent_id = ?', [id]);
  const [result] = await pool.query('DELETE FROM agents WHERE id = ?', [id]);
  return { changes: result.affectedRows };
}

async function replaceAgentTools(agentId, toolNames) {
  const sanitized = Array.from(
    new Set(
      (Array.isArray(toolNames) ? toolNames : [])
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM agent_tool_bindings WHERE agent_id = ?', [agentId]);
    if (sanitized.length > 0) {
      await conn.query(
        'INSERT INTO agent_tool_bindings (agent_id, tool_name) VALUES ?',
        [sanitized.map((toolName) => [agentId, toolName])]
      );
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }

  return sanitized;
}

async function getAgentToolNames(agentId) {
  const [rows] = await pool.query(
    'SELECT tool_name FROM agent_tool_bindings WHERE agent_id = ? ORDER BY tool_name ASC',
    [agentId]
  );
  return Array.isArray(rows) ? rows.map((row) => row.tool_name) : [];
}

async function replaceAgentRelations(orchestratorId, relations) {
  const normalized = Array.from(
    new Map(
      (Array.isArray(relations) ? relations : [])
        .map((entry) => {
          if (entry === null || entry === undefined) return null;
          if (typeof entry === 'number' || typeof entry === 'string') {
            const workerId = Number.parseInt(String(entry), 10);
            if (!Number.isFinite(workerId) || workerId <= 0) return null;
            return [workerId, { worker_agent_id: workerId, priority: 0, routing_hint: null, is_active: 1 }];
          }
          const workerId = Number.parseInt(String(entry.worker_agent_id ?? entry.agent_id ?? entry.id), 10);
          if (!Number.isFinite(workerId) || workerId <= 0) return null;
          return [workerId, {
            worker_agent_id: workerId,
            priority: Number.isFinite(Number(entry.priority)) ? Math.trunc(Number(entry.priority)) : 0,
            routing_hint: entry.routing_hint ? String(entry.routing_hint) : null,
            is_active: normalizeBooleanFlag(entry.is_active, 1),
          }];
        })
        .filter(Boolean)
    ).values()
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM agent_relations WHERE orchestrator_agent_id = ?', [orchestratorId]);
    if (normalized.length > 0) {
      await conn.query(
        `INSERT INTO agent_relations
          (orchestrator_agent_id, worker_agent_id, priority, routing_hint, is_active)
         VALUES ?`,
        [normalized.map((entry) => [
          orchestratorId,
          entry.worker_agent_id,
          entry.priority,
          entry.routing_hint,
          entry.is_active,
        ])]
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

async function getAgentRelations(orchestratorId) {
  const [rows] = await pool.query(
    `SELECT
      rel.orchestrator_agent_id,
      rel.worker_agent_id,
      rel.priority,
      rel.routing_hint,
      rel.is_active,
      agent.name AS worker_name,
      agent.slug AS worker_slug,
      agent.kind AS worker_kind
     FROM agent_relations rel
     JOIN agents agent ON agent.id = rel.worker_agent_id
     WHERE rel.orchestrator_agent_id = ?
     ORDER BY rel.priority DESC, agent.name ASC`,
    [orchestratorId]
  );
  return Array.isArray(rows)
    ? rows.map((row) => ({
        ...row,
        is_active: Number(row.is_active) === 1,
      }))
    : [];
}

async function replaceAgentPermissions(agentId, permissions) {
  const normalized = Array.from(
    new Map(
      (Array.isArray(permissions) ? permissions : [])
        .map((entry) => {
          if (!entry || !entry.subject_id) return null;
          const subjectType = normalizePermissionSubjectType(entry.subject_type);
          const subjectId = String(entry.subject_id).trim().toLowerCase();
          if (!subjectId) return null;
          const role = normalizePermissionRole(entry.role);
          return [`${subjectType}:${subjectId}:${role}`, { subject_type: subjectType, subject_id: subjectId, role }];
        })
        .filter(Boolean)
    ).values()
  );

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM agent_permissions WHERE agent_id = ?', [agentId]);
    if (normalized.length > 0) {
      await conn.query(
        'INSERT INTO agent_permissions (agent_id, subject_type, subject_id, role) VALUES ?',
        [normalized.map((entry) => [agentId, entry.subject_type, entry.subject_id, entry.role])]
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

async function getAgentPermissions(agentId) {
  const [rows] = await pool.query(
    'SELECT subject_type, subject_id, role FROM agent_permissions WHERE agent_id = ? ORDER BY subject_type, subject_id, role',
    [agentId]
  );
  return Array.isArray(rows) ? rows : [];
}

async function getAliveAgents() {
  const [rows] = await pool.query(
    'SELECT * FROM agents WHERE is_alive = 1 AND direct_chat_enabled = 1 AND is_active = 1 ORDER BY name ASC, id ASC'
  );
  return Array.isArray(rows) ? rows.map(hydrateAgent) : [];
}

module.exports = {
  initAgentsTables,
  insertAgent,
  updateAgent,
  getAgentById,
  getAgentBySlug,
  getAllAgents,
  getAliveAgents,
  deleteAgent,
  replaceAgentTools,
  getAgentToolNames,
  replaceAgentRelations,
  getAgentRelations,
  replaceAgentPermissions,
  getAgentPermissions,
  normalizeAgentKind,
  normalizeVisibilityScope,
};
