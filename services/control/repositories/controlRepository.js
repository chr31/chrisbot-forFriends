const { Neo4jControlRepository } = require('./neo4jControlRepository');

function createControlRepository(config = {}) {
  return new Neo4jControlRepository(config);
}

module.exports = {
  createControlRepository,
};
