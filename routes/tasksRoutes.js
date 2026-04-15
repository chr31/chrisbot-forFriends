const express = require('express');
const router = express.Router();
const cron = require('node-cron');
const authenticateToken = require('../middleware/authenticateToken');
const {
  insertTask,
  updateTask,
  getTaskById,
  getAllTasks,
  getTasksPage,
  deleteTask,
  replaceTaskAssignments,
  getTaskAssignments,
  getTaskRuns,
  getTaskEvents,
  insertTaskEvent,
} = require('../database/db_tasks');
const { getAgentById } = require('../database/db_agents');
const { canUserAccessAgent } = require('../services/agentAccess');
const { insertInboxItem, getInboxItemByKey, updateInboxItem, insertInboxMessage } = require('../database/db_inbox');
const { requireSuperAdmin } = require('../utils/adminAccess');
const {
  listLegacyRoutines,
  runLegacyRoutine,
  updateLegacyRoutineSchedule,
  deleteLegacyRoutineSchedule,
} = require('../services/legacyRoutineRunner');
const {
  listRoutineTemplates,
  createRoutineFromTemplate,
  readRoutineSource,
  writeRoutineSource,
  updateRoutineMetadata,
  resetRoutineSourceFromTemplate,
  deleteRoutine,
} = require('../services/routineCatalog');
const { ensureTaskChat } = require('../services/taskChat');
const {
  rescheduleTaskById,
  runTask,
  isTaskRuntimeEnabled,
  getActiveScheduledTasksCount,
  enableTaskRuntime,
  disableTaskRuntime,
} = require('../scheduled/tasks');
const { askOllamaChatCompletions } = require('../utils/askGpt');
const { createOpenAiClient, getDefaultOpenAiModel } = require('../services/openaiRuntime');
const { MODEL_PROVIDERS, normalizeModelConfig, getAiOptionsSnapshot, getDefaultModelConfig } = require('../services/aiModelCatalog');

router.use(authenticateToken);
router.use(requireSuperAdmin);

async function ensureAgentAccess(agentId, userContext, purpose = 'chat') {
  if (agentId === undefined || agentId === null || agentId === '') return;
  const agent = await getAgentById(agentId);
  if (!agent) {
    const error = new Error('Agente associato non trovato.');
    error.statusCode = 404;
    throw error;
  }
  const allowed = await canUserAccessAgent(agent, userContext, purpose);
  if (!allowed) {
    const error = new Error('Accesso negato all\'agente associato.');
    error.statusCode = 403;
    throw error;
  }
}

async function buildTaskDetails(task) {
  if (!task) return null;
  const [assignments, runs, events] = await Promise.all([
    getTaskAssignments(task.id),
    getTaskRuns(task.id),
    getTaskEvents(task.id),
  ]);
  return {
    ...task,
    assignments,
    runs,
    events,
  };
}

function escapeCsvCell(value) {
  const normalized = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`;
  }
  return normalized;
}

function buildTaskExportCsv(tasks) {
  const headers = [
    'id',
    'title',
    'description',
    'status',
    'is_active',
    'notifications_enabled',
    'notification_type',
    'schedule_mode',
    'schedule_cron',
    'schedule_run_at',
    'worker_agent_id',
    'request_text',
    'created_at',
    'updated_at',
  ];

  const lines = [headers.join(',')];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const row = [
      task.id,
      task.title || '',
      task.description || '',
      task.status || '',
      task.is_active ? '1' : '0',
      task.notifications_enabled ? '1' : '0',
      task.notification_type || '',
      task.schedule_json?.mode || '',
      task.schedule_json?.cron || '',
      task.schedule_json?.run_at || '',
      task.worker_agent_id || '',
      task.payload_json?.request_text || '',
      task.created_at || '',
      task.updated_at || '',
    ];
    lines.push(row.map(escapeCsvCell).join(','));
  }
  return lines.join('\n');
}

function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      const next = line[index + 1];
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  cells.push(current);
  return cells;
}

function splitCsvRecords(csvText) {
  const normalized = String(csvText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const records = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '"') {
      const next = normalized[index + 1];
      if (inQuotes && next === '"') {
        current += '""';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === '\n' && !inQuotes) {
      if (current.trim().length > 0) {
        records.push(current);
      }
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim().length > 0) {
    records.push(current);
  }
  return records;
}

function parseTaskImportCsv(csvText) {
  const records = splitCsvRecords(csvText);
  if (records.length <= 1) return [];

  const headers = parseCsvLine(records[0]).map((cell) => cell.trim());
  return records.slice(1).map((rawRecord) => {
    const values = parseCsvLine(rawRecord);
    const record = {};
    headers.forEach((header, index) => {
      record[header] = values[index] ?? '';
    });
    return record;
  });
}

function parseBooleanCsv(value, defaultValue = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'si', 'sì'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getTaskRuntimeStatus() {
  return {
    enabled: isTaskRuntimeEnabled(),
    state: isTaskRuntimeEnabled() ? 'on' : 'off',
    active_jobs: getActiveScheduledTasksCount(),
  };
}

function parsePositiveInt(value, fallback, max = 100) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function extractJsonObject(rawValue) {
  if (rawValue && typeof rawValue === 'object') return rawValue;
  const text = String(rawValue || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (__){
        return null;
      }
    }
    return null;
  }
}

function normalizeCronExpression(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';

  let normalized = raw
    .replace(/^cron\s*\(\s*/i, '')
    .replace(/\s*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';

  const parts = normalized.split(' ');
  if (parts.length === 6 && /^[0-9*/,\-]+$/.test(parts[0])) {
    normalized = parts.slice(1).join(' ');
  } else if (parts.length > 5) {
    normalized = parts.slice(-5).join(' ');
  }

  normalized = normalized.replace(/\?/g, '*').trim();
  return normalized;
}

async function generateCronWithLlm({ prompt, timezone, model_config }) {
  const messages = [
    {
      role: 'system',
      content: [
        'Converti richieste in espressioni cron a 5 campi per node-cron.',
        'Formato consentito: minuto ora giorno-del-mese mese giorno-della-settimana.',
        `Assumi timezone ${timezone}.`,
        'Rispondi solo con JSON valido con chiavi: cron_expression, summary, assumptions.',
        'summary e assumptions devono essere array di stringhe.',
      ].join(' '),
    },
    {
      role: 'user',
      content: `Richiesta utente: ${prompt}`,
    },
  ];

  const normalizedModelConfig = normalizeModelConfig(model_config || {}, getDefaultModelConfig());
  if (normalizedModelConfig.provider === MODEL_PROVIDERS.OPENAI) {
    const response = await createOpenAiClient().chat.completions.create({
      model: normalizedModelConfig.model || getDefaultOpenAiModel(),
      messages,
      temperature: 0.1,
    });
    return extractJsonObject(response.choices?.[0]?.message?.content || '');
  }

  const response = await askOllamaChatCompletions(
    messages,
    null,
    normalizedModelConfig.model,
    { ollamaServerId: normalizedModelConfig.ollama_server_id || null }
  );
  return extractJsonObject(response?.content || response);
}

async function syncTaskConfirmationInbox(task, actorUsername) {
  if (!task?.id || !task?.created_by) return;
  const itemKey = `task-confirmation-${task.id}`;
  const existing = await getInboxItemByKey(itemKey);
  const taskChat = await ensureTaskChat(task);

  if (!task.needs_confirmation) {
    if (existing) {
      await updateInboxItem(existing.id, {
        status: 'resolved',
        requires_confirmation: 0,
      });
    }
    return;
  }

  const title = task.confirmation_request_json?.title || `Conferma richiesta per task: ${task.title}`;
  const description = task.confirmation_request_json?.description || task.description || 'Il task richiede una conferma utente.';
  const payload = {
    status: 'pending_user',
    priority: task.priority || 'normal',
    title,
    description,
    category: task.notification_type || 'Task',
    chat_id: taskChat?.chatId || null,
    requires_reply: 1,
    requires_confirmation: 1,
    confirmation_state: 'pending',
    metadata_json: {
      confirmation_request: task.confirmation_request_json || null,
      task_id: task.id,
    },
    is_read: 0,
    last_message_at: new Date(),
  };

  let inboxItemId = existing?.id || null;
  if (!inboxItemId) {
    const created = await insertInboxItem({
      owner_username: task.created_by,
      task_id: task.id,
      agent_id: task.owner_agent_id || task.worker_agent_id || null,
      item_key: itemKey,
      ...payload,
    });
    inboxItemId = created.id;
  } else {
    await updateInboxItem(inboxItemId, payload);
  }

  await insertInboxMessage({
    inbox_item_id: inboxItemId,
    role: 'system',
    message_type: 'status_update',
    username: actorUsername || null,
    content: description,
    metadata_json: { source: 'task_confirmation_sync' },
  });
}

router.get('/runtime/status', async (_req, res) => {
  try {
    return res.json(getTaskRuntimeStatus());
  } catch (error) {
    console.error('Errore nel recupero stato runtime task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/runtime/off', async (_req, res) => {
  try {
    disableTaskRuntime();
    return res.json({
      message: 'Runtime task disattivato per questa istanza backend.',
      status: getTaskRuntimeStatus(),
    });
  } catch (error) {
    console.error('Errore nella disattivazione runtime task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/runtime/on', async (_req, res) => {
  try {
    await enableTaskRuntime();
    return res.json({
      message: 'Runtime task riattivato per questa istanza backend.',
      status: getTaskRuntimeStatus(),
    });
  } catch (error) {
    console.error('Errore nella riattivazione runtime task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/export', async (_req, res) => {
  try {
    const tasks = await getAllTasks();
    const csv = buildTaskExportCsv(tasks);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tasks-export-${new Date().toISOString().slice(0, 10)}.csv"`);
    return res.status(200).send(csv);
  } catch (error) {
    console.error('Errore export task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/import', async (req, res) => {
  try {
    const csv = String(req.body?.csv || '');
    if (!csv.trim()) {
      return res.status(400).json({ error: 'CSV mancante.' });
    }

    const rows = parseTaskImportCsv(csv);
    if (rows.length === 0) {
      return res.status(400).json({ error: 'Nessun task valido trovato nel CSV.' });
    }

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const title = String(row.title || '').trim();
      if (!title) {
        skipped += 1;
        errors.push(`Riga ${index + 2}: titolo mancante.`);
        continue;
      }

      try {
        const workerAgentId = row.worker_agent_id ? Number(row.worker_agent_id) : null;
        if (workerAgentId) {
          await ensureAgentAccess(workerAgentId, req.user, 'chat');
        }

        const createdTask = await insertTask({
          title,
          description: row.description || null,
          status: row.status || 'scheduled',
          worker_agent_id: workerAgentId,
          notification_type: row.notification_type || null,
          notifications_enabled: parseBooleanCsv(row.notifications_enabled, true),
          is_active: parseBooleanCsv(row.is_active, true),
          schedule_json: String(row.schedule_mode || '').trim().toLowerCase() === 'once'
            ? { mode: 'once', run_at: row.schedule_run_at || null }
            : { mode: 'cron', cron: row.schedule_cron || null },
          payload_json: {
            request_text: row.request_text || '',
            imported_from_csv: true,
          },
          created_by: req.user?.name || null,
        });

        await insertTaskEvent({
          task_id: createdTask.id,
          event_type: 'task_imported',
          actor_type: 'user',
          actor_id: req.user?.name || null,
          content: 'Task importato da CSV.',
          payload_json: { source: 'csv_import' },
        });

        await rescheduleTaskById(createdTask.id);
        created += 1;
      } catch (error) {
        skipped += 1;
        errors.push(`Riga ${index + 2}: ${error?.message || 'errore import'}`);
      }
    }

    return res.json({ ok: true, created, skipped, errors });
  } catch (error) {
    console.error('Errore import task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/legacy-routines', requireSuperAdmin, async (_req, res) => {
  try {
    return res.json(await listLegacyRoutines());
  } catch (error) {
    console.error('Errore nel recupero routine legacy:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/legacy-routines/templates', requireSuperAdmin, async (_req, res) => {
  try {
    return res.json(await listRoutineTemplates());
  } catch (error) {
    console.error('Errore nel recupero template routine:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/legacy-routines', requireSuperAdmin, async (req, res) => {
  try {
    const created = await createRoutineFromTemplate({
      name: req.body?.name,
      title: req.body?.title,
      description: req.body?.description,
      template_id: req.body?.template_id,
    }, req.user?.name || null);
    if (req.body?.cron_expression !== undefined || req.body?.is_active !== undefined) {
      await updateLegacyRoutineSchedule(created.name, {
        cron_expression: req.body?.cron_expression,
        is_active: req.body?.is_active,
      });
    }
    return res.status(201).json(created);
  } catch (error) {
    console.error('Errore creazione routine:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Errore del server' });
  }
});

router.get('/legacy-routines/:name/source', requireSuperAdmin, async (req, res) => {
  try {
    const source = await readRoutineSource(req.params.name);
    return res.json(source);
  } catch (error) {
    console.error('Errore recupero sorgente routine:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Errore del server' });
  }
});

router.put('/legacy-routines/:name', requireSuperAdmin, async (req, res) => {
  try {
    const updatedSchedule = await updateLegacyRoutineSchedule(req.params.name, {
      cron_expression: req.body?.cron_expression,
      is_active: req.body?.is_active,
    });
    if (req.body?.title !== undefined || req.body?.description !== undefined || req.body?.template_id !== undefined) {
      await updateRoutineMetadata(req.params.name, {
        title: req.body?.title,
        description: req.body?.description,
        template_id: req.body?.template_id,
      });
    }
    return res.json(updatedSchedule);
  } catch (error) {
    console.error('Errore aggiornamento routine legacy:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Errore del server' });
  }
});

router.put('/legacy-routines/:name/source', requireSuperAdmin, async (req, res) => {
  try {
    const source = String(req.body?.source || '');
    if (!source.trim()) {
      return res.status(400).json({ error: 'Sorgente routine mancante.' });
    }
    const payload = await readRoutineSource(req.params.name);
    const updatedDefinition = await writeRoutineSource(payload.definition, source, req.user?.name || null);
    return res.json({ ok: true, definition: updatedDefinition });
  } catch (error) {
    console.error('Errore salvataggio sorgente routine:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Errore del server' });
  }
});

router.post('/legacy-routines/:name/reset-template', requireSuperAdmin, async (req, res) => {
  try {
    const templateId = String(req.body?.template_id || '').trim();
    if (!templateId) {
      return res.status(400).json({ error: 'template_id mancante.' });
    }
    const payload = await resetRoutineSourceFromTemplate(req.params.name, templateId, req.user?.name || null);
    return res.json({ ok: true, ...payload });
  } catch (error) {
    console.error('Errore reset template routine:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Errore del server' });
  }
});

router.delete('/legacy-routines/:name', requireSuperAdmin, async (req, res) => {
  try {
    await deleteLegacyRoutineSchedule(req.params.name);
    await deleteRoutine(req.params.name);
    return res.json({ ok: true });
  } catch (error) {
    console.error('Errore eliminazione routine:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Errore del server' });
  }
});

router.post('/legacy-routines/:name/run', requireSuperAdmin, async (req, res) => {
  try {
    const routine = await runLegacyRoutine(req.params.name, req.user?.name || null);
    return res.status(202).json({ ok: true, routine });
  } catch (error) {
    console.error('Errore nell\'avvio routine legacy:', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Errore del server' });
  }
});

router.post('/generate-cron', async (req, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt mancante.' });
    }

    const timezone = String(req.body?.timezone || process.env.TZ || 'Europe/Rome').trim() || 'Europe/Rome';
    const modelConfig = normalizeModelConfig(req.body?.model_config || {}, getDefaultModelConfig());
    const suggestion = await generateCronWithLlm({ prompt, timezone, model_config: modelConfig });
    const cronExpression = normalizeCronExpression(suggestion?.cron_expression);

    if (!cronExpression) {
      return res.status(422).json({ error: 'Il modello non ha restituito una cron_expression valida.', suggestion: suggestion || null });
    }
    if (!cron.validate(cronExpression)) {
      return res.status(422).json({
        error: 'Il modello ha restituito una cron_expression non valida.',
        suggestion: suggestion ? {
          ...suggestion,
          cron_expression: cronExpression,
        } : null,
      });
    }

    return res.json({
      cron_expression: cronExpression,
      summary: Array.isArray(suggestion?.summary) ? suggestion.summary : [],
      assumptions: Array.isArray(suggestion?.assumptions) ? suggestion.assumptions : [],
      timezone,
      model_config: modelConfig,
    });
  } catch (error) {
    console.error('Errore generazione cron via LLM:', error);
    return res.status(500).json({ error: error.message || 'Errore del server' });
  }
});

router.get('/', async (req, res) => {
  try {
    const wantsPagination = req.query.page !== undefined
      || req.query.page_size !== undefined
      || String(req.query.paginated || '').trim() === '1';

    if (!wantsPagination) {
      const tasks = await getAllTasks();
      return res.json(tasks);
    }

    const page = parsePositiveInt(req.query.page, 1, 100000);
    const pageSize = parsePositiveInt(req.query.page_size, 20, 100);
    const result = await getTasksPage(page, pageSize);
    return res.json({
      items: result.items,
      pagination: {
        page: result.page,
        page_size: result.page_size,
        total_items: result.total,
        total_pages: result.page_size > 0 ? Math.max(1, Math.ceil(result.total / result.page_size)) : 1,
      },
    });
  } catch (error) {
    console.error('Errore nel recupero task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task non trovato' });
    }
    const details = await buildTaskDetails(task);
    return res.json(details);
  } catch (error) {
    console.error('Errore nel recupero task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/:id/runs', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task non trovato' });
    }
    const runs = await getTaskRuns(task.id);
    return res.json(runs);
  } catch (error) {
    console.error('Errore nel recupero task runs:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.get('/:id/events', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task non trovato' });
    }
    const events = await getTaskEvents(task.id);
    return res.json(events);
  } catch (error) {
    console.error('Errore nel recupero task events:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/', async (req, res) => {
  try {
    await ensureAgentAccess(req.body?.owner_agent_id, req.user, 'chat');
    await ensureAgentAccess(req.body?.worker_agent_id, req.user, 'chat');
    const created = await insertTask({
      ...(req.body || {}),
      created_by: req.user?.name || null,
    });
    if (req.body?.assignments !== undefined) {
      await replaceTaskAssignments(created.id, req.body.assignments);
    }
    await insertTaskEvent({
      task_id: created.id,
      event_type: 'task_created',
      actor_type: 'user',
      actor_id: req.user?.name || null,
      content: 'Task creato.',
      payload_json: {
        owner_agent_id: req.body?.owner_agent_id || null,
        worker_agent_id: req.body?.worker_agent_id || null,
        notifications_enabled: req.body?.notifications_enabled,
        notification_type: req.body?.notification_type || null,
      },
    });
    await rescheduleTaskById(created.id);
    let createdTask = await getTaskById(created.id);
    await ensureTaskChat(createdTask);
    createdTask = await getTaskById(created.id);
    await syncTaskConfirmationInbox(createdTask, req.user?.name || null);
    const task = await buildTaskDetails(createdTask);
    return res.status(201).json(task);
  } catch (error) {
    console.error('Errore nella creazione task:', error);
    return res.status(error.statusCode || 400).json({ error: error.message || 'Impossibile creare il task' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task non trovato' });
    }
    await ensureAgentAccess(req.body?.owner_agent_id ?? task.owner_agent_id, req.user, 'chat');
    await ensureAgentAccess(req.body?.worker_agent_id ?? task.worker_agent_id, req.user, 'chat');
    await updateTask(req.params.id, req.body || {});
    if (req.body?.assignments !== undefined) {
      await replaceTaskAssignments(req.params.id, req.body.assignments);
    }
    await insertTaskEvent({
      task_id: req.params.id,
      event_type: 'task_updated',
      actor_type: 'user',
      actor_id: req.user?.name || null,
      content: 'Task aggiornato.',
      payload_json: req.body || {},
    });
    await rescheduleTaskById(req.params.id);
    let updatedTask = await getTaskById(req.params.id);
    await ensureTaskChat(updatedTask);
    updatedTask = await getTaskById(req.params.id);
    await syncTaskConfirmationInbox(updatedTask, req.user?.name || null);
    const updated = await buildTaskDetails(updatedTask);
    return res.json(updated);
  } catch (error) {
    console.error('Errore nell\'aggiornamento task:', error);
    return res.status(error.statusCode || 400).json({ error: error.message || 'Impossibile aggiornare il task' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task non trovato' });
    }
    const { unscheduleTask } = require('../scheduled/tasks');
    unscheduleTask(req.params.id);
    const result = await deleteTask(req.params.id);
    return res.json({ deleted: result.changes > 0 });
  } catch (error) {
    console.error('Errore nell\'eliminazione task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.post('/:id/run', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task non trovato' });
    }
    const result = await runTask(task, { triggerType: 'manual', task });
    if (!result.ok) {
      return res.status(409).json({ error: 'Task non avviato', reason: result.reason || 'not_started' });
    }
    const updated = await buildTaskDetails(await getTaskById(req.params.id));
    return res.json({ ok: true, run_id: result.run_id, task: updated });
  } catch (error) {
    console.error('Errore nell\'avvio task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.patch('/active', async (req, res) => {
  try {
    const nextActive = req.body?.is_active !== false;
    const tasks = await getAllTasks();

    for (const task of tasks) {
      await updateTask(task.id, {
        is_active: nextActive,
        status: nextActive ? 'scheduled' : 'cancelled',
      });
      await insertTaskEvent({
        task_id: task.id,
        event_type: nextActive ? 'task_activated' : 'task_deactivated',
        actor_type: 'user',
        actor_id: req.user?.name || null,
        content: nextActive ? 'Task attivato tramite azione massiva.' : 'Task disattivato tramite azione massiva.',
        payload_json: { is_active: nextActive, bulk: true },
      });
      await rescheduleTaskById(task.id);
    }

    return res.json(await getAllTasks());
  } catch (error) {
    console.error('Errore aggiornamento massivo stato attivo task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

router.patch('/:id/active', async (req, res) => {
  try {
    const task = await getTaskById(req.params.id);
    if (!task) {
      return res.status(404).json({ error: 'Task non trovato' });
    }
    const nextActive = req.body?.is_active !== false;
    await updateTask(req.params.id, {
      is_active: nextActive,
      status: nextActive ? 'scheduled' : 'cancelled',
    });
    await insertTaskEvent({
      task_id: req.params.id,
      event_type: nextActive ? 'task_activated' : 'task_deactivated',
      actor_type: 'user',
      actor_id: req.user?.name || null,
      content: nextActive ? 'Task attivato.' : 'Task disattivato.',
      payload_json: { is_active: nextActive },
    });
    await rescheduleTaskById(req.params.id);
    const updated = await buildTaskDetails(await getTaskById(req.params.id));
    return res.json(updated);
  } catch (error) {
    console.error('Errore aggiornamento stato attivo task:', error);
    return res.status(500).json({ error: 'Errore del server' });
  }
});

module.exports = router;
