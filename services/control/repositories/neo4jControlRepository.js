const { createNeo4jDriver, loadNeo4jDriver, normalizeConnectionInput } = require('../../memory/neo4jConnection');
const {
  CONTROL_GRAPH_ID,
  CONTROL_GRAPH_KEY,
  buildControlId,
  normalizeActionType,
  normalizeIntent,
  normalizeKey,
  normalizeList,
  normalizeRiskLevel,
  normalizeText,
  parseBoolean,
} = require('../controlSchema');

const schemaCache = new Set();
const SEARCH_ACTION_TYPES = new Set(['bash', 'telnet', 'telnet_auth', 'ping']);
const SEARCH_INTENTS = new Set(['control', 'monitoring']);
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'status', 'check', 'controllare', 'controlla',
  'verifica', 'verificare', 'stato', 'online', 'college', 'edificio', 'building',
]);

const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT control_engine_graph_id IF NOT EXISTS FOR (n:EngineGraph) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_building_id IF NOT EXISTS FOR (n:ControlBuilding) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_room_id IF NOT EXISTS FOR (n:ControlRoom) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_device_id IF NOT EXISTS FOR (n:ControlDevice) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_action_id IF NOT EXISTS FOR (n:ControlAction) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_action_run_id IF NOT EXISTS FOR (n:ControlActionRun) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX control_building_key IF NOT EXISTS FOR (n:ControlBuilding) ON (n.normalized_name)',
  'CREATE INDEX control_room_key IF NOT EXISTS FOR (n:ControlRoom) ON (n.normalized_name)',
  'CREATE INDEX control_device_type IF NOT EXISTS FOR (n:ControlDevice) ON (n.device_type)',
  'CREATE INDEX control_device_ip IF NOT EXISTS FOR (n:ControlDevice) ON (n.ip)',
  'CREATE INDEX control_action_intent IF NOT EXISTS FOR (n:ControlAction) ON (n.intent)',
  'CREATE INDEX control_action_type IF NOT EXISTS FOR (n:ControlAction) ON (n.action_type)',
];

function getSessionAccessMode(mode) {
  const neo4j = loadNeo4jDriver();
  return mode === 'read' ? neo4j.session.READ : neo4j.session.WRITE;
}

function mapNodeProperties(node) {
  const props = node?.properties || node || {};
  const mapped = {};
  for (const [key, value] of Object.entries(props)) {
    mapped[key] = value && typeof value.toNumber === 'function' ? value.toNumber() : value;
  }
  return mapped;
}

function buildConnectionCacheKey(config) {
  return [config.neo4j_url, config.neo4j_username].join('|');
}

function buildAliasesSearchClause(aliasParam) {
  return `(
    $${aliasParam} IS NULL
    OR toLower(n.name) CONTAINS $${aliasParam}
    OR any(alias IN coalesce(n.aliases, []) WHERE toLower(alias) CONTAINS $${aliasParam})
  )`;
}

function normalizeOptionalSearchEnum(value, allowedValues) {
  const normalized = normalizeText(value, 80).toLowerCase();
  return allowedValues.has(normalized) ? normalized : null;
}

function buildQueryTokens(value) {
  const normalized = normalizeText(value, 600)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, ' ');
  const seen = new Set();
  const tokens = [];
  for (const token of normalized.split(/[^a-z0-9_]+/)) {
    if (token.length < 3 || QUERY_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 8) break;
  }
  return tokens;
}

function normalizeBuilding(input = {}) {
  const name = normalizeText(input.name || input.building || input.building_name, 180);
  if (!name) return null;
  return {
    id: buildControlId('building', { ...input, name }),
    name,
    normalized_name: normalizeKey(input.normalized_name || name),
    aliases: normalizeList(input.aliases),
  };
}

function normalizeRoom(input = {}) {
  const name = normalizeText(input.name || input.room || input.room_name, 180);
  if (!name) return null;
  return {
    id: buildControlId('room', { ...input, name }),
    name,
    normalized_name: normalizeKey(input.normalized_name || name),
    aliases: normalizeList(input.aliases),
  };
}

function normalizeDevice(input = {}) {
  const name = normalizeText(input.name || input.device || input.device_name, 180);
  if (!name) return null;
  return {
    id: buildControlId('device', { ...input, name }),
    name,
    normalized_name: normalizeKey(input.normalized_name || name),
    aliases: normalizeList(input.aliases),
    ip: normalizeText(input.ip, 80) || null,
    mac_address: normalizeText(input.mac_address || input.macAddress, 80) || null,
    manufacturer: normalizeText(input.manufacturer, 120) || null,
    model: normalizeText(input.model, 120) || null,
    device_type: normalizeKey(input.device_type || input.type || 'generic') || 'generic',
    tags: normalizeList(input.tags),
    enabled: parseBoolean(input.enabled, true),
  };
}

function normalizeAction(input = {}) {
  const name = normalizeText(input.name || input.action || input.action_name, 180);
  if (!name) return null;
  return {
    id: buildControlId('action', { ...input, name }),
    name,
    normalized_name: normalizeKey(input.normalized_name || name),
    aliases: normalizeList(input.aliases),
    description: normalizeText(input.description, 800) || null,
    intent: normalizeIntent(input.intent),
    action_type: normalizeActionType(input.action_type || input.type),
    command: normalizeText(input.command, 4000) || null,
    args_schema_json: input.args_schema_json && typeof input.args_schema_json === 'object'
      ? JSON.stringify(input.args_schema_json)
      : normalizeText(input.args_schema_json, 4000) || null,
    credentials_ref: normalizeText(input.credentials_ref, 255) || null,
    risk_level: normalizeRiskLevel(input.risk_level),
    requires_confirmation: parseBoolean(input.requires_confirmation, false),
    enabled: parseBoolean(input.enabled, true),
  };
}

class Neo4jControlRepository {
  constructor(config = {}) {
    this.config = normalizeConnectionInput(config);
  }

  async withSession(mode, fn) {
    const driver = createNeo4jDriver(this.config);
    const session = driver.session({ defaultAccessMode: getSessionAccessMode(mode) });
    try {
      if (mode !== 'read') {
        await this.ensureSchema(session);
      }
      return await fn(session);
    } finally {
      await session.close();
      await driver.close();
    }
  }

  async ensureSchema(session) {
    const cacheKey = buildConnectionCacheKey(this.config);
    if (schemaCache.has(cacheKey)) return;
    for (const statement of SCHEMA_STATEMENTS) {
      await session.run(statement);
    }
    await session.run(
      `
      MERGE (g:EngineGraph {id: $id})
      ON CREATE SET g.created_at = datetime()
      SET g.name = 'Control Engine', g.graph_key = $graphKey, g.updated_at = datetime()
      `,
      { id: CONTROL_GRAPH_ID, graphKey: CONTROL_GRAPH_KEY }
    );
    schemaCache.add(cacheKey);
  }

  async ensureReady() {
    return this.withSession('write', async () => ({ ok: true, schema: 'ready', graph_id: CONTROL_GRAPH_ID }));
  }

  async clearAllControlData() {
    return this.withSession('write', async (session) => {
      const result = await session.run(
        `
        MATCH (:EngineGraph {id: $graphId})-[:OWNS]->(n)
        WITH collect(n) AS nodes, count(n) AS deleted
        FOREACH (node IN nodes | DETACH DELETE node)
        RETURN deleted
        `,
        { graphId: CONTROL_GRAPH_ID }
      );
      const deleted = result.records[0]?.get('deleted');
      return { deleted: deleted && typeof deleted.toNumber === 'function' ? deleted.toNumber() : Number(deleted || 0) };
    });
  }

  async upsertSchema(input = {}) {
    return this.withSession('write', async (session) => {
      const created = { buildings: [], rooms: [], devices: [], actions: [], relations: [] };
      const building = normalizeBuilding(input.building || input.building_node || input);
      const rooms = [
        ...(Array.isArray(input.rooms) ? input.rooms : []),
        ...(input.room || input.room_node ? [input.room || input.room_node] : []),
      ].map(normalizeRoom).filter(Boolean);
      const devices = [
        ...(Array.isArray(input.devices) ? input.devices : []),
        ...(input.device || input.device_node ? [input.device || input.device_node] : []),
      ].map(normalizeDevice).filter(Boolean);
      const actions = [
        ...(Array.isArray(input.actions) ? input.actions : []),
        ...(input.action || input.action_node ? [input.action || input.action_node] : []),
      ].map(normalizeAction).filter(Boolean);

      if (building) {
        await session.run(
          `
          MATCH (g:EngineGraph {id: $graphId})
          MERGE (n:ControlBuilding {id: $nodeId})
          ON CREATE SET n.created_at = datetime()
          SET n += $node, n.updated_at = datetime()
          MERGE (g)-[:OWNS]->(n)
          `,
          { graphId: CONTROL_GRAPH_ID, nodeId: building.id, node: building }
        );
        created.buildings.push(building);
      }

      for (const room of rooms) {
        await session.run(
          `
          MATCH (g:EngineGraph {id: $graphId})
          MERGE (n:ControlRoom {id: $nodeId})
          ON CREATE SET n.created_at = datetime()
          SET n += $node, n.updated_at = datetime()
          MERGE (g)-[:OWNS]->(n)
          `,
          { graphId: CONTROL_GRAPH_ID, nodeId: room.id, node: room }
        );
        created.rooms.push(room);
      }

      for (const device of devices) {
        await session.run(
          `
          MATCH (g:EngineGraph {id: $graphId})
          MERGE (n:ControlDevice {id: $nodeId})
          ON CREATE SET n.created_at = datetime()
          SET n += $node, n.updated_at = datetime()
          MERGE (g)-[:OWNS]->(n)
          `,
          { graphId: CONTROL_GRAPH_ID, nodeId: device.id, node: device }
        );
        created.devices.push(device);
      }

      for (const action of actions) {
        await session.run(
          `
          MATCH (g:EngineGraph {id: $graphId})
          MERGE (n:ControlAction {id: $nodeId})
          ON CREATE SET n.created_at = datetime()
          SET n += $node, n.updated_at = datetime()
          MERGE (g)-[:OWNS]->(n)
          `,
          { graphId: CONTROL_GRAPH_ID, nodeId: action.id, node: action }
        );
        created.actions.push(action);
      }

      for (const room of rooms) {
        if (!building) continue;
        await session.run(
          'MATCH (b:ControlBuilding {id: $buildingId}), (r:ControlRoom {id: $roomId}) MERGE (b)-[:HAS_ROOM]->(r)',
          { buildingId: building.id, roomId: room.id }
        );
        created.relations.push({ from: building.id, type: 'HAS_ROOM', to: room.id });
      }
      for (const device of devices) {
        if (building) {
          await session.run(
            'MATCH (b:ControlBuilding {id: $buildingId}), (d:ControlDevice {id: $deviceId}) MERGE (b)-[:HAS_DEVICE]->(d)',
            { buildingId: building.id, deviceId: device.id }
          );
          created.relations.push({ from: building.id, type: 'HAS_DEVICE', to: device.id });
        }
        for (const room of rooms) {
          await session.run(
            'MATCH (r:ControlRoom {id: $roomId}), (d:ControlDevice {id: $deviceId}) MERGE (r)-[:HAS_DEVICE]->(d)',
            { roomId: room.id, deviceId: device.id }
          );
          created.relations.push({ from: room.id, type: 'HAS_DEVICE', to: device.id });
        }
        for (const action of actions) {
          await session.run(
            'MATCH (d:ControlDevice {id: $deviceId}), (a:ControlAction {id: $actionId}) MERGE (d)-[:CAN_EXECUTE]->(a)',
            { deviceId: device.id, actionId: action.id }
          );
          created.relations.push({ from: device.id, type: 'CAN_EXECUTE', to: action.id });
        }
      }

      return created;
    });
  }

  async search(input = {}) {
    const query = normalizeText(input.query, 600).toLowerCase();
    const queryTokens = buildQueryTokens(query);
    const building = normalizeText(input.building, 120).toLowerCase() || null;
    const room = normalizeText(input.room, 120).toLowerCase() || null;
    const deviceType = normalizeKey(input.device_type || input.deviceType) || null;
    const intent = normalizeOptionalSearchEnum(input.intent, SEARCH_INTENTS);
    const actionType = normalizeOptionalSearchEnum(input.action_type, SEARCH_ACTION_TYPES);
    const limit = Math.min(Math.max(Number.parseInt(String(input.limit || 30), 10) || 30, 1), 100);

    return this.withSession('read', async (session) => {
      const neo4j = loadNeo4jDriver();
      const result = await session.run(
        `
        MATCH (:EngineGraph {id: $graphId})-[:OWNS]->(d:ControlDevice)
        OPTIONAL MATCH (b:ControlBuilding)-[:HAS_DEVICE]->(d)
        OPTIONAL MATCH (b2:ControlBuilding)-[:HAS_ROOM]->(r:ControlRoom)-[:HAS_DEVICE]->(d)
        WITH d, coalesce(b, b2) AS building, r
        WHERE d.enabled <> false
          AND ($deviceType IS NULL OR d.device_type = $deviceType OR $deviceType IN coalesce(d.tags, []))
          AND (
            $query = ''
            OR toLower(d.name) CONTAINS $query
            OR any(alias IN coalesce(d.aliases, []) WHERE toLower(alias) CONTAINS $query)
            OR any(tag IN coalesce(d.tags, []) WHERE toLower(tag) CONTAINS $query)
            OR any(token IN $queryTokens WHERE toLower(d.name) CONTAINS token OR d.device_type CONTAINS token OR any(alias IN coalesce(d.aliases, []) WHERE toLower(alias) CONTAINS token) OR any(tag IN coalesce(d.tags, []) WHERE toLower(tag) CONTAINS token))
          )
          AND ($building IS NULL OR (building IS NOT NULL AND (toLower(building.name) CONTAINS $building OR any(alias IN coalesce(building.aliases, []) WHERE toLower(alias) CONTAINS $building))))
          AND ($room IS NULL OR (r IS NOT NULL AND (toLower(r.name) CONTAINS $room OR any(alias IN coalesce(r.aliases, []) WHERE toLower(alias) CONTAINS $room))))
        MATCH (d)-[:CAN_EXECUTE]->(a:ControlAction)
        WHERE a.enabled <> false
          AND ($intent IS NULL OR a.intent = $intent)
          AND ($actionType IS NULL OR a.action_type = $actionType)
          AND (
            $query = ''
            OR toLower(a.name) CONTAINS $query
            OR toLower(coalesce(a.description, '')) CONTAINS $query
            OR any(alias IN coalesce(a.aliases, []) WHERE toLower(alias) CONTAINS $query)
            OR toLower(d.name) CONTAINS $query
            OR any(token IN $queryTokens WHERE toLower(a.name) CONTAINS token OR toLower(coalesce(a.description, '')) CONTAINS token OR a.action_type CONTAINS token OR a.intent CONTAINS token OR toLower(d.name) CONTAINS token OR d.device_type CONTAINS token OR any(alias IN coalesce(a.aliases, []) WHERE toLower(alias) CONTAINS token))
          )
        RETURN d, a, building, r
        LIMIT $limit
        `,
        { graphId: CONTROL_GRAPH_ID, query, queryTokens, building, room, deviceType, intent, actionType, limit: neo4j.int(limit) }
      );
      return result.records.map((record) => ({
        device: mapNodeProperties(record.get('d')),
        action: mapNodeProperties(record.get('a')),
        building: mapNodeProperties(record.get('building')),
        room: mapNodeProperties(record.get('r')),
      }));
    });
  }

  async listLocations(input = {}) {
    const query = normalizeText(input.query, 600).toLowerCase();
    const building = normalizeText(input.building, 120).toLowerCase() || null;
    const room = normalizeText(input.room, 120).toLowerCase() || null;
    const limit = Math.min(Math.max(Number.parseInt(String(input.limit || 50), 10) || 50, 1), 200);

    return this.withSession('read', async (session) => {
      const neo4j = loadNeo4jDriver();
      const result = await session.run(
        `
        MATCH (:EngineGraph {id: $graphId})-[:OWNS]->(b:ControlBuilding)
        WHERE (
          $building IS NULL
          OR toLower(b.name) CONTAINS $building
          OR any(alias IN coalesce(b.aliases, []) WHERE toLower(alias) CONTAINS $building)
        )
        AND (
          $query = ''
          OR $query CONTAINS toLower(b.name)
          OR toLower(b.name) CONTAINS $query
          OR any(alias IN coalesce(b.aliases, []) WHERE $query CONTAINS toLower(alias) OR toLower(alias) CONTAINS $query)
          OR $query CONTAINS 'sala'
          OR $query CONTAINS 'sale'
          OR $query CONTAINS 'stanza'
          OR $query CONTAINS 'stanze'
          OR $query CONTAINS 'room'
          OR $query CONTAINS 'aula'
        )
        OPTIONAL MATCH (b)-[:HAS_ROOM]->(r:ControlRoom)
        WHERE (
          $room IS NULL
          OR r IS NULL
          OR toLower(r.name) CONTAINS $room
          OR any(alias IN coalesce(r.aliases, []) WHERE toLower(alias) CONTAINS $room)
        )
        RETURN b, collect(r)[0..$limit] AS rooms
        LIMIT $limit
        `,
        { graphId: CONTROL_GRAPH_ID, query, building, room, limit: neo4j.int(limit) }
      );
      return result.records.map((record) => ({
        building: mapNodeProperties(record.get('b')),
        rooms: (record.get('rooms') || []).filter(Boolean).map(mapNodeProperties),
      }));
    });
  }

  async getActionTargets(targets = []) {
    const normalizedTargets = (Array.isArray(targets) ? targets : [])
      .flatMap((target) => {
        const source = target?.execute_target && typeof target.execute_target === 'object'
          ? target.execute_target
          : target;
        return [{
          device_id: normalizeText(source?.device_id || source?.deviceId || source?.device?.id, 240),
          action_id: normalizeText(source?.action_id || source?.actionId || source?.action?.id, 240),
        }];
      })
      .filter((target) => target.device_id && target.action_id);
    if (normalizedTargets.length === 0) return [];

    return this.withSession('read', async (session) => {
      const result = await session.run(
        `
        UNWIND $targets AS target
        MATCH (:EngineGraph {id: $graphId})-[:OWNS]->(d:ControlDevice {id: target.device_id})
        MATCH (d)-[:CAN_EXECUTE]->(a:ControlAction {id: target.action_id})
        WHERE d.enabled <> false AND a.enabled <> false
        OPTIONAL MATCH (b:ControlBuilding)-[:HAS_DEVICE]->(d)
        OPTIONAL MATCH (b2:ControlBuilding)-[:HAS_ROOM]->(r:ControlRoom)-[:HAS_DEVICE]->(d)
        RETURN d, a, coalesce(b, b2) AS building, r
        `,
        { graphId: CONTROL_GRAPH_ID, targets: normalizedTargets }
      );
      return result.records.map((record) => ({
        device: mapNodeProperties(record.get('d')),
        action: mapNodeProperties(record.get('a')),
        building: mapNodeProperties(record.get('building')),
        room: mapNodeProperties(record.get('r')),
      }));
    });
  }

  async saveActionRun(input = {}) {
    const run = {
      id: buildControlId('action_run', { id: input.id }),
      requested_by_agent_id: normalizeText(input.requested_by_agent_id, 80) || null,
      requested_by_user: normalizeText(input.requested_by_user, 255) || null,
      query: normalizeText(input.query, 1000) || null,
      status: normalizeText(input.status, 80) || 'unknown',
      dry_run: parseBoolean(input.dry_run, false),
      output_json: JSON.stringify(input.output || {}),
    };
    return this.withSession('write', async (session) => {
      await session.run(
        `
        MATCH (g:EngineGraph {id: $graphId})
        MERGE (n:ControlActionRun {id: $runId})
        ON CREATE SET n.created_at = datetime(), n.started_at = datetime()
        SET n += $run, n.finished_at = datetime(), n.updated_at = datetime()
        MERGE (g)-[:OWNS]->(n)
        WITH n
        UNWIND $targets AS target
        OPTIONAL MATCH (d:ControlDevice {id: target.device_id})
        OPTIONAL MATCH (a:ControlAction {id: target.action_id})
        FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END | MERGE (n)-[:TARGET_DEVICE]->(d))
        FOREACH (_ IN CASE WHEN a IS NULL THEN [] ELSE [1] END | MERGE (n)-[:EXECUTED_ACTION]->(a))
        `,
        { graphId: CONTROL_GRAPH_ID, runId: run.id, run, targets: input.targets || [] }
      );
      return run;
    });
  }
}

module.exports = {
  Neo4jControlRepository,
  normalizeAction,
  normalizeBuilding,
  normalizeDevice,
  normalizeRoom,
};
