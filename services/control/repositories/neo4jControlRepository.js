const { createNeo4jDriver, loadNeo4jDriver, normalizeConnectionInput } = require('../../memory/neo4jConnection');
const { embedTexts } = require('../../memory/memoryEmbedding');
const {
  ACTION_TYPES,
  CONTROL_GRAPH_ID,
  CONTROL_GRAPH_KEY,
  buildCanonicalKey,
  buildControlId,
  normalizeActionType,
  normalizeIntent,
  normalizeKey,
  normalizeList,
  normalizeLocationKind,
  normalizeRiskLevel,
  normalizeText,
  parseBoolean,
} = require('../controlSchema');

const schemaCache = new Set();
const SEARCH_ACTION_TYPES = ACTION_TYPES;
const SEARCH_INTENTS = new Set(['control', 'monitoring']);
const EMBEDDING_ALIGNMENT_THRESHOLD = 0.91;
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'with', 'for', 'status', 'check', 'controllare', 'controlla',
  'verifica', 'verificare', 'stato', 'online', 'edificio', 'building',
]);

const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT control_engine_graph_id IF NOT EXISTS FOR (n:EngineGraph) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_location_id IF NOT EXISTS FOR (n:ControlLocation) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_building_id IF NOT EXISTS FOR (n:ControlBuilding) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_room_id IF NOT EXISTS FOR (n:ControlRoom) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_device_id IF NOT EXISTS FOR (n:ControlDevice) REQUIRE n.id IS UNIQUE',
  'CREATE CONSTRAINT control_device_type_key IF NOT EXISTS FOR (n:ControlDeviceType) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT control_capability_key IF NOT EXISTS FOR (n:ControlCapability) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT control_adapter_key IF NOT EXISTS FOR (n:ControlCommandAdapter) REQUIRE n.key IS UNIQUE',
  'CREATE CONSTRAINT control_action_id IF NOT EXISTS FOR (n:ControlAction) REQUIRE n.id IS UNIQUE',
  'CREATE INDEX control_location_key IF NOT EXISTS FOR (n:ControlLocation) ON (n.canonical_key)',
  'CREATE INDEX control_location_kind IF NOT EXISTS FOR (n:ControlLocation) ON (n.kind)',
  'CREATE INDEX control_location_name IF NOT EXISTS FOR (n:ControlLocation) ON (n.normalized_name)',
  'CREATE INDEX control_device_key IF NOT EXISTS FOR (n:ControlDevice) ON (n.canonical_key)',
  'CREATE INDEX control_device_type IF NOT EXISTS FOR (n:ControlDevice) ON (n.device_type)',
  'CREATE INDEX control_device_ip IF NOT EXISTS FOR (n:ControlDevice) ON (n.ip)',
  'CREATE INDEX control_action_key IF NOT EXISTS FOR (n:ControlAction) ON (n.action_key)',
  'CREATE INDEX control_action_intent IF NOT EXISTS FOR (n:ControlAction) ON (n.intent)',
  'CREATE INDEX control_action_type IF NOT EXISTS FOR (n:ControlAction) ON (n.action_type)',
  'CREATE INDEX control_action_capability IF NOT EXISTS FOR (n:ControlAction) ON (n.capability_key)',
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

function normalizeOptionalSearchEnum(value, allowedValues) {
  const normalized = normalizeText(value, 80).toLowerCase();
  return allowedValues.has(normalized) ? normalized : null;
}

function uniq(values = [], limit = 32) {
  const seen = new Set();
  const result = [];
  for (const value of values.flat()) {
    const item = normalizeText(value, 160);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
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
    if (tokens.length >= 10) break;
  }
  return tokens;
}

function inferCapabilityKey(input = {}) {
  const explicit = normalizeKey(input.capability_key || input.capability || input.capability_name);
  if (explicit) return explicit;
  const text = normalizeText([
    input.action_key,
    input.name,
    input.action,
    input.description,
    input.intent,
    input.command,
  ].filter(Boolean).join(' '), 800).toLowerCase();
  if (/\b(ping|online|status|stato|monitor|check|health)\b/.test(text)) return 'status_online';
  if (/\b(power|accendi|turn on|on)\b/.test(text)) return 'power_on';
  if (/\b(spegni|turn off|off)\b/.test(text)) return 'power_off';
  if (/\b(audio|volume|mute|level|livello)\b/.test(text)) return 'audio_value';
  if (/\b(input|source|sorgente)\b/.test(text)) return 'input_select';
  return normalizeKey(input.name || input.action || 'generic_action') || 'generic_action';
}

function buildLocationPath({ building, floor, room, zone, name, kind }) {
  return uniq([building, floor, room, zone, kind === 'building' ? name : null, kind === 'room' ? name : null], 8)
    .map((entry) => normalizeKey(entry))
    .filter(Boolean)
    .join('/');
}

function normalizeLocation(input = {}, fallbackKind = 'location', parentRef = null) {
  if (typeof input === 'string') input = { name: input };
  const kind = normalizeLocationKind(input.kind || input.location_kind || input.location_type || input.type || fallbackKind);
  const name = normalizeText(
    input.name || input.location || input.location_name || input.building || input.building_name || input.room || input.room_name,
    180
  );
  if (!name) return null;
  const path = normalizeText(input.path || input.location_path || buildLocationPath({
    building: input.building || input.building_name,
    floor: input.floor || input.floor_name,
    room: input.room || input.room_name,
    zone: input.zone || input.zone_name,
    name,
    kind,
  }), 320) || normalizeKey(name);
  const canonicalKey = buildCanonicalKey('location', { kind, name, path });
  const idKind = kind === 'building' ? 'building' : kind === 'room' ? 'room' : 'location';
  const node = {
    id: buildControlId(idKind, { ...input, name, path, kind }),
    name,
    normalized_name: normalizeKey(input.normalized_name || name),
    kind,
    path,
    canonical_key: canonicalKey,
    aliases: uniq([normalizeList(input.aliases), input.alias, name, input.room, input.building]),
    enabled: parseBoolean(input.enabled, true),
  };
  node.alignment_text = normalizeText([
    'location',
    node.kind,
    node.name,
    node.path,
    node.aliases.join(' '),
  ].join(' '), 1000);
  return {
    node,
    parent_ref: normalizeText(input.parent_id || input.parent_ref || input.parent || parentRef || '', 240) || null,
  };
}

function normalizeBuilding(input = {}) {
  const normalized = normalizeLocation(input, 'building');
  return normalized?.node || null;
}

function normalizeRoom(input = {}) {
  const normalized = normalizeLocation(input, 'room');
  return normalized?.node || null;
}

function normalizeDeviceType(value) {
  const key = normalizeKey(value || 'generic') || 'generic';
  return {
    key,
    name: normalizeText(value || key, 120) || key,
    aliases: uniq([value, key]),
  };
}

function normalizeCapability(input = {}) {
  const key = normalizeKey(input.key || input.capability_key || input.capability || input.name);
  if (!key) return null;
  const node = {
    key,
    name: normalizeText(input.name || input.capability || key, 160) || key,
    aliases: uniq([normalizeList(input.aliases), input.alias, input.name, input.capability, key]),
    description: normalizeText(input.description, 600) || null,
  };
  node.alignment_text = normalizeText(['capability', node.key, node.name, node.aliases.join(' '), node.description].join(' '), 1000);
  return node;
}

function normalizeAdapter(value) {
  const key = normalizeActionType(value || 'bash');
  return {
    key,
    name: key,
    aliases: uniq([key, value]),
  };
}

function normalizeDevice(input = {}) {
  if (typeof input === 'string') input = { name: input };
  const name = normalizeText(input.name || input.device || input.device_name, 180);
  if (!name) return null;
  const deviceType = normalizeKey(input.device_type || input.type || 'generic') || 'generic';
  const locationRef = normalizeText(
    input.location_id || input.location_ref || input.location || input.room_id || input.room || input.building_id || input.building || '',
    240
  ) || null;
  const canonicalKey = buildCanonicalKey('device', {
    name,
    device_type: deviceType,
    path: input.location_path || input.path || locationRef,
    ip: input.ip,
    mac_address: input.mac_address || input.macAddress,
  });
  const node = {
    id: buildControlId('device', { ...input, name, device_type: deviceType }),
    name,
    normalized_name: normalizeKey(input.normalized_name || name),
    canonical_key: canonicalKey,
    aliases: uniq([normalizeList(input.aliases), input.alias, name, input.device_type, input.type]),
    ip: normalizeText(input.ip, 80) || null,
    mac_address: normalizeText(input.mac_address || input.macAddress, 80) || null,
    manufacturer: normalizeText(input.manufacturer, 120) || null,
    model: normalizeText(input.model, 120) || null,
    serial: normalizeText(input.serial || input.serial_number || input.serialNumber, 180) || null,
    device_type: deviceType,
    tags: normalizeList(input.tags),
    enabled: parseBoolean(input.enabled, true),
  };
  node.alignment_text = normalizeText([
    'device',
    node.name,
    node.device_type,
    node.ip,
    node.mac_address,
    node.manufacturer,
    node.model,
    node.serial,
    node.aliases.join(' '),
    locationRef,
  ].filter(Boolean).join(' '), 1400);
  return {
    node,
    location_ref: locationRef,
    capability_keys: uniq([input.capabilities, input.capability_keys]).map(normalizeKey).filter(Boolean),
  };
}

function normalizeAction(input = {}) {
  if (typeof input === 'string') input = { name: input };
  const name = normalizeText(input.name || input.action || input.action_name, 180);
  if (!name) return null;
  const adapterType = normalizeActionType(input.adapter_type || input.action_type || input.type);
  const capabilityKey = inferCapabilityKey(input);
  const actionKey = normalizeKey(input.action_key || input.key || name) || capabilityKey;
  const command = normalizeText(input.command, 4000) || null;
  const canonicalKey = buildCanonicalKey('action', {
    name,
    key: actionKey,
    capability_key: capabilityKey,
    adapter_type: adapterType,
    command,
  });
  const node = {
    id: buildControlId('action', { ...input, name, action_key: actionKey, capability_key: capabilityKey }),
    name,
    normalized_name: normalizeKey(input.normalized_name || name),
    canonical_key: canonicalKey,
    action_key: actionKey,
    capability_key: capabilityKey,
    aliases: uniq([normalizeList(input.aliases), input.alias, name, capabilityKey, actionKey]),
    description: normalizeText(input.description, 800) || null,
    intent: normalizeIntent(input.intent),
    action_type: adapterType,
    adapter_type: adapterType,
    command,
    http_method: normalizeText(input.http_method || input.method, 20).toUpperCase() || null,
    headers_json: input.headers_json && typeof input.headers_json === 'object'
      ? JSON.stringify(input.headers_json)
      : input.headers && typeof input.headers === 'object'
        ? JSON.stringify(input.headers)
        : normalizeText(input.headers_json, 4000) || null,
    body_template: normalizeText(input.body_template || input.body, 4000) || null,
    args_schema_json: input.args_schema_json && typeof input.args_schema_json === 'object'
      ? JSON.stringify(input.args_schema_json)
      : normalizeText(input.args_schema_json, 4000) || null,
    params_schema_json: input.params_schema_json && typeof input.params_schema_json === 'object'
      ? JSON.stringify(input.params_schema_json)
      : normalizeText(input.params_schema_json, 4000) || null,
    credentials_ref: normalizeText(input.credentials_ref, 255) || null,
    risk_level: normalizeRiskLevel(input.risk_level),
    requires_confirmation: parseBoolean(input.requires_confirmation, false),
    enabled: parseBoolean(input.enabled, true),
  };
  node.alignment_text = normalizeText([
    'action',
    node.name,
    node.action_key,
    node.capability_key,
    node.intent,
    node.action_type,
    node.description,
    node.command,
    node.aliases.join(' '),
  ].filter(Boolean).join(' '), 1800);
  return {
    node,
    device_ref: normalizeText(input.device_id || input.device_ref || input.device || '', 240) || null,
  };
}

function collectSchemaInput(input = {}) {
  const locations = [];
  const buildingEntry = input.building || input.building_node;
  const building = buildingEntry ? normalizeLocation(buildingEntry, 'building') : normalizeLocation(input, 'building');
  const hasBuildingInput = Boolean(buildingEntry || input.building || input.building_name);
  const activeBuilding = hasBuildingInput ? building : null;
  if (activeBuilding) locations.push(activeBuilding);

  const roomInputs = [
    ...(Array.isArray(input.rooms) ? input.rooms : []),
    ...(input.room || input.room_node ? [input.room || input.room_node] : []),
  ];
  for (const roomInput of roomInputs) {
    const room = normalizeLocation({
      ...(typeof roomInput === 'object' ? roomInput : { name: roomInput }),
      building: activeBuilding?.node?.name || roomInput?.building,
      path: roomInput?.path || [activeBuilding?.node?.path, roomInput?.name || roomInput?.room].filter(Boolean).join('/'),
    }, 'room', activeBuilding?.node?.id || null);
    if (room) locations.push(room);
  }

  for (const locationInput of [
    ...(Array.isArray(input.locations) ? input.locations : []),
    ...(input.location || input.location_node ? [input.location || input.location_node] : []),
  ]) {
    const location = normalizeLocation(locationInput, locationInput?.kind || 'location', activeBuilding?.node?.id || null);
    if (location) locations.push(location);
  }

  const devices = [
    ...(Array.isArray(input.devices) ? input.devices : []),
    ...(input.device || input.device_node ? [input.device || input.device_node] : []),
  ].map(normalizeDevice).filter(Boolean);
  const actions = [
    ...(Array.isArray(input.actions) ? input.actions : []),
    ...(input.action || input.action_node ? [input.action || input.action_node] : []),
  ].map(normalizeAction).filter(Boolean);
  const explicitCapabilities = [
    ...(Array.isArray(input.capabilities) ? input.capabilities : []),
    ...(input.capability || input.capability_node ? [input.capability || input.capability_node] : []),
  ].map((entry) => normalizeCapability(typeof entry === 'object' ? entry : { key: entry, name: entry })).filter(Boolean);

  return { locations, devices, actions, explicitCapabilities };
}

async function enrichEmbeddings(items = [], settings = {}) {
  const targets = items.filter((item) => item?.alignment_text);
  if (targets.length === 0 || !String(settings.embedding_model_provider || '').trim()) {
    return [];
  }
  try {
    const result = await embedTexts(targets.map((item) => item.alignment_text), settings);
    targets.forEach((item, index) => {
      item.embedding = result.embeddings[index];
      item.embedding_model = result.model;
      item.embedding_provider = result.provider;
    });
    return [];
  } catch (error) {
    return [`Embedding Control Engine non disponibile per allineamento: ${error?.message || error}`];
  }
}

class Neo4jControlRepository {
  constructor(config = {}) {
    this.config = {
      ...config,
      ...normalizeConnectionInput(config),
    };
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

  async findAlignedNode(session, { labels, node, threshold = EMBEDDING_ALIGNMENT_THRESHOLD }) {
    const labelsClause = labels.map((label) => `n:${label}`).join(' OR ');
    const exactResult = await session.run(
      `
      MATCH (n)
      WHERE (${labelsClause})
        AND (
          n.id = $id
          OR ($canonicalKey IS NOT NULL AND n.canonical_key = $canonicalKey)
          OR ($normalizedName IS NOT NULL AND n.normalized_name = $normalizedName AND ($kind IS NULL OR n.kind = $kind))
          OR ($ip IS NOT NULL AND n.ip = $ip)
          OR ($macAddress IS NOT NULL AND n.mac_address = $macAddress)
          OR any(alias IN coalesce(n.aliases, []) WHERE toLower(alias) IN $aliases)
        )
      RETURN n, 1.0 AS score
      LIMIT 1
      `,
      {
        id: node.id,
        canonicalKey: node.canonical_key || null,
        normalizedName: node.normalized_name || null,
        kind: node.kind || null,
        ip: node.ip || null,
        macAddress: node.mac_address || null,
        aliases: (node.aliases || []).map((alias) => String(alias).toLowerCase()),
      }
    );
    const exact = exactResult.records[0]?.get('n');
    if (exact) return { node: mapNodeProperties(exact), score: 1, strategy: 'exact' };

    if (!Array.isArray(node.embedding) || node.embedding.length === 0) return null;
    const embeddingResult = await session.run(
      `
      MATCH (n)
      WHERE (${labelsClause})
        AND n.embedding IS NOT NULL
        AND size(n.embedding) = size($embedding)
        AND ($kind IS NULL OR n.kind = $kind)
      WITH n,
        reduce(dot = 0.0, i IN range(0, size(n.embedding) - 1) | dot + (n.embedding[i] * $embedding[i])) AS dot,
        sqrt(reduce(norm = 0.0, value IN n.embedding | norm + (value * value))) AS nodeNorm,
        sqrt(reduce(norm = 0.0, value IN $embedding | norm + (value * value))) AS queryNorm
      WITH n,
        CASE WHEN nodeNorm = 0.0 OR queryNorm = 0.0 THEN 0.0 ELSE dot / (nodeNorm * queryNorm) END AS score
      WHERE score >= $threshold
      RETURN n, score
      ORDER BY score DESC
      LIMIT 1
      `,
      { embedding: node.embedding, kind: node.kind || null, threshold }
    );
    const record = embeddingResult.records[0];
    return record
      ? { node: mapNodeProperties(record.get('n')), score: Number(record.get('score') || 0), strategy: 'embedding' }
      : null;
  }

  async upsertOwnedNode(session, { labels, node }) {
    const matched = await this.findAlignedNode(session, { labels, node });
    if (matched?.node?.id) {
      node.id = matched.node.id;
      const labelsClause = labels.map((label) => `n:${label}`).join(' OR ');
      await session.run(
        `
        MATCH (n)
        WHERE n.id = $nodeId AND (${labelsClause})
        SET n:${labels[0]}
        `,
        { nodeId: node.id }
      );
    }

    await session.run(
      `
      MATCH (g:EngineGraph {id: $graphId})
      MERGE (n:${labels[0]} {id: $nodeId})
      ON CREATE SET n.created_at = datetime()
      SET n += $node,
        n.aliases = reduce(out = [], entry IN coalesce(n.aliases, []) + $aliases | CASE WHEN entry IN out THEN out ELSE out + entry END),
        n.updated_at = datetime()
      MERGE (g)-[:OWNS]->(n)
      `,
      { graphId: CONTROL_GRAPH_ID, nodeId: node.id, node, aliases: node.aliases || [] }
    );

    if (labels.includes('ControlBuilding')) {
      await session.run('MATCH (n:ControlLocation {id: $id}) SET n:ControlBuilding', { id: node.id });
    }
    if (labels.includes('ControlRoom')) {
      await session.run('MATCH (n:ControlLocation {id: $id}) SET n:ControlRoom', { id: node.id });
    }

    return { ...node, alignment: matched ? { strategy: matched.strategy, score: matched.score } : { strategy: 'created', score: null } };
  }

  async upsertKeyNode(session, { label, keyField = 'key', node }) {
    await session.run(
      `
      MATCH (g:EngineGraph {id: $graphId})
      MERGE (n:${label} {${keyField}: $key})
      ON CREATE SET n.created_at = datetime()
      SET n += $node,
        n.aliases = reduce(out = [], entry IN coalesce(n.aliases, []) + $aliases | CASE WHEN entry IN out THEN out ELSE out + entry END),
        n.updated_at = datetime()
      MERGE (g)-[:OWNS]->(n)
      `,
      { graphId: CONTROL_GRAPH_ID, key: node[keyField], node, aliases: node.aliases || [] }
    );
    return node;
  }

  async linkLocationParent(session, parentId, childId, created) {
    if (!parentId || !childId || parentId === childId) return;
    await session.run(
      `
      MATCH (parent:ControlLocation {id: $parentId}), (child:ControlLocation {id: $childId})
      MERGE (parent)-[:CONTAINS]->(child)
      FOREACH (_ IN CASE WHEN parent.kind = 'building' AND child.kind = 'room' THEN [1] ELSE [] END | MERGE (parent)-[:HAS_ROOM]->(child))
      `,
      { parentId, childId }
    );
    created.relations.push({ from: parentId, type: 'CONTAINS', to: childId });
  }

  async resolveLocationRef(session, ref) {
    const raw = normalizeText(ref, 240);
    if (!raw) return null;
    const key = normalizeKey(raw);
    const result = await session.run(
      `
      MATCH (loc:ControlLocation)
      WHERE loc.id = $raw
        OR loc.canonical_key = $raw
        OR loc.normalized_name = $key
        OR toLower(loc.name) = toLower($raw)
        OR any(alias IN coalesce(loc.aliases, []) WHERE toLower(alias) = toLower($raw))
      RETURN loc.id AS id
      LIMIT 1
      `,
      { raw, key }
    );
    return result.records[0]?.get('id') || null;
  }

  async resolveDeviceRef(session, ref) {
    const raw = normalizeText(ref, 240);
    if (!raw) return null;
    const key = normalizeKey(raw);
    const result = await session.run(
      `
      MATCH (d:ControlDevice)
      WHERE d.id = $raw
        OR d.canonical_key = $raw
        OR d.normalized_name = $key
        OR toLower(d.name) = toLower($raw)
        OR any(alias IN coalesce(d.aliases, []) WHERE toLower(alias) = toLower($raw))
      RETURN d.id AS id
      LIMIT 1
      `,
      { raw, key }
    );
    return result.records[0]?.get('id') || null;
  }

  async upsertSchema(input = {}) {
    const { locations, devices, actions, explicitCapabilities } = collectSchemaInput(input);
    const deviceTypeNodes = devices.map((entry) => normalizeDeviceType(entry.node.device_type));
    const actionCapabilityNodes = actions
      .map((entry) => normalizeCapability({ key: entry.node.capability_key, name: entry.node.capability_key }))
      .filter(Boolean);
    const deviceCapabilityNodes = devices
      .flatMap((entry) => entry.capability_keys)
      .map((key) => normalizeCapability({ key, name: key }))
      .filter(Boolean);
    const adapterNodes = actions.map((entry) => normalizeAdapter(entry.node.adapter_type));
    const warnings = await enrichEmbeddings([
      ...locations.map((entry) => entry.node),
      ...devices.map((entry) => entry.node),
      ...actions.map((entry) => entry.node),
      ...explicitCapabilities,
      ...actionCapabilityNodes,
      ...deviceCapabilityNodes,
    ], this.config);

    return this.withSession('write', async (session) => {
      const created = {
        locations: [],
        buildings: [],
        rooms: [],
        devices: [],
        device_types: [],
        capabilities: [],
        adapters: [],
        actions: [],
        relations: [],
        alignment: [],
        warnings,
      };
      const locationByOriginalId = new Map();

      for (const entry of locations) {
        const labels = ['ControlLocation'];
        if (entry.node.kind === 'building') labels.push('ControlBuilding');
        if (entry.node.kind === 'room') labels.push('ControlRoom');
        const originalId = entry.node.id;
        const saved = await this.upsertOwnedNode(session, { labels, node: entry.node });
        locationByOriginalId.set(originalId, saved.id);
        locationByOriginalId.set(saved.id, saved.id);
        locationByOriginalId.set(saved.name, saved.id);
        locationByOriginalId.set(saved.normalized_name, saved.id);
        created.locations.push(saved);
        if (saved.kind === 'building') created.buildings.push(saved);
        if (saved.kind === 'room') created.rooms.push(saved);
        if (saved.alignment) created.alignment.push({ kind: 'location', id: saved.id, ...saved.alignment });
      }

      for (const entry of locations) {
        const parentId = locationByOriginalId.get(entry.parent_ref) || entry.parent_ref;
        const childId = locationByOriginalId.get(entry.node.id) || entry.node.id;
        await this.linkLocationParent(session, parentId, childId, created);
      }

      for (const deviceType of deviceTypeNodes) {
        await this.upsertKeyNode(session, { label: 'ControlDeviceType', node: deviceType });
        created.device_types.push(deviceType);
      }
      for (const capability of [...explicitCapabilities, ...actionCapabilityNodes, ...deviceCapabilityNodes]) {
        await this.upsertKeyNode(session, { label: 'ControlCapability', node: capability });
        created.capabilities.push(capability);
      }
      for (const adapter of adapterNodes) {
        await this.upsertKeyNode(session, { label: 'ControlCommandAdapter', node: adapter });
        created.adapters.push(adapter);
      }

      const defaultLocationId = [...locationByOriginalId.values()][locations.length - 1] || [...locationByOriginalId.values()][0] || null;
      for (const entry of devices) {
        const originalId = entry.node.id;
        const saved = await this.upsertOwnedNode(session, { labels: ['ControlDevice'], node: entry.node });
        created.devices.push(saved);
        if (saved.alignment) created.alignment.push({ kind: 'device', id: saved.id, ...saved.alignment });
        const locationId = locationByOriginalId.get(entry.location_ref)
          || locationByOriginalId.get(normalizeKey(entry.location_ref))
          || await this.resolveLocationRef(session, entry.location_ref)
          || defaultLocationId;
        if (locationId) {
          await session.run(
            `
            MATCH (loc:ControlLocation {id: $locationId}), (d:ControlDevice {id: $deviceId})
            MERGE (d)-[:INSTALLED_IN]->(loc)
            MERGE (loc)-[:HAS_DEVICE]->(d)
            `,
            { locationId, deviceId: saved.id }
          );
          created.relations.push({ from: locationId, type: 'HAS_DEVICE', to: saved.id });
        }
        await session.run(
          `
          MATCH (d:ControlDevice {id: $deviceId}), (dt:ControlDeviceType {key: $deviceType})
          MERGE (d)-[:IS_A]->(dt)
          `,
          { deviceId: saved.id, deviceType: saved.device_type }
        );
        created.relations.push({ from: saved.id, type: 'IS_A', to: saved.device_type });
        for (const capabilityKey of entry.capability_keys) {
          await session.run(
            `
            MATCH (d:ControlDevice {id: $deviceId}), (c:ControlCapability {key: $capabilityKey})
            MERGE (d)-[:SUPPORTS_CAPABILITY]->(c)
            `,
            { deviceId: saved.id, capabilityKey }
          );
          created.relations.push({ from: saved.id, type: 'SUPPORTS_CAPABILITY', to: capabilityKey });
        }
      }

      const targetDeviceIds = created.devices.map((device) => device.id);
      for (const entry of actions) {
        const saved = await this.upsertOwnedNode(session, { labels: ['ControlAction'], node: entry.node });
        created.actions.push(saved);
        if (saved.alignment) created.alignment.push({ kind: 'action', id: saved.id, ...saved.alignment });
        await session.run(
          `
          MATCH (a:ControlAction {id: $actionId})
          OPTIONAL MATCH (c:ControlCapability {key: $capabilityKey})
          OPTIONAL MATCH (adapter:ControlCommandAdapter {key: $adapterKey})
          FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END | MERGE (a)-[:IMPLEMENTS]->(c))
          FOREACH (_ IN CASE WHEN adapter IS NULL THEN [] ELSE [1] END | MERGE (a)-[:EXECUTES_WITH]->(adapter))
          `,
          { actionId: saved.id, capabilityKey: saved.capability_key, adapterKey: saved.adapter_type }
        );
        created.relations.push({ from: saved.id, type: 'IMPLEMENTS', to: saved.capability_key });
        created.relations.push({ from: saved.id, type: 'EXECUTES_WITH', to: saved.adapter_type });
        const explicitDeviceId = entry.device_ref ? await this.resolveDeviceRef(session, entry.device_ref) : null;
        const linkedDeviceIds = explicitDeviceId
          ? [explicitDeviceId]
          : targetDeviceIds;
        for (const deviceId of linkedDeviceIds) {
          await session.run(
            `
            MATCH (d:ControlDevice {id: $deviceId}), (a:ControlAction {id: $actionId})
            MERGE (d)-[:CAN_EXECUTE]->(a)
            WITH d, a
            OPTIONAL MATCH (c:ControlCapability {key: $capabilityKey})
            FOREACH (_ IN CASE WHEN c IS NULL THEN [] ELSE [1] END | MERGE (d)-[:SUPPORTS_CAPABILITY]->(c))
            `,
            { deviceId, actionId: saved.id, capabilityKey: saved.capability_key }
          );
          created.relations.push({ from: deviceId, type: 'CAN_EXECUTE', to: saved.id });
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
    const capability = normalizeKey(input.capability || input.capability_key) || null;
    const intent = normalizeOptionalSearchEnum(input.intent, SEARCH_INTENTS);
    const actionType = normalizeOptionalSearchEnum(input.action_type || input.adapter_type, SEARCH_ACTION_TYPES);
    const limit = Math.min(Math.max(Number.parseInt(String(input.limit || 30), 10) || 30, 1), 100);
    const hasDeviceFilter = Boolean(building || room || deviceType);
    const hasActionFilter = Boolean(capability || intent || actionType);

    return this.withSession('read', async (session) => {
      const neo4j = loadNeo4jDriver();
      const result = await session.run(
        `
        MATCH (:EngineGraph {id: $graphId})-[:OWNS]->(d:ControlDevice)
        OPTIONAL MATCH (d)-[:INSTALLED_IN]->(direct:ControlLocation)
        OPTIONAL MATCH (ancestor:ControlLocation)-[:CONTAINS*0..]->(direct)
        OPTIONAL MATCH (legacyB:ControlBuilding)-[:HAS_DEVICE]->(d)
        OPTIONAL MATCH (legacyB2:ControlBuilding)-[:HAS_ROOM]->(legacyR:ControlRoom)-[:HAS_DEVICE]->(d)
        WITH d,
          [loc IN collect(DISTINCT direct) + collect(DISTINCT ancestor) WHERE loc IS NOT NULL] AS locations,
          legacyB,
          legacyB2,
          legacyR
        WITH d, locations,
          coalesce([loc IN locations WHERE loc.kind = 'building'][0], legacyB, legacyB2) AS building,
          coalesce([loc IN locations WHERE loc.kind = 'room'][0], legacyR) AS room
        WHERE d.enabled <> false
          AND ($deviceType IS NULL OR d.device_type = $deviceType OR $deviceType IN coalesce(d.tags, []))
          AND (
            $building IS NULL
            OR (building IS NOT NULL AND (
              toLower(building.name) CONTAINS $building
              OR toLower(coalesce(building.normalized_name, '')) CONTAINS $building
              OR any(alias IN coalesce(building.aliases, []) WHERE toLower(alias) CONTAINS $building)
            ))
          )
          AND (
            $room IS NULL
            OR (room IS NOT NULL AND (
              toLower(room.name) CONTAINS $room
              OR toLower(coalesce(room.normalized_name, '')) CONTAINS $room
              OR any(alias IN coalesce(room.aliases, []) WHERE toLower(alias) CONTAINS $room)
            ))
          )
          AND (
            $query = ''
            OR $hasDeviceFilter = true
            OR toLower(d.name) CONTAINS $query
            OR any(alias IN coalesce(d.aliases, []) WHERE toLower(alias) CONTAINS $query)
            OR any(tag IN coalesce(d.tags, []) WHERE toLower(tag) CONTAINS $query)
            OR any(token IN $queryTokens WHERE toLower(d.name) CONTAINS token OR d.device_type CONTAINS token OR any(alias IN coalesce(d.aliases, []) WHERE toLower(alias) CONTAINS token) OR any(tag IN coalesce(d.tags, []) WHERE toLower(tag) CONTAINS token))
          )
        MATCH (d)-[:CAN_EXECUTE]->(a:ControlAction)
        OPTIONAL MATCH (a)-[:IMPLEMENTS]->(cap:ControlCapability)
        OPTIONAL MATCH (a)-[:EXECUTES_WITH]->(adapter:ControlCommandAdapter)
        WHERE a.enabled <> false
          AND ($intent IS NULL OR a.intent = $intent)
          AND ($actionType IS NULL OR a.action_type = $actionType OR adapter.key = $actionType)
          AND ($capability IS NULL OR a.capability_key = $capability OR cap.key = $capability OR $capability IN coalesce(cap.aliases, []))
          AND (
            $query = ''
            OR $hasActionFilter = true
            OR toLower(a.name) CONTAINS $query
            OR toLower(coalesce(a.description, '')) CONTAINS $query
            OR any(alias IN coalesce(a.aliases, []) WHERE toLower(alias) CONTAINS $query)
            OR toLower(d.name) CONTAINS $query
            OR any(token IN $queryTokens WHERE toLower(a.name) CONTAINS token OR toLower(coalesce(a.description, '')) CONTAINS token OR a.action_type CONTAINS token OR a.intent CONTAINS token OR a.capability_key CONTAINS token OR toLower(d.name) CONTAINS token OR d.device_type CONTAINS token OR any(alias IN coalesce(a.aliases, []) WHERE toLower(alias) CONTAINS token))
          )
        RETURN d, a, building, room, cap, adapter
        ORDER BY coalesce(a.importance, 0.5) DESC, d.name ASC, a.name ASC
        LIMIT $limit
        `,
        {
          graphId: CONTROL_GRAPH_ID,
          query,
          queryTokens,
          building,
          room,
          deviceType,
          capability,
          intent,
          actionType,
          hasDeviceFilter,
          hasActionFilter,
          limit: neo4j.int(limit),
        }
      );
      return result.records.map((record) => ({
        device: mapNodeProperties(record.get('d')),
        action: mapNodeProperties(record.get('a')),
        building: mapNodeProperties(record.get('building')),
        room: mapNodeProperties(record.get('room')),
        capability: mapNodeProperties(record.get('cap')),
        adapter: mapNodeProperties(record.get('adapter')),
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
        MATCH (:EngineGraph {id: $graphId})-[:OWNS]->(b:ControlLocation {kind: 'building'})
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
        OPTIONAL MATCH (b)-[:CONTAINS*0..]->(r:ControlLocation {kind: 'room'})
        WHERE (
          $room IS NULL
          OR r IS NULL
          OR toLower(r.name) CONTAINS $room
          OR any(alias IN coalesce(r.aliases, []) WHERE toLower(alias) CONTAINS $room)
        )
        RETURN b, collect(DISTINCT r)[0..$limit] AS rooms
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
        OPTIONAL MATCH (d)-[:INSTALLED_IN]->(direct:ControlLocation)
        OPTIONAL MATCH (ancestor:ControlLocation)-[:CONTAINS*0..]->(direct)
        OPTIONAL MATCH (a)-[:IMPLEMENTS]->(cap:ControlCapability)
        OPTIONAL MATCH (a)-[:EXECUTES_WITH]->(adapter:ControlCommandAdapter)
        WITH d, a, cap, adapter, [loc IN collect(DISTINCT direct) + collect(DISTINCT ancestor) WHERE loc IS NOT NULL] AS locations
        RETURN d, a,
          [loc IN locations WHERE loc.kind = 'building'][0] AS building,
          [loc IN locations WHERE loc.kind = 'room'][0] AS room,
          cap,
          adapter
        `,
        { graphId: CONTROL_GRAPH_ID, targets: normalizedTargets }
      );
      return result.records.map((record) => ({
        device: mapNodeProperties(record.get('d')),
        action: mapNodeProperties(record.get('a')),
        building: mapNodeProperties(record.get('building')),
        room: mapNodeProperties(record.get('room')),
        capability: mapNodeProperties(record.get('cap')),
        adapter: mapNodeProperties(record.get('adapter')),
      }));
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
