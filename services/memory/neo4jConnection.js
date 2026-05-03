function loadNeo4jDriver() {
  try {
    return require('neo4j-driver');
  } catch (error) {
    const missing = new Error('Driver neo4j-driver non installato. Esegui npm install per aggiornare le dipendenze.');
    missing.cause = error;
    throw missing;
  }
}

function normalizeConnectionInput(input = {}) {
  return {
    neo4j_url: String(input.neo4j_url || 'bolt://neo4j:7687').trim(),
    neo4j_username: String(input.neo4j_username || 'neo4j').trim(),
    neo4j_password: String(input.neo4j_password || '').trim(),
  };
}

function createNeo4jDriver(input = {}) {
  const config = normalizeConnectionInput(input);
  if (!config.neo4j_url) {
    throw new Error('URL Neo4j obbligatorio.');
  }
  if (!config.neo4j_username) {
    throw new Error('Username Neo4j obbligatorio.');
  }
  if (!config.neo4j_password) {
    throw new Error('Password Neo4j obbligatoria.');
  }

  const neo4j = loadNeo4jDriver();
  return neo4j.driver(
    config.neo4j_url,
    neo4j.auth.basic(config.neo4j_username, config.neo4j_password),
    { connectionTimeout: 5000 }
  );
}

module.exports = {
  createNeo4jDriver,
  loadNeo4jDriver,
  normalizeConnectionInput,
};
