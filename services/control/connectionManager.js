const net = require('net');
const { Client: SshClient } = require('ssh2');
const {
  getControlEngineSettingsSync,
  updateControlEngineSettings,
} = require('../appSettings');
const { createInternalNotification } = require('../internalTools/notifications');

const RECONNECT_DELAY_MS = 20000;
const MAX_RECONNECT_ATTEMPTS = 4;
const TELNET_COMMAND_TIMEOUT_MS = 3000;
const SSH_COMMAND_TIMEOUT_MS = 10000;

const pool = new Map();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getConnection(ref) {
  return (getControlEngineSettingsSync()?.persistent_connections || [])
    .find((connection) => connection.ref === ref && connection.enabled !== false);
}

function sanitizeOutput(raw, command) {
  const normalizedCommand = String(command || '').trim().toLowerCase();
  return String(raw || '')
    .split('\n')
    .map((line) => line.replace(/[\x00-\x1f\x7f]/g, '').trim())
    .filter(Boolean)
    .filter((line) => line.toLowerCase() !== normalizedCommand)
    .join('\n')
    .slice(0, 8000);
}

function writeSocket(socket, value) {
  if (!socket || socket.destroyed) throw new Error('Socket telnet non disponibile.');
  socket.write(value);
}

function waitForSocketData(socket, matcher, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout attesa risposta telnet.'));
    }, timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (!matcher || matcher(buffer)) {
        cleanup();
        resolve(buffer);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Connessione telnet chiusa.'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function readSocketUntilIdle(socket, idleMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = () => {
      cleanup();
      resolve(buffer);
    };
    let timer = setTimeout(finish, idleMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      clearTimeout(timer);
      timer = setTimeout(finish, idleMs);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Connessione telnet chiusa.'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function connectTelnet(config, entry) {
  const socket = net.createConnection({ host: config.host, port: config.port });
  socket.setKeepAlive(true, RECONNECT_DELAY_MS);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout connessione telnet.')), 60000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.on('close', () => {
    entry.ready = false;
    if (config.persistent) scheduleReconnect(config.ref, entry);
  });
  socket.on('error', () => {
    entry.ready = false;
  });

  if (config.auth) {
    await waitForSocketData(socket, (text) => /(login|username)[: ]*$/i.test(text), 60000).catch(() => null);
    writeSocket(socket, `${config.username}\r\n`);
    await waitForSocketData(socket, (text) => /password[: ]*$/i.test(text), 60000).catch(() => null);
    writeSocket(socket, `${config.password}\r\n`);
  }
  if (config.ready_message) {
    const readyMessage = String(config.ready_message).toLowerCase();
    await waitForSocketData(socket, (text) => text.toLowerCase().includes(readyMessage), 60000);
  } else {
    await delay(150);
  }

  return socket;
}

async function connectSsh(config, entry) {
  const client = new SshClient();
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.once('close', () => {
      entry.ready = false;
      if (config.persistent) scheduleReconnect(config.ref, entry);
    });
    client.connect({
      host: config.host,
      port: config.port || 22,
      username: config.auth ? config.username : (config.username || process.env.USER),
      password: config.auth ? config.password : undefined,
      readyTimeout: 60000,
      keepaliveInterval: RECONNECT_DELAY_MS,
    });
  });
  return client;
}

async function connectEntry(config, entry) {
  entry.connectLock = entry.connectLock.catch(() => undefined).then(async () => {
    if (entry.ready) return;
    entry.client?.destroy?.();
    entry.client?.end?.();
    entry.client = config.protocol === 'ssh'
      ? await connectSsh(config, entry)
      : await connectTelnet(config, entry);
    entry.ready = true;
    entry.retryCount = 0;
  });
  await entry.connectLock;
}

async function disableConnection(ref, reason) {
  const settings = getControlEngineSettingsSync();
  const connections = (settings.persistent_connections || []).map((connection) => (
    connection.ref === ref ? { ...connection, enabled: false } : connection
  ));
  await updateControlEngineSettings({ ...settings, persistent_connections: connections });
  await createInternalNotification({
    title: 'Connessione persistente disattivata',
    description: `La connessione persistente ${ref} e' stata disattivata dopo ${MAX_RECONNECT_ATTEMPTS} tentativi falliti. Ultimo errore: ${reason || 'n/d'}`,
  }).catch(() => null);
}

function scheduleReconnect(ref, entry) {
  if (entry.reconnectTimer || entry.disabling) return;
  entry.retryCount += 1;
  if (entry.retryCount > MAX_RECONNECT_ATTEMPTS) {
    entry.disabling = true;
    void disableConnection(ref, entry.lastError);
    return;
  }
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    const config = getConnection(ref);
    if (!config) return;
    void connectEntry(config, entry).catch((error) => {
      entry.lastError = String(error?.message || error);
      entry.ready = false;
      scheduleReconnect(ref, entry);
    });
  }, RECONNECT_DELAY_MS);
}

function getOrCreateEntry(config) {
  let entry = pool.get(config.ref);
  if (!entry) {
    entry = {
      client: null,
      ready: false,
      connectLock: Promise.resolve(),
      sendLock: Promise.resolve(),
      reconnectTimer: null,
      retryCount: 0,
      lastError: null,
      disabling: false,
    };
    pool.set(config.ref, entry);
  }
  return entry;
}

async function executeTelnetCommand(entry, config, command) {
  await connectEntry(config, entry);
  let output = '';
  entry.sendLock = entry.sendLock.catch(() => undefined).then(async () => {
    writeSocket(entry.client, `${command}\r\n`);
    output = await readSocketUntilIdle(entry.client, TELNET_COMMAND_TIMEOUT_MS);
  });
  await entry.sendLock;
  return sanitizeOutput(output, command);
}

async function executeSshCommand(entry, config, command) {
  await connectEntry(config, entry);
  let stdout = '';
  let stderr = '';
  entry.sendLock = entry.sendLock.catch(() => undefined).then(async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout comando ssh.')), SSH_COMMAND_TIMEOUT_MS);
      entry.client.exec(command, (error, stream) => {
        if (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
        stream.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
        stream.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
      });
    });
  });
  await entry.sendLock;
  return { stdout: sanitizeOutput(stdout, command), stderr: sanitizeOutput(stderr, '') };
}

async function executePersistentConnectionCommand(connectionRef, command) {
  const config = getConnection(connectionRef);
  if (!config) return { status: 'failed', error: `Connessione persistente non trovata o disabilitata: ${connectionRef}` };
  const entry = getOrCreateEntry(config);
  try {
    if (config.protocol === 'ssh') {
      const result = await executeSshCommand(entry, config, command);
      return { status: 'success', ...result, output: result.stdout };
    }
    const stdout = await executeTelnetCommand(entry, config, command);
    return { status: 'success', stdout, stderr: '', output: stdout };
  } catch (error) {
    entry.ready = false;
    entry.lastError = String(error?.message || error);
    scheduleReconnect(config.ref, entry);
    return { status: 'failed', error: entry.lastError };
  }
}

async function initializeControlPersistentConnections() {
  const connections = (getControlEngineSettingsSync()?.persistent_connections || [])
    .filter((connection) => connection.enabled !== false && connection.persistent !== false);
  for (const config of connections) {
    const entry = getOrCreateEntry(config);
    void connectEntry(config, entry).catch((error) => {
      entry.ready = false;
      entry.lastError = String(error?.message || error);
      scheduleReconnect(config.ref, entry);
    });
  }
}

function shutdownControlPersistentConnections() {
  for (const entry of pool.values()) {
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.client?.destroy?.();
    entry.client?.end?.();
  }
  pool.clear();
}

module.exports = {
  executePersistentConnectionCommand,
  initializeControlPersistentConnections,
  shutdownControlPersistentConnections,
};
