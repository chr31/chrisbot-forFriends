const pool = require('./mysql');

async function initAppSettingsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      setting_key VARCHAR(128) NOT NULL PRIMARY KEY,
      value_json JSON NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function getSetting(settingKey) {
  const [rows] = await pool.query(
    'SELECT value_json, updated_at FROM app_settings WHERE setting_key = ? LIMIT 1',
    [String(settingKey || '').trim()]
  );
  const row = rows?.[0];
  if (!row) return null;
  return {
    setting_key: String(settingKey || '').trim(),
    value_json: row.value_json && typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json,
    updated_at: row.updated_at,
  };
}

async function setSetting(settingKey, value) {
  await pool.query(
    `INSERT INTO app_settings (setting_key, value_json)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE value_json = VALUES(value_json)`,
    [String(settingKey || '').trim(), JSON.stringify(value ?? {})]
  );
  return getSetting(settingKey);
}

async function getAllSettings() {
  const [rows] = await pool.query('SELECT setting_key, value_json, updated_at FROM app_settings ORDER BY setting_key ASC');
  return Array.isArray(rows)
    ? rows.map((row) => ({
        setting_key: row.setting_key,
        value_json: row.value_json && typeof row.value_json === 'string' ? JSON.parse(row.value_json) : row.value_json,
        updated_at: row.updated_at,
      }))
    : [];
}

module.exports = {
  initAppSettingsTable,
  getSetting,
  setSetting,
  getAllSettings,
};
