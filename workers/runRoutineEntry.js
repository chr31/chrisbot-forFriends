'use strict';

const { initializeAppSettings } = require('../services/appSettings');

function serializeError(error) {
  return {
    message: String(error?.message || error || 'Errore sconosciuto'),
    stack: error?.stack || null,
    code: error?.code || null,
  };
}

process.on('uncaughtException', (error) => {
  if (process.send) {
    process.send({ type: 'error', error: serializeError(error).message, code: 'UNCAUGHT_EXCEPTION' });
  }
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (process.send) {
    process.send({ type: 'error', error: serializeError(reason).message, code: 'UNHANDLED_REJECTION' });
  }
  process.exit(1);
});

process.on('message', async (message) => {
  try {
    const { entrypointPath, definition, trigger, actorUsername } = message || {};
    await initializeAppSettings();

    const routineModule = require(entrypointPath);
    const routineFn = typeof routineModule === 'function'
      ? routineModule
      : (typeof routineModule?.run === 'function' ? routineModule.run : null);

    if (!routineFn) {
      throw new Error('Il modulo routine deve esportare una funzione o una proprietà run().');
    }

    const logger = {
      info(messageText, payload) {
        process.stdout.write(`[routine:${definition?.name || 'unknown'}] ${String(messageText || '')}${payload ? ` ${JSON.stringify(payload)}` : ''}\n`);
      },
      error(messageText, payload) {
        process.stderr.write(`[routine:${definition?.name || 'unknown'}] ${String(messageText || '')}${payload ? ` ${JSON.stringify(payload)}` : ''}\n`);
      },
    };

    const result = await routineFn({
      definition,
      trigger: trigger || {},
      actorUsername: actorUsername || null,
      now: new Date().toISOString(),
      logger,
      env: process.env,
    });

    if (process.send) {
      process.send({ type: 'result', result: result === undefined ? null : result });
    }
    process.exit(0);
  } catch (error) {
    if (process.send) {
      process.send({ type: 'error', error: serializeError(error).message, code: error?.code || 'ROUTINE_EXECUTION_ERROR' });
    }
    process.exit(1);
  }
});
