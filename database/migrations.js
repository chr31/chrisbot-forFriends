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
