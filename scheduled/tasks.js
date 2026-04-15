const cron = require('node-cron');
const {
  getSchedulableTasks,
  getTaskById,
  updateTask,
  insertTaskRun,
  updateTaskRun,
  updateTaskRunIfStatus,
  insertTaskEvent,
} = require('../database/db_tasks');
const { getAgentById } = require('../database/db_agents');
const {
  getMessagesByAgentChatId,
  insertAgentMessages,
} = require('../database/db_agent_chats');
const { runAgentConversation } = require('../services/agentRunner');
const { upsertAdminInboxItem } = require('../utils/adminInbox');
const { ADMIN_SHARED_OWNER } = require('../utils/adminAccess');
const { ensureTaskChat } = require('../services/taskChat');
const { getAgentDefaultModelConfig, normalizeModelConfig } = require('../services/aiModelCatalog');

const EMPTY_TASK_RESULT_MESSAGE = 'Run completata senza testo finale del modello.';

function serializeTaskResult(result) {
  if (typeof result === 'string') return result.trim();
  if (result === undefined || result === null) return '';
  try {
    const serialized = JSON.stringify(result);
    return typeof serialized === 'string' ? serialized.trim() : '';
  } catch (_) {
    return String(result).trim();
  }
}

function normalizeTaskResultMessage(content) {
  const normalized = String(content || '').trim();
  return normalized || EMPTY_TASK_RESULT_MESSAGE;
}

async function ensureVisibleTaskAssistantReply(task, worker, chatId, runId, content, metadata = {}) {
  const messages = await getMessagesByAgentChatId(chatId);
  const hasVisibleAssistantReply = messages.some((message) =>
    message.role === 'assistant'
    && message.event_type === 'message'
    && String(message.content || '').trim()
  );

  if (hasVisibleAssistantReply) return;

  await insertAgentMessages([{
    chat_id: chatId,
    agent_id: worker.id,
    role: 'assistant',
    event_type: 'message',
    content: normalizeTaskResultMessage(content),
    metadata_json: {
      run_id: runId || null,
      task_id: task.id,
      task_run_id: runId || null,
      generated_fallback: true,
      ...metadata,
    },
  }]);
}

async function createOrUpdateTaskInboxItem(task, options) {
  return upsertAdminInboxItem({
    owner_usernames: options.owner_usernames,
    item_type: options.item_type,
    status: options.status || 'open',
    priority: task.priority || 'normal',
    title: options.title,
    description: options.description,
    category: options.category || null,
    agent_id: task.worker_agent_id || null,
    chat_id: options.chat_id || null,
    chat_id_by_owner: options.chat_id_by_owner || null,
    agent_run_id: options.agent_run_id || null,
    agent_run_id_by_owner: options.agent_run_id_by_owner || null,
    task_id: task.id,
    task_run_id: options.task_run_id || null,
    requires_reply: options.requires_reply ? 1 : 0,
    requires_confirmation: options.requires_confirmation ? 1 : 0,
    confirmation_state: options.confirmation_state || null,
    item_key: options.item_key || null,
    metadata_json: options.metadata_json || {},
    metadata_json_by_owner: options.metadata_json_by_owner || null,
    message: options.message,
    message_role: options.message_role || 'system',
    message_type: options.message_type || 'message',
    username: options.username || null,
    last_message_at: new Date(),
  });
}

const activeJobs = {};
let runtimeTasksEnabled = true;
let reconcileTimer = null;

function getReconcileIntervalMs() {
  const parsed = Number.parseInt(process.env.TASK_SCHEDULER_RECONCILE_MS || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15 * 1000;
}

function normalizeScheduleMode(task) {
  return String(task?.schedule_json?.mode || '').trim().toLowerCase() === 'once' ? 'once' : 'cron';
}

function parseRunAt(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function unscheduleTask(taskId) {
  if (!activeJobs[taskId]) return;
  activeJobs[taskId].stop();
  delete activeJobs[taskId];
}

async function runTask(task, options = {}) {
  const triggerType = options.triggerType || 'schedule';
  const isManualTrigger = triggerType === 'manual';
  if (!runtimeTasksEnabled && !isManualTrigger) return { ok: false, reason: 'runtime_disabled' };

  const freshTask = options.task || await getTaskById(task.id);
  if (!freshTask) return { ok: false, reason: 'not_found' };
  const scheduleMode = normalizeScheduleMode(freshTask);
  if (!freshTask.is_active && !isManualTrigger) return { ok: false, reason: 'inactive' };
  if (!freshTask.worker_agent_id) return { ok: false, reason: 'missing_worker' };

  const worker = await getAgentById(freshTask.worker_agent_id);
  if (!worker || !worker.is_active) {
    await insertTaskEvent({
      task_id: freshTask.id,
      event_type: 'task_run_skipped',
      actor_type: 'system',
      actor_id: 'task_scheduler',
      content: 'Worker non disponibile per l\'esecuzione del task.',
      payload_json: { worker_agent_id: freshTask.worker_agent_id || null },
    });
    return { ok: false, reason: 'worker_unavailable' };
  }

  const requestText = String(freshTask.payload_json?.request_text || '').trim();
  if (!requestText) {
    await insertTaskEvent({
      task_id: freshTask.id,
      event_type: 'task_run_skipped',
      actor_type: 'system',
      actor_id: 'task_scheduler',
      content: 'Payload task senza request_text.',
      payload_json: {},
    });
    return { ok: false, reason: 'missing_request_text' };
  }

  await updateTask(freshTask.id, { status: 'running' });
  const run = await insertTaskRun({
    task_id: freshTask.id,
    agent_id: worker.id,
    status: 'running',
    trigger_type: triggerType,
    started_at: new Date(),
    metadata_json: {
      schedule_mode: scheduleMode,
      schedule: freshTask.schedule_json || null,
    },
  });

  await insertTaskEvent({
    task_id: freshTask.id,
    task_run_id: run.id,
    event_type: 'task_run_started',
    actor_type: 'system',
    actor_id: 'task_scheduler',
    content: `Avviata esecuzione del task con worker ${worker.name}.`,
    payload_json: {
      worker_agent_id: worker.id,
      trigger_type: triggerType,
    },
  });

  let taskChat = null;
  let taskChatId = `task-${freshTask.id}`;

  try {
    taskChat = await ensureTaskChat(freshTask, { worker, forceNew: true });
    taskChatId = taskChat?.chatId || taskChatId;
    await updateTaskRun(run.id, { chat_id: taskChatId });
    await insertAgentMessages([
      {
        chat_id: taskChatId,
        agent_id: worker.id,
        role: 'system',
        event_type: 'system_prompt',
        content: `${worker.system_prompt} Oggi e il ${new Date().toISOString()}`,
        metadata_json: { task_id: freshTask.id, task_run_id: run.id, trigger_type: triggerType },
      },
      {
        chat_id: taskChatId,
        agent_id: worker.id,
        role: 'user',
        event_type: 'message',
        content: requestText,
        metadata_json: { task_id: freshTask.id, task_run_id: run.id, trigger_type: triggerType },
      },
    ]);

    const result = await runAgentConversation(
      worker,
      [
        { role: 'system', content: `${worker.system_prompt} Oggi e il ${new Date().toISOString()}` },
        { role: 'user', content: requestText },
      ],
      {
        chatId: taskChatId,
        agentId: worker.id,
        ollamaServerId: normalizeModelConfig(freshTask.payload_json?.model_config || {}, getAgentDefaultModelConfig(worker)).ollama_server_id,
        parentRunId: null,
        runId: run.id,
        parentAgentId: null,
        modelConfig: normalizeModelConfig(freshTask.payload_json?.model_config || {}, getAgentDefaultModelConfig(worker)),
        depth: 0,
      }
    );

    const resultText = serializeTaskResult(result);
    const visibleResultText = normalizeTaskResultMessage(resultText);

    await updateTaskRunIfStatus(run.id, {
      status: 'completed',
      finished_at: new Date(),
      chat_id: taskChatId,
      metadata_json: {
        chat_id: taskChatId,
        result_preview: visibleResultText.slice(0, 2000),
      },
    }, 'running');

    await insertTaskEvent({
      task_id: freshTask.id,
      task_run_id: run.id,
      event_type: 'task_run_completed',
      actor_type: 'system',
      actor_id: 'task_scheduler',
      content: 'Esecuzione task completata.',
      payload_json: {
        result_preview: visibleResultText.slice(0, 2000),
      },
    });

    await ensureVisibleTaskAssistantReply(freshTask, worker, taskChatId, run.id, visibleResultText, {
      fallback_reason: 'missing_final_agent_reply',
    });

    if (freshTask.notifications_enabled) {
      await createOrUpdateTaskInboxItem(freshTask, {
        item_type: 'info',
        status: 'open',
        title: freshTask.notification_type || freshTask.title || 'Task completato',
        description: 'Task completato con successo.',
        category: freshTask.notification_type || 'Task',
        chat_id: taskChatId,
        task_run_id: run.id,
        item_key: `task-run-${freshTask.id}-${run.id}`,
        owner_usernames: [taskChat?.ownerUsername || ADMIN_SHARED_OWNER],
        requires_reply: true,
        metadata_json: {
          trigger_type: triggerType,
          manual_trigger: isManualTrigger,
          result_preview: visibleResultText.slice(0, 2000),
        },
        message: visibleResultText,
        message_role: 'agent',
      });
    }

    if (freshTask.needs_confirmation) {
      await createOrUpdateTaskInboxItem(freshTask, {
        item_type: 'needs_confirmation',
        status: 'pending_user',
        title: freshTask.confirmation_request_json?.title || `Conferma richiesta per task: ${freshTask.title}`,
        description: freshTask.confirmation_request_json?.description || 'Il task richiede una conferma utente per proseguire.',
        category: freshTask.notification_type || 'Task',
        chat_id: taskChatId,
        task_run_id: run.id,
        requires_reply: true,
        requires_confirmation: true,
        confirmation_state: 'pending',
        item_key: `task-confirmation-${freshTask.id}`,
        owner_usernames: [taskChat?.ownerUsername || ADMIN_SHARED_OWNER],
        metadata_json: {
          confirmation_request: freshTask.confirmation_request_json || null,
        },
        message: freshTask.confirmation_request_json?.description || 'Conferma richiesta dal task.',
      });
    }

    if (scheduleMode === 'once') {
      await updateTask(freshTask.id, { status: 'completed' });
      unscheduleTask(freshTask.id);
    } else {
      await updateTask(freshTask.id, { status: 'scheduled' });
    }
    return { ok: true, run_id: run.id };
  } catch (error) {
    await updateTaskRunIfStatus(run.id, {
      status: 'failed',
      finished_at: new Date(),
      last_error: String(error?.message || error),
      chat_id: taskChatId,
    }, 'running');
    await updateTask(freshTask.id, { status: 'failed' });
    await insertTaskEvent({
      task_id: freshTask.id,
      task_run_id: run.id,
      event_type: 'task_run_failed',
      actor_type: 'system',
      actor_id: 'task_scheduler',
      content: String(error?.message || error),
      payload_json: {},
    });
    if (freshTask.notifications_enabled) {
      if (!taskChat?.chatId) {
        taskChat = await ensureTaskChat(freshTask, { worker, forceNew: true });
        taskChatId = taskChat?.chatId || taskChatId;
        await updateTaskRun(run.id, { chat_id: taskChatId });
      }
      await createOrUpdateTaskInboxItem(freshTask, {
        item_type: 'warning',
        status: 'open',
        title: freshTask.notification_type || `Errore task: ${freshTask.title}`,
        description: 'Esecuzione task fallita.',
        category: freshTask.notification_type || 'Task',
        chat_id: taskChatId,
        task_run_id: run.id,
        item_key: `task-run-${freshTask.id}-${run.id}-failed`,
        owner_usernames: [taskChat?.ownerUsername || ADMIN_SHARED_OWNER],
        requires_reply: true,
        metadata_json: {
          trigger_type: triggerType,
          manual_trigger: isManualTrigger,
          last_error: String(error?.message || error),
        },
        message: String(error?.message || error),
      });
    }
    if (taskChatId) {
      await ensureVisibleTaskAssistantReply(freshTask, worker, taskChatId, run.id, String(error?.message || error), {
        fallback_reason: 'task_run_failed',
      });
    }
    return { ok: false, reason: 'run_failed', error };
  }
}

function scheduleTask(task) {
  if (!runtimeTasksEnabled) {
    unscheduleTask(task.id);
    return false;
  }

  unscheduleTask(task.id);
  const mode = normalizeScheduleMode(task);

  if (mode === 'once') {
    if (!task.is_active) return false;
    if (task.status === 'completed' || task.status === 'cancelled') return false;
    const runAt = parseRunAt(task.schedule_json?.run_at);
    if (!runAt) return false;
    const delayMs = Math.max(0, runAt.getTime() - Date.now());
    const timeoutId = setTimeout(() => {
      runTask(task, { triggerType: 'schedule' });
    }, delayMs);
    activeJobs[task.id] = { kind: 'timeout', stop: () => clearTimeout(timeoutId) };
    return true;
  }

  const cronExpr = String(task.schedule_json?.cron || '').trim();
  if (!task.is_active) return false;
  if (!cronExpr || !cron.validate(cronExpr)) return false;
  const job = cron.schedule(cronExpr, () => {
    runTask(task, { triggerType: 'schedule' });
  });
  activeJobs[task.id] = { kind: 'cron', stop: () => job.stop() };
  return true;
}

function unscheduleAllTasks() {
  Object.keys(activeJobs).forEach((taskId) => unscheduleTask(taskId));
}

async function reconcileScheduledTasks() {
  const tasks = await getSchedulableTasks();
  const desiredIds = new Set(tasks.map((task) => String(task.id)));
  tasks.forEach((task) => scheduleTask(task));
  Object.keys(activeJobs).forEach((taskId) => {
    if (!desiredIds.has(String(taskId))) {
      unscheduleTask(taskId);
    }
  });
}

async function initializeTaskScheduler() {
  if (!runtimeTasksEnabled) {
    unscheduleAllTasks();
    return;
  }
  await reconcileScheduledTasks();
  if (!reconcileTimer) {
    reconcileTimer = setInterval(() => {
      reconcileScheduledTasks().catch((error) => {
        console.error('Errore durante la riconciliazione scheduler task:', error);
      });
    }, getReconcileIntervalMs());
  }
}

async function rescheduleTaskById(taskId) {
  const task = await getTaskById(taskId);
  if (!task) {
    unscheduleTask(taskId);
    return false;
  }
  if (!task.schedule_json || task.status === 'completed' || task.status === 'cancelled') {
    unscheduleTask(taskId);
    return false;
  }
  return scheduleTask(task);
}

async function enableTaskRuntime() {
  runtimeTasksEnabled = true;
  await initializeTaskScheduler();
}

function disableTaskRuntime() {
  runtimeTasksEnabled = false;
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  unscheduleAllTasks();
}

function isTaskRuntimeEnabled() {
  return runtimeTasksEnabled;
}

function getActiveScheduledTasksCount() {
  return Object.keys(activeJobs).length;
}

module.exports = {
  initializeTaskScheduler,
  scheduleTask,
  unscheduleTask,
  unscheduleAllTasks,
  rescheduleTaskById,
  runTask,
  enableTaskRuntime,
  disableTaskRuntime,
  isTaskRuntimeEnabled,
  getActiveScheduledTasksCount,
};
