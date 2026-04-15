const path = require('path');
const { fork } = require('child_process');

const RUNNER_SCRIPT = path.join(__dirname, '..', 'workers', 'runRoutineEntry.js');
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.ROUTINE_EXEC_TIMEOUT_MS || '', 10) > 0
  ? Number.parseInt(process.env.ROUTINE_EXEC_TIMEOUT_MS || '', 10)
  : 5 * 60 * 1000;

async function runRoutineInChildProcess({ entrypointPath, definition, trigger, actorUsername }) {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER_SCRIPT, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    let settled = false;
    const stdout = [];
    const stderr = [];

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      const error = new Error(`Routine terminata per timeout dopo ${DEFAULT_TIMEOUT_MS}ms.`);
      error.code = 'ROUTINE_TIMEOUT';
      reject(error);
    }, DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk) => {
      stdout.push(String(chunk));
    });
    child.stderr?.on('data', (chunk) => {
      stderr.push(String(chunk));
    });

    child.on('message', (message) => {
      if (settled || !message || typeof message !== 'object') return;
      if (message.type === 'result') {
        settled = true;
        clearTimeout(timeoutId);
        resolve({
          ok: true,
          result: message.result,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
        });
      } else if (message.type === 'error') {
        settled = true;
        clearTimeout(timeoutId);
        const error = new Error(message.error || 'Routine fallita.');
        error.code = message.code || 'ROUTINE_ERROR';
        reject(error);
      }
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({
          ok: true,
          result: null,
          stdout: stdout.join(''),
          stderr: stderr.join(''),
        });
        return;
      }
      const error = new Error(`Routine terminata con exit code ${code ?? 'n/d'}${signal ? ` (${signal})` : ''}.`);
      error.code = 'ROUTINE_EXIT';
      error.stdout = stdout.join('');
      error.stderr = stderr.join('');
      reject(error);
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    });

    child.send({
      entrypointPath,
      definition: {
        name: definition.name,
        title: definition.title,
        description: definition.description || '',
        config_json: definition.config_json || {},
        permissions_json: definition.permissions_json || {},
      },
      trigger: trigger || {},
      actorUsername: actorUsername || null,
    });
  });
}

module.exports = {
  runRoutineInChildProcess,
};
