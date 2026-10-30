/**
 * Daemon client: connect to (or lazily start) the per-project daemon, send one
 * command, return its result. Falls back to in-process execution when the
 * daemon cannot be reached.
 */

import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AshopError, asAshopError } from '../core/errors.js';
import { pipePath } from '../daemon/server.js';

const CLI_ENTRY = fileURLToPath(new URL('../../bin/ashop.js', import.meta.url));

let seq = 0;

function connect(pipe, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AshopError('E_DAEMON', `daemon did not answer on ${pipe}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new AshopError('E_DAEMON', `cannot reach daemon: ${err.message}`));
    });
  });
}

function requestOnce(pipe, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    socket.setEncoding('utf8');
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new AshopError('E_DAEMON_TIMEOUT', 'daemon request timed out', { hint: 'retry with --no-daemon' }));
    }, timeoutMs);
    socket.once('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      clearTimeout(timer);
      const line = buffer.slice(0, idx);
      socket.end();
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(new AshopError('E_PROTOCOL', 'invalid daemon response', { cause: err }));
      }
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new AshopError('E_DAEMON', `daemon connection failed: ${err.message}`));
    });
  });
}

async function waitForDaemon(pipe, waitMs = 20000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const socket = await connect(pipe, 500);
      socket.destroy();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

function spawnDaemon(project) {
  const child = spawn(process.execPath, [CLI_ENTRY, '__daemon', '--project', project], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env },
  });
  child.unref();
}

export async function execViaDaemon(project, command, args, { timeoutMs = 180000 } = {}) {
  const pipe = pipePath(project);
  const payload = { id: `r${++seq}`, command, args, project };
  let response;
  try {
    // Wait as long as the command itself may take. A short "is the daemon
    // there?" timeout fires on a slow-but-healthy daemon and would make us
    // replay a mutating command a second time; only a connection failure may
    // be followed by a spawn + retry.
    response = await requestOnce(pipe, payload, timeoutMs);
  } catch (err) {
    if (err.code === 'E_DAEMON_TIMEOUT') {
      throw new AshopError('E_DAEMON_TIMEOUT', 'the project daemon did not answer in time; the command may still be running there', {
        hint: `run \`ashop daemon.stop --project "${project}"\`, then retry with --no-daemon`,
      });
    }
    if (err.code !== 'E_DAEMON') throw err;
    spawnDaemon(project);
    const ready = await waitForDaemon(pipe);
    if (!ready) {
      throw new AshopError('E_DAEMON', 'daemon failed to start', { hint: 'retry with --no-daemon to run in-process' });
    }
    response = await requestOnce(pipe, payload, timeoutMs);
  }
  if (!response.ok) {
    throw new AshopError(response.error?.code ?? 'E_INTERNAL', response.error?.message ?? 'daemon error', {
      hint: response.error?.hint,
      details: response.error?.details,
    });
  }
  return response.data;
}

export async function pingDaemon(project) {
  const pipe = pipePath(project);
  try {
    const socket = await connect(pipe, 300);
    socket.destroy();
    return { running: true, pipe, project, key: path.basename(pipe) };
  } catch {
    return { running: false, pipe, project };
  }
}

export async function stopDaemon(project) {
  try {
    const socket = await connect(pipePath(project), 300);
    socket.write(JSON.stringify({ id: 'stop', command: '__shutdown', args: {} }) + '\n');
    socket.end();
    return { stopped: true };
  } catch {
    return { stopped: false, reason: 'not running' };
  }
}
