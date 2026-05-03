const { Neo4jMemoryRepository } = require('./neo4jMemoryRepository');

function createMemoryRepository(settings = {}) {
  return new Neo4jMemoryRepository(settings);
}

module.exports = {
  createMemoryRepository,
};
