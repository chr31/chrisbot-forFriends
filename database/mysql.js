const mysql = require('mysql2/promise');

// Pool di connessioni MySQL condiviso in tutta l'app
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'chrisbot',
  waitForConnections: true,
  connectionLimit: process.env.MYSQL_CONNECTION_LIMIT ? Number(process.env.MYSQL_CONNECTION_LIMIT) : 10,
  timezone: process.env.MYSQL_TZ || 'Z',
  dateStrings: true,
});

module.exports = pool;
