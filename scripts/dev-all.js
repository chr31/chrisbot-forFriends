#!/usr/bin/env node

const { spawn } = require('child_process');
const readline = require('readline');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const processes = [
  {
    name: 'backend',
    color: '\x1b[36m',
    command: npmCommand,
    args: ['run', 'dev'],
    cwd: process.cwd(),
  },
  {
    name: 'frontend',
    color: '\x1b[35m',
    command: npmCommand,
    args: ['run', 'dev'],
    cwd: `${process.cwd()}/frontend`,
  },
];

let shuttingDown = false;

function prefixStream(stream, name, color) {
  const rl = readline.createInterface({ input: stream });

  rl.on('line', (line) => {
    console.log(`${color}[${name}]\x1b[0m ${line}`);
  });
}

const children = processes.map((processConfig) => {
  const child = spawn(processConfig.command, processConfig.args, {
    cwd: processConfig.cwd,
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  prefixStream(child.stdout, processConfig.name, processConfig.color);
  prefixStream(child.stderr, processConfig.name, processConfig.color);

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    shuttingDown = true;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`[dev:all] ${processConfig.name} stopped with ${reason}. Stopping remaining processes...`);
    stopChildren();
    process.exit(code || 1);
  });

  child.on('error', (error) => {
    if (shuttingDown) return;

    shuttingDown = true;
    console.error(`[dev:all] Failed to start ${processConfig.name}: ${error.message}`);
    stopChildren();
    process.exit(1);
  });

  return child;
});

function stopChildren() {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;
  console.log(`\n[dev:all] Received ${signal}. Stopping backend and frontend...`);
  stopChildren();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
