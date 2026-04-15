const { getRoutineExecutionDescriptor } = require('../services/routineCatalog');
const { runRoutineInChildProcess } = require('../services/routineProcessRunner');

async function executeRoutine(routineName, options = {}) {
  const { definition, entrypointPath } = await getRoutineExecutionDescriptor(routineName);
  console.log(`[RoutineHandler] Esecuzione routine dinamica: ${routineName}`);
  return runRoutineInChildProcess({
    entrypointPath,
    definition,
    trigger: options.trigger || {},
    actorUsername: options.actorUsername || null,
  });
}

module.exports = {
  executeRoutine,
};
