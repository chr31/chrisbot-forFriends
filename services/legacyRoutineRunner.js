const cron = require('node-cron');
const { executeRoutine } = require('../scheduled/routine-handler');
const {
  getAllLegacyRoutines,
  getLegacyRoutineByName,
  updateLegacyRoutine,
} = require('../database/db_legacy_routines');
const { listRoutinesWithRuntime, syncRoutineDefinitionsFromDisk } = require('./routineCatalog');

const activeJobs = {};
let nextRunId = 1;

function unscheduleLegacyRoutine(name) {
  if (!activeJobs[name]) return;
  activeJobs[name].stop();
  delete activeJobs[name];
}

async function deleteLegacyRoutineSchedule(name) {
  unscheduleLegacyRoutine(name);
}

async function getLegacyRuntimeSnapshot(name) {
  return getLegacyRoutineByName(name);
}

async function listLegacyRoutines() {
  return listRoutinesWithRuntime();
}

async function recoverInterruptedLegacyRoutines() {
  const routines = await listRoutinesWithRuntime();
  const interrupted = routines.filter((routine) => routine.is_running);
  if (interrupted.length === 0) return [];

  const finishedAt = new Date();
  await Promise.all(interrupted.map((routine) => {
    const message = routine.last_error
      || 'Routine interrotta: processo riavviato o terminato prima del completamento.';
    return updateLegacyRoutine(routine.name, {
      is_running: 0,
      last_finished_at: finishedAt,
      last_status: 'failed',
      last_error: message,
    });
  }));

  return interrupted.map((routine) => routine.name);
}

async function runLegacyRoutine(name, actorUsername, options = {}) {
  await syncRoutineDefinitionsFromDisk();
  const routine = await getLegacyRoutineByName(name);
  if (!routine) {
    const error = new Error('Routine legacy non trovata.');
    error.statusCode = 404;
    throw error;
  }
  if (routine.is_running) {
    if (options.skipIfRunning) {
      return {
        ...routine,
        skipped: true,
        skip_reason: 'already_running',
      };
    }
    const error = new Error('Routine legacy già in esecuzione.');
    error.statusCode = 409;
    throw error;
  }

  const runId = nextRunId++;
  await updateLegacyRoutine(routine.name, {
    is_running: 1,
    last_run_id: runId,
    last_started_at: new Date(),
    last_finished_at: null,
    last_status: 'running',
    last_error: null,
    last_triggered_by: String(actorUsername || '').trim() || 'system',
  });

  Promise.resolve()
    .then(() => executeRoutine(routine.name, {
      actorUsername: String(actorUsername || '').trim() || 'system',
      trigger: {
        type: options.skipIfRunning ? 'schedule' : 'manual',
        actor: String(actorUsername || '').trim() || 'system',
      },
    }))
    .then(async () => {
      await updateLegacyRoutine(routine.name, {
        is_running: 0,
        last_run_id: runId,
        last_finished_at: new Date(),
        last_status: 'completed',
        last_error: null,
      });
    })
    .catch(async (error) => {
      try {
        await updateLegacyRoutine(routine.name, {
          is_running: 0,
          last_run_id: runId,
          last_finished_at: new Date(),
          last_status: 'failed',
          last_error: String(error?.message || error),
        });
      } catch (persistError) {
        console.error(`Errore persistenza stato routine legacy ${routine.name}:`, persistError);
      }
      console.error(`Errore esecuzione routine legacy ${routine.name}:`, error);
    });

  return getLegacyRuntimeSnapshot(routine.name);
}

function scheduleLegacyRoutine(routine) {
  unscheduleLegacyRoutine(routine.name);
  const cronExpression = String(routine?.cron_expression || '').trim();
  if (!routine?.is_active || !cronExpression || !cron.validate(cronExpression)) {
    return false;
  }
  const job = cron.schedule(cronExpression, () => {
    runLegacyRoutine(routine.name, 'system', { skipIfRunning: true }).catch((error) => {
      console.error(`Errore trigger cron routine legacy ${routine.name}:`, error);
    });
  });
  activeJobs[routine.name] = { stop: () => job.stop() };
  return true;
}

async function reconcileLegacyRoutineSchedules() {
  await syncRoutineDefinitionsFromDisk();
  const routines = await getAllLegacyRoutines();
  const desired = new Set(routines.map((routine) => routine.name));
  for (const routine of routines) {
    scheduleLegacyRoutine(routine);
  }
  Object.keys(activeJobs).forEach((name) => {
    if (!desired.has(name)) {
      unscheduleLegacyRoutine(name);
    }
  });
}

async function initializeLegacyRoutineScheduler() {
  await syncRoutineDefinitionsFromDisk();
  const recovered = await recoverInterruptedLegacyRoutines();
  if (recovered.length > 0) {
    console.warn(`Routine legacy marcate come interrotte dopo restart: ${recovered.join(', ')}`);
  }
  await reconcileLegacyRoutineSchedules();
}

async function updateLegacyRoutineSchedule(name, updates) {
  const routine = await getLegacyRoutineByName(name);
  if (!routine) {
    const error = new Error('Routine legacy non trovata.');
    error.statusCode = 404;
    throw error;
  }

  const nextCron = updates.cron_expression === undefined
    ? routine.cron_expression
    : (updates.cron_expression === null ? null : String(updates.cron_expression || '').trim());

  if (nextCron && !cron.validate(nextCron)) {
    const error = new Error('Espressione cron non valida.');
    error.statusCode = 400;
    throw error;
  }

  await updateLegacyRoutine(name, updates);
  await reconcileLegacyRoutineSchedules();
  return getLegacyRoutineByName(name);
}

module.exports = {
  listLegacyRoutines,
  getLegacyRuntimeSnapshot,
  runLegacyRoutine,
  updateLegacyRoutineSchedule,
  initializeLegacyRoutineScheduler,
  recoverInterruptedLegacyRoutines,
  deleteLegacyRoutineSchedule,
};
