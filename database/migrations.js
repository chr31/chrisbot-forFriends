const pool = require('./mysql');

const MIGRATIONS = [
  {
    id: '20260423_001_agent_chats_config_json',
    description: 'Ensure agent_chats.config_json exists for per-chat model configuration.',
    async up(db) {
      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agent_chats'
            AND COLUMN_NAME = 'config_json'
          LIMIT 1`
      );

      if (Array.isArray(columns) && columns.length > 0) return;

      const [tables] = await db.query(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agent_chats'
          LIMIT 1`
      );

      if (!Array.isArray(tables) || tables.length === 0) return;

      await db.query('ALTER TABLE agent_chats ADD COLUMN config_json JSON NULL AFTER title');
    },
  },
  {
    id: '20260501_001_drop_agent_memories',
    description: 'Remove legacy plain-text agent memories in preparation for Memory Engine.',
    async up(db) {
      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
            AND COLUMN_NAME = 'memories'
          LIMIT 1`
      );

      if (!Array.isArray(columns) || columns.length === 0) return;

      await db.query('ALTER TABLE agents DROP COLUMN memories');
    },
  },
  {
    id: '20260501_002_agent_memory_engine_flags',
    description: 'Add per-agent Memory Engine enable flag.',
    async up(db) {
      const [tables] = await db.query(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
          LIMIT 1`
      );

      if (!Array.isArray(tables) || tables.length === 0) return;

      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
            AND COLUMN_NAME = 'memory_engine_enabled'
          LIMIT 1`
      );

      if (Array.isArray(columns) && columns.length > 0) return;
      await db.query('ALTER TABLE agents ADD COLUMN memory_engine_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER goals');
    },
  },
  {
    id: '20260502_001_agent_improve_memories_flag',
    description: 'Add legacy per-agent Improve memories flag.',
    async up(db) {
      const [tables] = await db.query(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
          LIMIT 1`
      );

      if (!Array.isArray(tables) || tables.length === 0) return;

      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
            AND COLUMN_NAME = 'improve_memories_enabled'
          LIMIT 1`
      );

      if (Array.isArray(columns) && columns.length > 0) return;

      await db.query('ALTER TABLE agents ADD COLUMN improve_memories_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER memory_engine_enabled');
    },
  },
  {
    id: '20260611_001_agent_llm_wiki_project_id',
    description: 'Add per-agent LLM Wiki project override for read-only memory retrieval.',
    async up(db) {
      const [tables] = await db.query(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
          LIMIT 1`
      );

      if (!Array.isArray(tables) || tables.length === 0) return;

      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
            AND COLUMN_NAME = 'llm_wiki_project_id'
          LIMIT 1`
      );

      if (Array.isArray(columns) && columns.length > 0) return;
      await db.query('ALTER TABLE agents ADD COLUMN llm_wiki_project_id VARCHAR(255) NULL AFTER memory_engine_enabled');
    },
  },
  {
    id: '20260611_002_drop_legacy_memory_runtime_columns',
    description: 'Drop legacy runtime memory writing agent columns for LLM Wiki read-only memory.',
    async up(db) {
      const [tables] = await db.query(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
          LIMIT 1`
      );

      if (!Array.isArray(tables) || tables.length === 0) return;

      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
            AND COLUMN_NAME = 'improve_memories_enabled'
          LIMIT 1`
      );

      if (!Array.isArray(columns) || columns.length === 0) return;
      await db.query('ALTER TABLE agents DROP COLUMN improve_memories_enabled');
    },
  },
  {
    id: '20260707_001_agent_improve_memories_flag_mem0',
    description: 'Re-add per-agent Improve memories flag for mem0 write path (afterMemory).',
    async up(db) {
      const [tables] = await db.query(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
          LIMIT 1`
      );

      if (!Array.isArray(tables) || tables.length === 0) return;

      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
            AND COLUMN_NAME = 'improve_memories_enabled'
          LIMIT 1`
      );

      if (Array.isArray(columns) && columns.length > 0) return;
      await db.query('ALTER TABLE agents ADD COLUMN improve_memories_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER memory_engine_enabled');
    },
  },
  {
    id: '20260708_001_cleanup_neo4j_control_legacy',
    description: 'Remove Control Engine settings row, legacy memory keys and the per-agent llm_wiki_project_id column.',
    async up(db) {
      // Control Engine dismesso: elimina la riga di impostazioni dedicata.
      await db.query("DELETE FROM app_settings WHERE setting_key = 'control_engine'");

      // Rimuove dal JSON memory_engine le chiavi legacy non piu' prodotte dal
      // percorso mem0 (LLM Wiki, dashboard grafo, Neo4j memoria, prompt legacy).
      const [memoryRows] = await db.query(
        "SELECT setting_key FROM app_settings WHERE setting_key = 'memory_engine' LIMIT 1"
      );
      if (Array.isArray(memoryRows) && memoryRows.length > 0) {
        await db.query(
          `UPDATE app_settings
              SET value_json = JSON_REMOVE(
                value_json,
                '$.llm_wiki_api_url', '$.llm_wiki_api_token', '$.llm_wiki_default_project_id',
                '$.llm_wiki_timeout_ms', '$.llm_wiki_max_search_results', '$.llm_wiki_max_pages_to_read',
                '$.llm_wiki_max_injected_chars', '$.retrieval_context_messages',
                '$.graph_dashboard_password_hash', '$.graph_dashboard_password_version',
                '$.neo4j_url', '$.neo4j_browser_url', '$.neo4j_username', '$.neo4j_password',
                '$.before_memory_prompt', '$.after_memory_prompt', '$.memory_agent_system_prompt'
              )
            WHERE setting_key = 'memory_engine'`
        );
      }

      // Colonna per-agente legacy dell'era LLM Wiki.
      const [tables] = await db.query(
        `SELECT TABLE_NAME
           FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
          LIMIT 1`
      );
      if (!Array.isArray(tables) || tables.length === 0) return;

      const [columns] = await db.query(
        `SELECT COLUMN_NAME
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'agents'
            AND COLUMN_NAME = 'llm_wiki_project_id'
          LIMIT 1`
      );
      if (Array.isArray(columns) && columns.length > 0) {
        await db.query('ALTER TABLE agents DROP COLUMN llm_wiki_project_id');
      }
    },
  },
];

async function initSchemaMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) NOT NULL PRIMARY KEY,
      description VARCHAR(255) NULL,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function hasMigrationRun(db, id) {
  const [rows] = await db.query('SELECT id FROM schema_migrations WHERE id = ? LIMIT 1', [id]);
  return Array.isArray(rows) && rows.length > 0;
}

async function runDatabaseMigrations() {
  await initSchemaMigrationsTable();

  for (const migration of MIGRATIONS) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (await hasMigrationRun(conn, migration.id)) {
        await conn.commit();
        continue;
      }
      await migration.up(conn);
      await conn.query(
        'INSERT INTO schema_migrations (id, description) VALUES (?, ?)',
        [migration.id, migration.description || null]
      );
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
}

module.exports = {
  runDatabaseMigrations,
};
