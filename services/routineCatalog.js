const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const {
  getAllRoutineDefinitions,
  getRoutineDefinitionByName,
  upsertRoutineDefinition,
  updateRoutineDefinition,
  deleteRoutineDefinition,
} = require('../database/db_routine_definitions');
const {
  getAllLegacyRoutines,
  getLegacyRoutineByName,
  ensureLegacyRoutine,
  updateLegacyRoutine,
  deleteLegacyRoutine,
} = require('../database/db_legacy_routines');

const ROUTINES_BASE_DIR = path.resolve(process.env.ROUTINES_BASE_DIR || path.join(process.cwd(), 'runtime', 'routines'));
const DEFAULT_RUNTIME = 'node20';
const DEFAULT_ENTRYPOINT = './index.js';

const ROUTINE_TEMPLATES = Object.freeze([
  {
    id: 'basic-node',
    name: 'Routine base Node',
    description: 'Routine asincrona minima con logging e gestione contesto.',
    buildSource: ({ name, title }) => `'use strict';

module.exports = async function run(ctx = {}) {
  const startedAt = new Date().toISOString();
  ctx.logger?.info?.('Routine avviata', { routine: '${name}', startedAt });

  return {
    routine: '${name}',
    title: ${JSON.stringify(title)},
    startedAt,
    message: 'Routine eseguita correttamente.'
  };
};
`,
  },
  {
    id: 'http-routine',
    name: 'Routine HTTP',
    description: 'Template per chiamate HTTP con fetch nativo di Node 20.',
    buildSource: ({ name }) => `'use strict';

module.exports = async function run(ctx = {}) {
  const response = await fetch('https://example.com', { method: 'GET' });
  const text = await response.text();
  ctx.logger?.info?.('HTTP fetch completata', { routine: '${name}', status: response.status });

  return {
    routine: '${name}',
    status: response.status,
    preview: text.slice(0, 200)
  };
};
`,
  },
  {
    id: 'agent-trigger',
    name: 'Routine orchestrativa',
    description: 'Template vuoto per logica applicativa o integrazione con servizi interni.',
    buildSource: ({ name }) => `'use strict';

module.exports = async function run(ctx = {}) {
  const trigger = ctx.trigger || {};
  ctx.logger?.info?.('Trigger ricevuto', { routine: '${name}', trigger });

  // Inserisci qui la logica della routine.
  return {
    routine: '${name}',
    handledTrigger: trigger.type || 'manual'
  };
};
`,
  },
]);

function getRoutineTemplateById(templateId) {
  return ROUTINE_TEMPLATES.find((template) => template.id === templateId) || ROUTINE_TEMPLATES[0];
}

function sanitizeRoutineName(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);

  if (!normalized) {
    throw new Error('Nome routine non valido.');
  }
  return normalized;
}

function buildRoutinePaths(name) {
  const safeName = sanitizeRoutineName(name);
  const dirPath = path.join(ROUTINES_BASE_DIR, safeName);
  const manifestPath = path.join(dirPath, 'manifest.json');
  return {
    name: safeName,
    dirPath,
    manifestPath,
  };
}

function createChecksum(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

async function ensureCatalogDirectory() {
  await fs.mkdir(ROUTINES_BASE_DIR, { recursive: true });
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeManifest(rawManifest, routineName) {
  const name = sanitizeRoutineName(rawManifest?.name || routineName);
  const title = String(rawManifest?.title || name).trim();
  const entrypoint = String(rawManifest?.entrypoint || DEFAULT_ENTRYPOINT).trim() || DEFAULT_ENTRYPOINT;
  const runtime = String(rawManifest?.runtime || DEFAULT_RUNTIME).trim() || DEFAULT_RUNTIME;
  return {
    name,
    title,
    description: rawManifest?.description ? String(rawManifest.description).trim() : null,
    entrypoint,
    runtime,
    template_id: rawManifest?.template || rawManifest?.template_id ? String(rawManifest.template || rawManifest.template_id).trim() : null,
    config_json: rawManifest?.config && typeof rawManifest.config === 'object' ? rawManifest.config : {},
    permissions_json: rawManifest?.permissions && typeof rawManifest.permissions === 'object' ? rawManifest.permissions : {},
  };
}

async function readRoutineManifest(name) {
  const { manifestPath } = buildRoutinePaths(name);
  const manifest = await readJsonFile(manifestPath);
  return normalizeManifest(manifest, name);
}

async function writeRoutineManifest(name, manifest) {
  const { dirPath, manifestPath } = buildRoutinePaths(name);
  await fs.mkdir(dirPath, { recursive: true });
  const serialized = `${JSON.stringify({
    name: manifest.name,
    title: manifest.title,
    description: manifest.description,
    entrypoint: manifest.entrypoint,
    runtime: manifest.runtime,
    template: manifest.template_id,
    config: manifest.config_json || {},
    permissions: manifest.permissions_json || {},
  }, null, 2)}\n`;
  await fs.writeFile(manifestPath, serialized, 'utf8');
}

function resolveEntrypoint(definition) {
  const { dirPath } = buildRoutinePaths(definition.name);
  const rawEntrypoint = String(definition?.entrypoint || DEFAULT_ENTRYPOINT).trim() || DEFAULT_ENTRYPOINT;
  const resolvedPath = path.resolve(dirPath, rawEntrypoint);
  if (!resolvedPath.startsWith(dirPath + path.sep) && resolvedPath !== dirPath) {
    throw new Error('Entrypoint routine non valido.');
  }
  return resolvedPath;
}

async function readRoutineSource(name) {
  const definition = await getRoutineDefinitionByName(name);
  if (!definition) {
    const error = new Error('Routine non trovata.');
    error.statusCode = 404;
    throw error;
  }
  const sourcePath = resolveEntrypoint(definition);
  let source;
  try {
    source = await fs.readFile(sourcePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const missingSourceError = new Error('File sorgente routine non trovato.');
      missingSourceError.statusCode = 404;
      missingSourceError.code = 'ROUTINE_SOURCE_MISSING';
      missingSourceError.source_path = sourcePath;
      missingSourceError.definition = definition;
      throw missingSourceError;
    }
    throw error;
  }
  return {
    definition,
    source,
    source_path: sourcePath,
  };
}

function validateRoutineSource(source) {
  try {
    new vm.Script(String(source || ''), { filename: 'routine.js' });
  } catch (error) {
    const syntaxError = new Error(`Syntax error: ${error.message}`);
    syntaxError.statusCode = 400;
    throw syntaxError;
  }
}

async function writeRoutineSource(definition, source, actorUsername) {
  validateRoutineSource(source);
  const sourcePath = resolveEntrypoint(definition);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const tempPath = `${sourcePath}.tmp-${Date.now()}`;
  await fs.writeFile(tempPath, source, 'utf8');
  await fs.rename(tempPath, sourcePath);
  const nextVersion = (Number(definition.version) || 1) + 1;
  await updateRoutineDefinition(definition.name, {
    checksum: createChecksum(source),
    sync_status: 'ready',
    last_sync_error: null,
    version: nextVersion,
  });
  if (actorUsername) {
    await updateLegacyRoutine(definition.name, {
      last_error: null,
      last_triggered_by: actorUsername,
    });
  }
  return getRoutineDefinitionByName(definition.name);
}

async function listRoutineTemplates() {
  return ROUTINE_TEMPLATES.map(({ id, name, description }) => ({ id, name, description }));
}

async function syncRoutineDefinitionsFromDisk() {
  await ensureCatalogDirectory();
  const entries = await fs.readdir(ROUTINES_BASE_DIR, { withFileTypes: true });
  const discoveredNames = new Set();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const routineName = sanitizeRoutineName(entry.name);
    discoveredNames.add(routineName);

    try {
      const manifest = await readRoutineManifest(routineName);
      const sourcePath = resolveEntrypoint(manifest);
      const source = await fs.readFile(sourcePath, 'utf8');
      await upsertRoutineDefinition({
        ...manifest,
        checksum: createChecksum(source),
        sync_status: 'ready',
        last_sync_error: null,
      });
      await ensureLegacyRoutine({
        name: manifest.name,
        title: manifest.title,
        description: manifest.description,
      });
    } catch (error) {
      await upsertRoutineDefinition({
        name: routineName,
        title: routineName,
        description: null,
        entrypoint: DEFAULT_ENTRYPOINT,
        runtime: DEFAULT_RUNTIME,
        template_id: null,
        checksum: null,
        config_json: {},
        permissions_json: {},
        sync_status: 'error',
        last_sync_error: String(error?.message || error),
      });
      await ensureLegacyRoutine({
        name: routineName,
        title: routineName,
        description: null,
      });
    }
  }

  const definitions = await getAllRoutineDefinitions();
  await Promise.all(definitions.map(async (definition) => {
    if (discoveredNames.has(definition.name)) return;
    await updateRoutineDefinition(definition.name, {
      sync_status: 'missing',
      last_sync_error: 'Directory routine non presente nel volume.',
    });
  }));
}

async function listRoutinesWithRuntime() {
  await syncRoutineDefinitionsFromDisk();
  const [definitions, runtimeRows] = await Promise.all([
    getAllRoutineDefinitions(),
    getAllLegacyRoutines(),
  ]);
  const runtimeByName = new Map(runtimeRows.map((routine) => [routine.name, routine]));

  return definitions.map((definition) => {
    const runtime = runtimeByName.get(definition.name) || {};
    return {
      ...runtime,
      ...definition,
      name: definition.name,
      title: definition.title,
      description: definition.description || '',
      cron_expression: runtime.cron_expression || null,
      is_active: Boolean(runtime.is_active),
      is_running: Boolean(runtime.is_running),
      last_run_id: runtime.last_run_id || null,
      last_started_at: runtime.last_started_at || null,
      last_finished_at: runtime.last_finished_at || null,
      last_status: runtime.last_status || null,
      last_error: runtime.last_error || definition.last_sync_error || null,
      last_triggered_by: runtime.last_triggered_by || null,
    };
  });
}

async function createRoutineFromTemplate(input, actorUsername) {
  await ensureCatalogDirectory();
  const name = sanitizeRoutineName(input?.name);
  if (await getRoutineDefinitionByName(name)) {
    const error = new Error('Esiste già una routine con questo nome.');
    error.statusCode = 409;
    throw error;
  }

  const title = String(input?.title || name).trim() || name;
  const description = input?.description ? String(input.description).trim() : null;
  const template = getRoutineTemplateById(String(input?.template_id || 'basic-node').trim());
  const { dirPath } = buildRoutinePaths(name);
  await fs.mkdir(dirPath, { recursive: false });

  const manifest = {
    name,
    title,
    description,
    entrypoint: DEFAULT_ENTRYPOINT,
    runtime: DEFAULT_RUNTIME,
    template_id: template.id,
    config_json: {},
    permissions_json: {},
  };
  const source = template.buildSource({ name, title, description });

  await writeRoutineManifest(name, manifest);
  await fs.writeFile(path.join(dirPath, 'index.js'), source, 'utf8');

  const definition = await upsertRoutineDefinition({
    ...manifest,
    checksum: createChecksum(source),
    sync_status: 'ready',
    last_sync_error: null,
    version: 1,
    created_by: actorUsername || null,
  });
  await ensureLegacyRoutine({ name, title, description });
  return definition;
}

async function updateRoutineMetadata(name, updates) {
  const definition = await getRoutineDefinitionByName(name);
  if (!definition) {
    const error = new Error('Routine non trovata.');
    error.statusCode = 404;
    throw error;
  }

  const nextManifest = {
    ...definition,
    title: updates.title === undefined ? definition.title : String(updates.title || '').trim() || definition.name,
    description: updates.description === undefined ? definition.description : (updates.description ? String(updates.description).trim() : null),
    template_id: updates.template_id === undefined ? definition.template_id : String(updates.template_id || '').trim() || null,
    config_json: updates.config_json === undefined ? definition.config_json : (updates.config_json || {}),
    permissions_json: updates.permissions_json === undefined ? definition.permissions_json : (updates.permissions_json || {}),
  };
  await writeRoutineManifest(name, nextManifest);
  await updateRoutineDefinition(name, {
    title: nextManifest.title,
    description: nextManifest.description,
    template_id: nextManifest.template_id,
    config_json: nextManifest.config_json,
    permissions_json: nextManifest.permissions_json,
    sync_status: 'ready',
    last_sync_error: null,
  });
  await ensureLegacyRoutine({
    name,
    title: nextManifest.title,
    description: nextManifest.description,
  });
  return getRoutineDefinitionByName(name);
}

async function resetRoutineSourceFromTemplate(name, templateId, actorUsername) {
  const definition = await getRoutineDefinitionByName(name);
  if (!definition) {
    const error = new Error('Routine non trovata.');
    error.statusCode = 404;
    throw error;
  }

  const nextTemplate = getRoutineTemplateById(String(templateId || definition.template_id || 'basic-node').trim());
  const nextDefinition = await updateRoutineMetadata(name, {
    template_id: nextTemplate.id,
  });
  const source = nextTemplate.buildSource({
    name: definition.name,
    title: nextDefinition?.title || definition.title,
    description: nextDefinition?.description || definition.description || null,
  });
  const updatedDefinition = await writeRoutineSource(nextDefinition || definition, source, actorUsername);
  return {
    definition: updatedDefinition,
    source,
  };
}

async function getRoutineExecutionDescriptor(name) {
  await syncRoutineDefinitionsFromDisk();
  const definition = await getRoutineDefinitionByName(name);
  if (!definition) {
    const error = new Error('Routine non trovata.');
    error.statusCode = 404;
    throw error;
  }
  if (definition.sync_status !== 'ready') {
    const error = new Error(definition.last_sync_error || 'Routine non disponibile nel volume.');
    error.statusCode = 409;
    throw error;
  }
  return {
    definition,
    entrypointPath: resolveEntrypoint(definition),
    baseDir: ROUTINES_BASE_DIR,
  };
}

async function deleteRoutine(name) {
  const definition = await getRoutineDefinitionByName(name);
  if (!definition) {
    const error = new Error('Routine non trovata.');
    error.statusCode = 404;
    throw error;
  }

  const { dirPath } = buildRoutinePaths(name);
  await fs.rm(dirPath, { recursive: true, force: true });
  await deleteRoutineDefinition(name);
  await deleteLegacyRoutine(name);
  return { ok: true };
}

module.exports = {
  ROUTINES_BASE_DIR,
  listRoutineTemplates,
  listRoutinesWithRuntime,
  syncRoutineDefinitionsFromDisk,
  createRoutineFromTemplate,
  getRoutineExecutionDescriptor,
  readRoutineSource,
  writeRoutineSource,
  updateRoutineMetadata,
  resetRoutineSourceFromTemplate,
  deleteRoutine,
};
