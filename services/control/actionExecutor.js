const { exec, execFile } = require('child_process');
const net = require('net');
const axios = require('axios');
const { executePersistentConnectionCommand } = require('./connectionManager');

const DEFAULT_TIMEOUT_MS = 15000;

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
  const command = String(action?.command || '').trim();
  if (!command) {
    return {
      status: 'failed',
      error: 'Comando bash mancante nell azione.',
    };
  }
  return new Promise((resolve) => {
    exec(command, {
      timeout: DEFAULT_TIMEOUT_MS,
      cwd: process.cwd(),
      shell: '/bin/bash',
      maxBuffer: 1024 * 1024,
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

async function executeHttpApi(_device, action, params = {}) {
  const rawCommand = String(action?.command || '').trim();
  if (!rawCommand) {
    return { status: 'failed', error: 'URL/comando HTTP mancante nell azione.' };
  }
  const parts = rawCommand.split(/\s+/);
  const first = String(parts[0] || '').toUpperCase();
  const hasMethodPrefix = /^(GET|POST|PUT|PATCH|DELETE|HEAD)$/i.test(first);
  const method = String(params.method || action?.http_method || (hasMethodPrefix ? first : 'GET')).toUpperCase();
  const url = hasMethodPrefix ? parts.slice(1).join(' ') : rawCommand;
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'failed', error: 'URL HTTP non valida.' };
  }

  let actionHeaders = {};
  try {
    actionHeaders = action?.headers_json ? JSON.parse(action.headers_json) : {};
  } catch (_) {
    actionHeaders = {};
  }

  try {
    const response = await axios({
      method,
      url,
      headers: { ...actionHeaders, ...(params.headers || {}) },
      data: params.body ?? action?.body_template ?? undefined,
      timeout: Number(params.timeout_ms || DEFAULT_TIMEOUT_MS),
      validateStatus: () => true,
    });
    const output = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    return {
      status: response.status >= 200 && response.status < 400 ? 'success' : 'failed',
      exit_code: response.status,
      stdout: String(output || '').slice(0, 8000),
      stderr: '',
      output: String(output || '').slice(0, 8000),
    };
  } catch (error) {
    return { status: 'failed', error: String(error?.message || error) };
  }
}

async function executeControlActionTarget(target) {
  const { device, action } = target || {};
  const actionType = String(action?.action_type || '').trim().toLowerCase();
  if (actionType === 'ping') return executePing(device, action);
  if (actionType === 'bash') return executeBash(device, action);
  if (actionType === 'http' || actionType === 'http_api') return executeHttpApi(device, action, target?.params || {});
  if (actionType === 'ssh') {
    return executePersistentConnectionCommand(String(action?.connection_ref || '').trim(), String(action?.command || '').trim());
  }
  if (actionType === 'telnet' || actionType === 'telnet_auth') {
    if (action?.connection_ref) {
      return executePersistentConnectionCommand(String(action.connection_ref || '').trim(), String(action?.command || '').trim());
    }
    return executeTelnetLike(device, action, target?.params || {});
  }
  return { status: 'failed', error: `Tipo azione non supportato: ${actionType || 'n/d'}` };
}

module.exports = {
  executeControlActionTarget,
};
