const { execFile } = require('child_process');
const net = require('net');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 15000;
const SCRIPT_ROOT = path.resolve(process.cwd(), 'runtime/control-actions');

function runProcess(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout_ms || DEFAULT_TIMEOUT_MS,
      cwd: options.cwd || process.cwd(),
      shell: false,
    }, (error, stdout, stderr) => {
      resolve({
        status: error ? 'failed' : 'success',
        exit_code: Number.isFinite(error?.code) ? error.code : 0,
        stdout: String(stdout || '').slice(0, 8000),
        stderr: String(stderr || '').slice(0, 8000),
        error: error ? String(error.message || error) : null,
      });
    });
  });
}

function splitCommand(command) {
  return String(command || '')
    .match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((part) => part.replace(/^"|"$/g, '')) || [];
}

function resolveScriptCommand(command) {
  const parts = splitCommand(command);
  if (parts.length === 0) return null;
  const scriptPath = path.resolve(SCRIPT_ROOT, parts[0]);
  if (!scriptPath.startsWith(`${SCRIPT_ROOT}${path.sep}`) && scriptPath !== SCRIPT_ROOT) return null;
  return { command: scriptPath, args: parts.slice(1) };
}

async function executePing(device, action) {
  const host = String(device?.ip || '').trim();
  if (!host) {
    return { status: 'failed', error: 'IP device mancante per ping.' };
  }
  const waitArg = process.platform === 'darwin' ? '2000' : '2';
  const result = await runProcess('ping', ['-c', '1', '-W', waitArg, host], { timeout_ms: 5000 });
  return {
    ...result,
    status: result.status === 'success' ? 'success' : 'failed',
    output: result.status === 'success' ? 'online' : 'offline',
    action_type: action?.action_type || 'ping',
  };
}

async function executeBash(device, action) {
  const resolved = resolveScriptCommand(action?.command);
  if (!resolved) {
    return {
      status: 'failed',
      error: 'Comando bash non consentito. Usa script sotto runtime/control-actions.',
    };
  }
  return runProcess(resolved.command, resolved.args, { timeout_ms: DEFAULT_TIMEOUT_MS });
}

function executeTelnetLike(device, action, params = {}) {
  return new Promise((resolve) => {
    const host = String(device?.ip || '').trim();
    if (!host) {
      resolve({ status: 'failed', error: 'IP device mancante per telnet.' });
      return;
    }
    const socket = net.createConnection({ host, port: 23 });
    const chunks = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ status: 'failed', error: 'Timeout telnet.' });
    }, DEFAULT_TIMEOUT_MS);

    socket.on('connect', () => {
      if (String(action?.action_type || '').trim().toLowerCase() === 'telnet_auth') {
        const username = String(params.username || params.user || '').trim();
        const password = String(params.password || params.pass || '').trim();
        if (username) socket.write(`${username}\r\n`);
        if (password) socket.write(`${password}\r\n`);
      }
      const command = String(action?.command || '').trim();
      if (command) socket.write(`${command}\r\n`);
      socket.end();
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      clearTimeout(timeout);
      resolve({ status: 'failed', error: String(error?.message || error) });
    });
    socket.on('close', () => {
      clearTimeout(timeout);
      resolve({
        status: 'success',
        stdout: Buffer.concat(chunks).toString('utf8').slice(0, 8000),
      });
    });
  });
}

async function executeControlActionTarget(target) {
  const { device, action } = target || {};
  const actionType = String(action?.action_type || '').trim().toLowerCase();
  if (actionType === 'ping') return executePing(device, action);
  if (actionType === 'bash') return executeBash(device, action);
  if (actionType === 'telnet' || actionType === 'telnet_auth') {
    return executeTelnetLike(device, action, target?.params || {});
  }
  return { status: 'failed', error: `Tipo azione non supportato: ${actionType || 'n/d'}` };
}

module.exports = {
  executeControlActionTarget,
};
