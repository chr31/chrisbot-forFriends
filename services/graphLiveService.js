const { getMemoryEngineSettingsSync } = require('./appSettings');
const { createNeo4jDriver, loadNeo4jDriver } = require('./memory/neo4jConnection');
const { CONTROL_GRAPH_ID } = require('./control/controlSchema');

const EMBEDDING_KEYS = new Set(['embedding', 'vector']);

function normalizeLimit(value) {
  const numeric = Number(value || 600);
  if (!Number.isFinite(numeric) || numeric <= 0) return 600;
  return Math.min(Math.trunc(numeric), 1500);
}

function serializeValue(value) {
  if (value == null) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value.toNumber === 'function') return value.toNumber();
  if (Array.isArray(value)) return value.slice(0, 80).map(serializeValue);
  if (typeof value.toString === 'function' && value.constructor?.name && value.constructor.name !== 'Object') {
    return value.toString();
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = serializeValue(entry);
    }
    return output;
  }
  return String(value);
}

function serializeProperties(properties = {}) {
  const output = {};
  for (const [key, value] of Object.entries(properties || {})) {
    if (EMBEDDING_KEYS.has(key)) {
      output[`${key}_dimensions`] = Array.isArray(value) ? value.length : 0;
      continue;
    }
    output[key] = serializeValue(value);
  }
  return output;
}

function getNodeTitle(labels = [], properties = {}) {
  return String(
    properties.name
      || properties.label
      || properties.summary
      || properties.topic
      || properties.key
      || properties.id
      || labels[0]
      || 'Nodo'
  );
}

function getNodeKind(labels = [], properties = {}) {
  return String(properties.kind || properties.memory_type || labels.find((label) => label !== 'MemoryLocation') || labels[0] || 'Node');
}

function serializeNode(node) {
  const properties = serializeProperties(node?.properties || {});
  const labels = Array.isArray(node?.labels) ? node.labels : [];
  const elementId = String(node?.elementId || node?.identity?.toString?.() || properties.id || Math.random());
  return {
    id: `node:${elementId}`,
    element_id: elementId,
    labels,
    title: getNodeTitle(labels, properties),
    kind: getNodeKind(labels, properties),
    properties,
  };
}

function serializeRelationship(relationship, nodeIdByElementId) {
  if (!relationship) return null;
  const startElementId = String(relationship.startNodeElementId || relationship.start?.toString?.() || '');
  const endElementId = String(relationship.endNodeElementId || relationship.end?.toString?.() || '');
  const source = nodeIdByElementId.get(startElementId);
  const target = nodeIdByElementId.get(endElementId);
  if (!source || !target) return null;
  const elementId = String(relationship.elementId || relationship.identity?.toString?.() || `${source}:${relationship.type}:${target}`);
  return {
    id: `rel:${elementId}`,
    element_id: elementId,
    source,
    target,
    type: relationship.type || 'RELATED',
    properties: serializeProperties(relationship.properties || {}),
  };
}

async function runGraphQuery(engine, limit) {
  const config = getMemoryEngineSettingsSync();
  const driver = createNeo4jDriver(config);
  const neo4j = loadNeo4jDriver();
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const params = { limit: neo4j.int(limit), graphId: CONTROL_GRAPH_ID };
    const query = engine === 'control'
      ? `
        MATCH (g:EngineGraph {id: $graphId})
        OPTIONAL MATCH (g)-[:OWNS]->(owned)
        WITH g, collect(owned) AS owned
        WITH [g] + owned AS allNodes
        UNWIND allNodes AS n
        WITH n LIMIT $limit
        WITH collect(n) AS nodes
        OPTIONAL MATCH (a)-[r]-(b)
        WHERE a IN nodes AND b IN nodes
        RETURN nodes, collect(DISTINCT r) AS relationships
        `
      : `
        MATCH (n)
        WHERE any(label IN labels(n) WHERE label STARTS WITH 'Memory')
        WITH n LIMIT $limit
        WITH collect(n) AS nodes
        OPTIONAL MATCH (a)-[r]-(b)
        WHERE a IN nodes AND b IN nodes
        RETURN nodes, collect(DISTINCT r) AS relationships
        `;
    const result = await session.run(query, params);
    const record = result.records[0];
    return {
      rawNodes: (record?.get('nodes') || []).filter(Boolean),
      rawRelationships: (record?.get('relationships') || []).filter(Boolean),
    };
  } finally {
    await session.close();
    await driver.close();
  }
}

async function getLiveGraphSnapshot({ engine = 'memory', limit = 600 } = {}) {
  const graphEngine = String(engine || '').toLowerCase() === 'control' ? 'control' : 'memory';
  const numericLimit = normalizeLimit(limit);
  const { rawNodes, rawRelationships } = await runGraphQuery(graphEngine, numericLimit);
  const nodes = rawNodes.map(serializeNode);
  const nodeIdByElementId = new Map(nodes.map((node) => [node.element_id, node.id]));
  const links = rawRelationships
    .map((relationship) => serializeRelationship(relationship, nodeIdByElementId))
    .filter(Boolean);

  return {
    engine: graphEngine,
    refreshed_at: new Date().toISOString(),
    node_count: nodes.length,
    link_count: links.length,
    nodes,
    links,
  };
}

module.exports = {
  getLiveGraphSnapshot,
};
