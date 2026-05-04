const crypto = require('crypto');
const { getControlEngineSettingsSync, getMemoryEngineSettingsSync } = require('../appSettings');
const { createControlRepository } = require('./repositories/controlRepository');
const { executeControlActionTarget } = require('./actionExecutor');

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
    action_type: entry.action?.action_type || null,
    risk_level: entry.action?.risk_level || null,
    requires_confirmation: Boolean(entry.action?.requires_confirmation),
    description: entry.action?.description || null,
    execute_target: {
      device_id: entry.device?.id || null,
      action_id: entry.action?.id || null,
    },
  };
}

function shouldIncludeLocations(args = {}) {
  if (args.include_locations === true) return true;
  if (args.include_locations === false) return false;

  const hasDeviceOrActionFilter = Boolean(
    String(args.device_type || args.deviceType || args.action_type || args.intent || '').trim()
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

function withInferredLocationFilters(args = {}) {
  const nextArgs = { ...args };
  const query = String(args.query || args.instruction || args.prompt || '').trim().toLowerCase();
  if (!String(nextArgs.building || '').trim()) {
    if (/\b(?:college|collegio)\b/.test(query)) {
      nextArgs.building = 'College';
    } else {
      const buildingMatch = query.match(/\b(?:in|nel|nello|nell'|edificio|building)\s+([a-z0-9_.-]+)\b/i);
      if (buildingMatch?.[1]) nextArgs.building = buildingMatch[1];
    }
  }
  return nextArgs;
}

function buildPromptSchemaPreview(args = {}) {
  const instruction = String(args.instruction || args.prompt || '').trim();
  if (!instruction) return null;
  const lowered = instruction.toLowerCase();
  const schema = {};

  const buildingMatch = instruction.match(/(?:edificio|building)\s+([a-zA-Z0-9_.-]+(?:\s+[a-zA-Z0-9_.-]+)*?)(?=\s+(?:con|che|e|ha|contiene)\b|:|,|\.|\?|$)/i)
    || lowered.match(/\b(?:college|collegio)\b/i);
  if (buildingMatch) {
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
  if (roomMatch && !schema.rooms) {
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
    schema.device = {
      name: [typeRaw, schema.room?.name].filter(Boolean).join(' ').trim() || 'Device',
      ip: ipMatch?.[0] || undefined,
      device_type: deviceType,
      aliases: [typeRaw].filter(Boolean),
    };
  }

  return Object.keys(schema).length > 0 ? schema : null;
}

async function retrieveControlInfo(args = {}) {
  const tool = 'chrisbot_ControlEngine_retrieveInfo';
  try {
    requireEnabled();
    const repository = getRepository();
    const includeLocations = shouldIncludeLocations(args);
    const matches = await repository.search(args);
    const locations = includeLocations ? await repository.listLocations(withInferredLocationFilters(args)) : [];
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
          device: args.device,
          action: args.action,
        };
    const hasStructuredInput = ['building', 'room', 'device', 'action'].some((key) => payload[key]);
    const inferred = hasStructuredInput ? null : buildPromptSchemaPreview(args);
    const schema = hasStructuredInput ? payload : inferred;
    if (!schema) {
      throw new Error('Schema Control Engine mancante. Passa building, room, device, action oppure una instruction riconoscibile.');
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
    const runId = `control:run:${crypto.randomUUID()}`;
    await getRepository().saveActionRun({
      id: runId,
      requested_by_agent_id: args._agentId || null,
      requested_by_user: args._userKey || null,
      query: args.query || '',
      status: failed > 0 ? 'completed_with_errors' : 'completed',
      dry_run: dryRun,
      targets,
      output: { items },
    });
    return toolString({
      ok: true,
      tool,
      result: {
        run_id: runId,
        status: failed > 0 ? 'completed_with_errors' : 'completed',
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
  retrieveControlInfo,
  updateControlSchema,
};
