const { getControlEngineSettingsSync, getMemoryEngineSettingsSync } = require('../appSettings');
const { createControlRepository } = require('./repositories/controlRepository');
const { executeControlActionTarget } = require('./actionExecutor');
const { normalizeKey } = require('./controlSchema');

function toolString(payload) {
  try {
    return JSON.stringify(payload);
  } catch (_) {
    return JSON.stringify({ ok: false, error: 'Risultato non serializzabile.' });
  }
}

function toolError(tool, error) {
  return toolString({
    ok: false,
    tool,
    error: String(error?.message || error),
  });
}

function getRepository() {
  return createControlRepository(getMemoryEngineSettingsSync());
}

function requireEnabled() {
  const settings = getControlEngineSettingsSync();
  if (!settings.enabled) throw new Error('Control Engine disabilitato.');
  return settings;
}

function compactAliases(value = [], limit = 6) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, limit);
}

function compactLocation(entry = {}) {
  const building = entry.building || {};
  return {
    building_id: building.id || null,
    building: building.name || null,
    aliases: compactAliases(building.aliases),
    rooms: (Array.isArray(entry.rooms) ? entry.rooms : [])
      .map((room) => ({
        room_id: room.id || null,
        room: room.name || null,
        aliases: compactAliases(room.aliases),
      }))
      .filter((room) => room.room)
      .sort((left, right) => left.room.localeCompare(right.room, 'it')),
  };
}

function compactActionMatch(entry = {}) {
  const connectionRef = entry.action?.connection_ref || null;
  const connection = connectionRef ? getPersistentConnectionMap().get(connectionRef) : null;
  return {
    device_id: entry.device?.id || null,
    device: entry.device?.name || null,
    device_type: entry.device?.device_type || null,
    ip: entry.device?.ip || null,
    location: {
      building: entry.building?.name || null,
      room: entry.room?.name || null,
    },
    action_id: entry.action?.id || null,
    action: entry.action?.name || null,
    intent: entry.action?.intent || null,
    capability: entry.capability?.key || entry.action?.capability_key || null,
    action_type: entry.action?.action_type || null,
    adapter: entry.adapter?.key || entry.action?.adapter_type || entry.action?.action_type || null,
    connection_ref: connectionRef,
    connection_label: connection?.label || null,
    connection_enabled: connection ? connection.enabled !== false : null,
    risk_level: entry.action?.risk_level || null,
    requires_confirmation: Boolean(entry.action?.requires_confirmation),
    description: entry.action?.description || null,
    execute_target: {
      device_id: entry.device?.id || null,
      action_id: entry.action?.id || null,
    },
  };
}

function compactPersistentConnection(connection = {}) {
  return {
    ref: connection.ref,
    label: connection.label,
    protocol: connection.protocol,
    enabled: connection.enabled !== false,
  };
}

function getPersistentConnections() {
  return (getControlEngineSettingsSync()?.persistent_connections || [])
    .filter((connection) => connection?.ref && connection?.protocol)
    .map(compactPersistentConnection);
}

function getPersistentConnectionMap() {
  return new Map(getPersistentConnections().map((connection) => [connection.ref, connection]));
}

function collectActionInputs(input = {}) {
  const source = input.schema && typeof input.schema === 'object' ? input.schema : input;
  return [
    ...(Array.isArray(source.actions) ? source.actions : []),
    ...(source.action ? [source.action] : []),
  ].filter(Boolean);
}

function actionHasForbiddenConnectionFields(action = {}) {
  return ['host', 'port', 'username', 'password', 'user', 'pass', 'ip'].some((field) => {
    if (field === 'ip' && action.device_ref) return false;
    return Object.prototype.hasOwnProperty.call(action, field);
  });
}

function validateControlActionProposal(args = {}) {
  const connections = getPersistentConnections();
  const connectionMap = new Map(connections.map((connection) => [connection.ref, connection]));
  const actions = collectActionInputs(args);
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] || {};
    const actionType = String(action.action_type || action.adapter_type || action.type || 'bash').trim().toLowerCase();
    const connectionRef = normalizeKey(action.connection_ref || action.connectionRef || action.connection || '');
    const command = String(action.command || '').trim();
    if (actionHasForbiddenConnectionFields(action)) {
      return {
        ok: false,
        message: `Action ${index} non valida: host, porta, username e password non possono essere salvati nel grafo. Usa solo connection_ref per ssh/telnet.`,
        available_connections: connections,
      };
    }
    if (['telnet', 'telnet_auth', 'ssh'].includes(actionType)) {
      if (!command) {
        return {
          ok: false,
          message: `Action ${index} ${actionType} non valida: command obbligatorio.`,
          available_connections: connections,
        };
      }
      if (!connectionRef) {
        return {
          ok: false,
          message: `Action ${index} ${actionType} non valida: connection_ref mancante o non presente tra i valori accettati.`,
          available_connections: connections,
        };
      }
      const connection = connectionMap.get(connectionRef);
      const expectedProtocol = actionType === 'ssh' ? 'ssh' : 'telnet';
      if (!connection || connection.protocol !== expectedProtocol || connection.enabled === false) {
        return {
          ok: false,
          message: `Action ${index} ${actionType} non valida: connection_ref deve esistere, essere enabled e avere protocol=${expectedProtocol}.`,
          available_connections: connections,
        };
      }
    }
    if (['bash'].includes(actionType)) {
      if (!command) {
        return { ok: false, message: `Action ${index} bash non valida: command obbligatorio.` };
      }
      if (connectionRef) {
        return { ok: false, message: `Action ${index} bash non valida: connection_ref vietato per bash.` };
      }
    }
    if (['ping', 'http', 'http_api'].includes(actionType) && connectionRef) {
      return { ok: false, message: `Action ${index} ${actionType} non valida: connection_ref vietato per ${actionType}.` };
    }
  }
  return { ok: true };
}

async function getControlSchemaContext() {
  const tool = 'chrisbot_ControlEngine_getSchemaContext';
  try {
    requireEnabled();
    return toolString({
      ok: true,
      tool,
      result: {
        accepted_connections: getPersistentConnections(),
        accepted_action_types: ['bash', 'ping', 'http', 'http_api', 'telnet', 'ssh'],
        rules: [
          'telnet/ssh richiedono command e connection_ref esistente/enabled con protocol coerente.',
          'bash richiede command e non usa connection_ref.',
          'ping/http/http_api non usano connection_ref.',
          'host, port, username e password non vanno mai nel grafo.',
          'Per i device salva l IP fornito come proprieta operativa; non bloccare updateSchema per validazione semantica degli ottetti IP.',
        ],
      },
    });
  } catch (error) {
    return toolError(tool, error);
  }
}

function shouldIncludeLocations(args = {}) {
  if (args.include_locations === true) return true;
  if (args.include_locations === false) return false;

  const hasDeviceOrActionFilter = Boolean(
    String(args.device_type || args.deviceType || args.action_type || args.intent || args.capability || '').trim()
  );
  const hasExplicitLocationFilter = Boolean(String(args.building || args.room || '').trim());
  const query = String(args.query || args.instruction || args.prompt || '').trim().toLowerCase();
  const asksInventory = /\b(che|quali|elenca|lista|mostra|dimmi)\b/.test(query);
  const locationTopic = /\b(sale|sala|room|rooms|stanze|stanza|aule|aula|edifici|edificio|building|buildings)\b/.test(query);

  if (hasDeviceOrActionFilter) return false;
  if (asksInventory && locationTopic) return true;
  if (hasExplicitLocationFilter && !query) return true;
  return false;
}

function withInferredControlFilters(args = {}) {
  const nextArgs = { ...args };
  const query = String(args.query || args.instruction || args.prompt || '').trim().toLowerCase();
  if (!String(nextArgs.building || '').trim()) {
    if (/\b(?:college|collegio)\b/.test(query)) {
      nextArgs.building = 'College';
    } else if (/\bcampus\s+esterno\b/.test(query)) {
      nextArgs.building = 'Campus Esterno';
    } else if (/\bserra\b/.test(query)) {
      nextArgs.building = 'Serra';
    } else {
      const buildingMatch = query.match(/\b(?:in|nel|nello|nella|nell'|edificio|building)\s+([a-z0-9_.-]+(?:\s+[a-z0-9_.-]+)?)(?=\s+(?:se|sia|sono|e|con|per|che|quando|dove|$)|[?.!,;]|$)/i);
      if (buildingMatch?.[1]) nextArgs.building = buildingMatch[1];
    }
  }
  if (!String(nextArgs.room || '').trim()) {
    const roomMatch = query.match(/\b(?:aula|room|stanza|sala)\s+([a-z0-9_.-]+)\b/i);
    if (roomMatch?.[1]) nextArgs.room = roomMatch[1];
  }
  if (!String(nextArgs.device_type || nextArgs.deviceType || '').trim()) {
    if (/\b(bluesound|blue\s*sound)\b/.test(query)) nextArgs.device_type = 'bluesound';
    else if (/\b(proiettore|proiettori|projector|projectors|videoproiettore)\b/.test(query)) nextArgs.device_type = 'projector';
    else if (/\b(stampante|stampanti|printer|printers)\b/.test(query)) nextArgs.device_type = 'printer';
    else if (/\b(audio|musica|music|speaker|speakers|amplificatore|microfono)\b/.test(query)) nextArgs.device_type = 'audio';
    else if (/\b(computer|pc|workstation)\b/.test(query)) nextArgs.device_type = 'computer';
  }
  if (!String(nextArgs.intent || '').trim()) {
    if (/\b(controll|verific|monitor|status|stato|online|on line|valore|livello)\b/.test(query)) {
      nextArgs.intent = 'monitoring';
    } else if (/\b(avvia|avviare|start|play|riproduci|metti)\b/.test(query)) {
      nextArgs.intent = 'control';
    }
  }
  if (!String(nextArgs.capability || nextArgs.capability_key || '').trim()) {
    if (/\b(stream|streaming)\b/.test(query) && /\b(stato|status|controll|verific)\b/.test(query)) nextArgs.capability = 'stream_status';
    else if (/\b(avvia|avviare|start|play|riproduci|metti)\b/.test(query) && /\b(musica|music|audio|stream)\b/.test(query)) nextArgs.capability = 'music_play';
    else if (/\b(ping|online|on line|status|stato)\b/.test(query)) nextArgs.capability = 'status_online';
    else if (/\b(accendi|turn on|power on)\b/.test(query)) nextArgs.capability = 'power_on';
    else if (/\b(spegni|turn off|power off)\b/.test(query)) nextArgs.capability = 'power_off';
    else if (/\b(audio|volume|mute|livello|valore)\b/.test(query)) nextArgs.capability = 'audio_value';
  }
  return nextArgs;
}

const DEVICE_TYPE_LABELS = {
  projector: 'Proiettore',
  printer: 'Stampante',
  computer: 'Computer',
  audio: 'Audio',
  bluesound: 'Bluesound',
};

function cleanQuotedText(value = '') {
  return String(value || '').replace(/['"“”]/g, '').trim();
}

function normalizeBuildingName(value = '') {
  const clean = cleanQuotedText(value);
  if (!clean) return '';
  if (/^(college|colege|collegio)$/i.test(clean)) return 'College';
  return /^[A-Z0-9_.-]{2,}$/.test(clean) ? clean.toUpperCase() : clean;
}

function extractAliasList(value = '') {
  const scoped = String(value || '')
    .split(/(?:,|\s+e\s+)\s*(?:aggiungi|crea|inserisci|collega|contiene|all['’]?interno|con\s+\d+\s+(?:aule|stanze|room))/i)[0]
    .split(/\s+(?:all['’]?interno|dentro|nel|nella|nell['’]?|al|allo)\b/i)[0];
  return scoped
    .split(/\s+e\s+|\s+o\s+|,/i)
    .map(cleanQuotedText)
    .filter(Boolean);
}

function normalizeDeviceTypeLabel(deviceType, fallback) {
  return DEVICE_TYPE_LABELS[deviceType] || normalizeText(fallback, 80) || 'Device';
}

function extractLocationRef(instruction = '') {
  const roomMatch = instruction.match(/\b(aula|room|stanza|sala)\s+([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)?)(?=\s+(?:di|del|della|in|nel|nella|con|a|$))/i);
  if (roomMatch) {
    const label = roomMatch[1].toLowerCase() === 'room' ? 'Room' : roomMatch[1].toLowerCase() === 'aula' ? 'Aula' : cleanQuotedText(roomMatch[1]);
    return `${label} ${cleanQuotedText(roomMatch[2])}`;
  }
  const buildingMatch = instruction.match(/\b(?:building|edificio)\s+(?:di\s+)?([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)?)(?=\s+(?:un|una|il|la|con|che|e|a|in|nel|nella|$))/i);
  if (buildingMatch) return normalizeBuildingName(buildingMatch[1]);
  const labMatch = instruction.match(/\b(?:laboratorio|lab)\s+([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)?)(?=\s+(?:un|una|il|la|con|che|e|a|in|nel|nella|$))/i);
  if (labMatch) return cleanQuotedText(labMatch[0]);
  const collegeMatch = instruction.match(/\b(?:college|colege|collegio)\b/i);
  if (collegeMatch) return 'College';
  return '';
}

function buildPromptSchemaPreview(args = {}) {
  const instruction = String(args.instruction || args.prompt || '').trim();
  if (!instruction) return null;
  const lowered = instruction.toLowerCase();
  const schema = {};

  const locations = [];
  const addBuilding = (name, aliases = []) => {
    const cleanName = String(name || '').trim();
    if (!cleanName) return null;
    const existing = locations.find((entry) => entry.kind === 'building' && entry.name.toLowerCase() === cleanName.toLowerCase());
    if (existing) {
      existing.aliases = Array.from(new Set([...(existing.aliases || []), ...aliases].filter(Boolean)));
      return existing;
    }
    const building = { kind: 'building', name: cleanName, aliases };
    locations.push(building);
    return building;
  };
  const addRoom = (buildingName, roomName, aliases = []) => {
    const cleanBuilding = String(buildingName || '').trim();
    const cleanRoom = String(roomName || '').trim();
    if (!cleanBuilding || !cleanRoom) return;
    const path = `${cleanBuilding}/${cleanRoom}`;
    const existing = locations.find((entry) => entry.kind === 'room' && String(entry.path || '').toLowerCase() === path.toLowerCase());
    if (existing) {
      existing.aliases = Array.from(new Set([...(existing.aliases || []), ...aliases].filter(Boolean)));
      return;
    }
    locations.push({
      kind: 'room',
      name: cleanRoom,
      parent: cleanBuilding,
      building: cleanBuilding,
      path,
      aliases,
    });
  };

  const knownBuildingMatches = instruction.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]{1,40})\s*\(([^)]*)\)/g);
  for (const match of knownBuildingMatches) {
    const aliases = extractAliasList(String(match[2] || '').replace(/\bdetto\b/gi, ''));
    addBuilding(normalizeBuildingName(match[1]), aliases);
  }

  const explicitBuildingAliasMatches = instruction.matchAll(/\bedificio\s+['"“”]?([A-Za-z0-9_.-]+)['"“”]?\s+con\s+alias\s+([^.;\n]+)/gi);
  for (const match of explicitBuildingAliasMatches) {
    addBuilding(normalizeBuildingName(match[1]), extractAliasList(match[2]));
  }

  const namedBuildingAliasMatches = instruction.matchAll(/\b([A-Z][A-Za-z0-9_.-]{1,40})\s+con\s+alias\s+([^.;\n]+)/g);
  for (const match of namedBuildingAliasMatches) {
    addBuilding(normalizeBuildingName(match[1]), extractAliasList(match[2]));
  }

  const roomRangeMatch = instruction.match(/(?:aula|aule)\s+([A-Za-z]+)\s*(\d+)\s*(?:all['’]?\s*aula|a|-) \s*([A-Za-z]+)?\s*(\d+)/i)
    || instruction.match(/(?:aula|aule)\s+([A-Za-z]+)\s*(\d+)\s*(?:all['’]?\s*aula|a|-)\s*([A-Za-z]+)?\s*(\d+)/i)
    || instruction.match(/Aula\s+([A-Za-z]+)\s*(\d+)[^.\n;]+?fino\s+a\s+['"“”]?Aula\s+([A-Za-z]+)?\s*(\d+)/i);
  if (roomRangeMatch) {
    const prefix = (roomRangeMatch[1] || roomRangeMatch[3] || '').toUpperCase();
    const start = Number.parseInt(roomRangeMatch[2], 10);
    const end = Number.parseInt(roomRangeMatch[4], 10);
    const buildingName = locations.find((entry) => entry.kind === 'building')?.name || extractLocationRef(instruction);
    if (buildingName && prefix && Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 100) {
      addBuilding(buildingName, buildingName === 'College' ? ['college', 'colege', 'collegio'] : []);
      for (let index = start; index <= end; index += 1) {
        addRoom(buildingName, `Aula ${prefix}${index}`, [`${prefix}${index}`]);
      }
    }
  }

  const explicitRooms = Array.from(instruction.matchAll(/\b(Aula|Room|Stanza)\s+([A-Za-z]+)\s*(\d+)\b/gi))
    .map((match) => `${match[1][0].toUpperCase()}${match[1].slice(1).toLowerCase()} ${String(match[2] || '').toUpperCase()}${Number.parseInt(match[3], 10)}`)
    .filter((name, index, list) => name && list.indexOf(name) === index);
  if (explicitRooms.length >= 2) {
    const buildingName = locations.find((entry) => entry.kind === 'building')?.name || extractLocationRef(instruction);
    if (buildingName) {
      addBuilding(buildingName, buildingName === 'College' ? ['college', 'colege', 'collegio'] : []);
      for (const roomName of explicitRooms) {
        const alias = roomName.replace(/^Aula\s+/i, '');
        addRoom(buildingName, roomName, [alias]);
      }
    }
  }

  if (locations.length > 0) {
    schema.locations = locations;
  }

  const buildingMatch = instruction.match(/(?:edificio|building)\s+([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*?)(?=\s+(?:con|che|e|ha|contiene)\b|:|,|\.|\?|$)/i)
    || lowered.match(/\b(?:college|collegio)\b/i);
  if (buildingMatch && !schema.locations && !/\b(stampante|printer|device|action|ping)\b/i.test(instruction)) {
    const name = buildingMatch[0].includes('college') || buildingMatch[0].includes('collegio')
      ? 'College'
      : buildingMatch[1].trim();
    schema.building = { name, aliases: name.toLowerCase() === 'college' ? ['college', 'collegio'] : [] };
  }

  const roomsListMatch = instruction.match(/(?:room|rooms|aule|aule|stanze|seguenti room)\s*:\s*([^.?]+)/i);
  if (roomsListMatch) {
    const rooms = roomsListMatch[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((name) => ({ name, aliases: [name.replace(/^aula\s+/i, '').trim()].filter(Boolean) }));
    if (rooms.length > 0) schema.rooms = rooms;
  }

  const roomMatch = instruction.match(/(?:aula|room|stanza)\s+([a-zA-Z0-9 _.-]+)/i);
  const isDeviceMutation = /\b(device|stampante|printer|proiettore|projector|ip|action|azione|monitor|ping)\b/i.test(instruction);
  if (roomMatch && !schema.rooms && !schema.locations && !isDeviceMutation) {
    schema.room = { name: roomMatch[0].trim(), aliases: [roomMatch[1].trim()] };
  }

  const ipMatch = instruction.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  const typeMatch = lowered.match(/\b(proiettore|projector|stampante|printer|audio|computer|pc)\b/);
  if (typeMatch || ipMatch) {
    const typeRaw = typeMatch?.[1] || 'device';
    const deviceType = typeRaw === 'proiettore' ? 'projector'
      : typeRaw === 'stampante' ? 'printer'
        : typeRaw === 'pc' ? 'computer'
          : typeRaw;
    const deviceNameMatch = instruction.match(/\b(?:nome\/brand|brand|marca|nome)\s+['"“”]?([A-Za-z0-9_.-]+)['"“”]?/i)
      || instruction.match(/\b(?:chiamato|chiamata)\s+['"“”]?([A-Za-z0-9_.-]+)['"“”]?/i)
      || instruction.match(/\b(?:stampante|printer|proiettore|projector|computer|pc|audio)\s+(?!con\b|in\b|nel\b|nella\b|nell['’]?\b|all['’]?\b|al\b|allo\b)([A-Za-z0-9_.-]+)/i);
    const typeLabel = normalizeDeviceTypeLabel(deviceType, typeRaw);
    const deviceName = deviceNameMatch ? `${typeLabel} ${cleanQuotedText(deviceNameMatch[1])}` : [typeLabel, schema.room?.name].filter(Boolean).join(' ').trim();
    const buildingName = extractLocationRef(instruction) || schema.building?.name;
    schema.device = {
      name: deviceName || 'Device',
      ip: ipMatch?.[0] || undefined,
      device_type: deviceType,
      manufacturer: deviceNameMatch?.[1] ? cleanQuotedText(deviceNameMatch[1]) : undefined,
      location: buildingName || undefined,
      aliases: [typeRaw, deviceNameMatch?.[1]].map(cleanQuotedText).filter(Boolean),
    };
    if (buildingName && !schema.building && !schema.location && !schema.locations) {
      if (/^(aula|room|stanza|sala|laboratorio|lab)\b/i.test(buildingName)) {
        schema.location = { name: buildingName, kind: /^(aula|room|stanza|sala)\b/i.test(buildingName) ? 'room' : 'location' };
      } else {
        schema.building = { name: buildingName, aliases: buildingName === 'College' ? ['college', 'colege', 'collegio'] : [] };
      }
    }
    if (/\bping|monitor|monitoring|online|on line|stato|status|controll/i.test(instruction)) {
      schema.action = {
        name: `Monitoring ping ${schema.device.name}`,
        action_type: 'ping',
        intent: 'monitoring',
        capability_key: 'status_online',
        device_ref: schema.device.name,
        description: `Controlla se ${schema.device.name} e online tramite ping.`,
      };
    }
  }

  return Object.keys(schema).length > 0 ? schema : null;
}

async function retrieveControlInfo(args = {}) {
  const tool = 'chrisbot_ControlEngine_retrieveInfo';
  try {
    requireEnabled();
    const repository = getRepository();
    const controlArgs = withInferredControlFilters(args);
    const includeLocations = shouldIncludeLocations(args);
    const matches = await repository.search(controlArgs);
    const locations = includeLocations ? await repository.listLocations(controlArgs) : [];
    return toolString({
      ok: true,
      tool,
      result: {
        count: matches.length + locations.length,
        match_count: matches.length,
        location_count: locations.length,
        locations: locations.map(compactLocation),
        matches: matches.map(compactActionMatch),
      },
    });
  } catch (error) {
    return toolError(tool, error);
  }
}

async function updateControlSchema(args = {}) {
  const tool = 'chrisbot_ControlEngine_updateSchema';
  try {
    requireEnabled();
    const dryRun = args.dry_run !== false;
    const payload = args.schema && typeof args.schema === 'object'
      ? args.schema
      : {
          building: args.building,
          room: args.room,
          location: args.location,
          locations: args.locations,
          capabilities: args.capabilities,
          capability: args.capability,
          device: args.device,
          action: args.action,
        };
    const hasStructuredInput = ['building', 'room', 'device', 'action', 'locations', 'devices', 'actions', 'capabilities'].some((key) => payload[key]);
    const inferred = hasStructuredInput ? null : buildPromptSchemaPreview(args);
    const schema = hasStructuredInput ? payload : inferred;
    if (!schema) {
      throw new Error('Schema Control Engine mancante. Passa building, room, device, action oppure una instruction riconoscibile.');
    }
    const validation = validateControlActionProposal({ schema });
    if (!validation.ok) {
      return toolString({
        ok: false,
        tool,
        type: 'validation_error',
        message: validation.message,
        ...(validation.available_connections ? { available_connections: validation.available_connections } : {}),
      });
    }
    if (dryRun) {
      return toolString({
        ok: true,
        tool,
        result: {
          dry_run: true,
          planned_schema: schema,
          message: 'Preview generata. Richiama il tool con dry_run=false per applicare le modifiche.',
        },
      });
    }
    const result = await getRepository().upsertSchema(schema);
    return toolString({ ok: true, tool, result: { dry_run: false, ...result } });
  } catch (error) {
    return toolError(tool, error);
  }
}

async function executeControlAction(args = {}) {
  const tool = 'chrisbot_ControlEngine_executeAction';
  try {
    const settings = requireEnabled();
    if (!settings.execution_enabled) throw new Error('Esecuzione Control Engine disabilitata.');
    const dryRun = args.dry_run === true;
    const targets = Array.isArray(args.targets) ? args.targets : [];
    const resolvedTargets = await getRepository().getActionTargets(targets);
    if (resolvedTargets.length === 0) throw new Error('Nessun target azione valido trovato.');

    const items = [];
    if (dryRun) {
      for (const target of resolvedTargets) {
        items.push({
          device: target.device?.name,
          action: target.action?.name,
          status: 'dry_run',
          action_type: target.action?.action_type,
        });
      }
    } else {
      for (const target of resolvedTargets) {
        const output = await executeControlActionTarget({ ...target, params: args.params || {} });
        items.push({
          device: target.device?.name,
          device_id: target.device?.id,
          action: target.action?.name,
          action_id: target.action?.id,
          status: output.status || 'unknown',
          output: output.output || output.stdout || '',
          stdout: output.stdout || '',
          stderr: output.stderr || '',
          error: output.error || null,
          exit_code: output.exit_code ?? null,
        });
      }
    }

    const failed = items.filter((item) => item.status === 'failed').length;
    return toolString({
      ok: true,
      tool,
      result: {
        status: failed > 0 ? 'completed_with_errors' : 'completed',
        persisted: false,
        executed: items.length,
        failed,
        items,
      },
    });
  } catch (error) {
    return toolError(tool, error);
  }
}

module.exports = {
  executeControlAction,
  getControlSchemaContext,
  retrieveControlInfo,
  updateControlSchema,
  withInferredControlFilters,
};
