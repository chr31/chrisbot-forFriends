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
    description: 'Add per-agent Memory Engine enable flag and memory scope.',
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
            AND COLUMN_NAME IN ('memory_engine_enabled', 'memory_scope')`
      );
      const existing = new Set((Array.isArray(columns) ? columns : []).map((row) => row.COLUMN_NAME));

      if (!existing.has('memory_engine_enabled')) {
        await db.query('ALTER TABLE agents ADD COLUMN memory_engine_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER goals');
      }
      if (!existing.has('memory_scope')) {
        await db.query("ALTER TABLE agents ADD COLUMN memory_scope ENUM('shared', 'dedicated') NOT NULL DEFAULT 'shared' AFTER memory_engine_enabled");
      }
    },
  },
  {
    id: '20260502_001_agent_improve_memories_flag',
    description: 'Add per-agent Improve memories flag for afterMemory.',
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
