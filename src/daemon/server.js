/**
 * Daemon side of the RPC protocol.
 *
 * One daemon per project bundle. Commands are serialised through a promise
 * queue so two callers can never interleave mutations on the same document.
 * The daemon keeps decoded assets and the rendered state warm; a CLI call is
 * then just a few milliseconds of JSON over a named pipe.
 */

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { Session } from '../core/session.js';
import { loadCommands } from '../cli/registry.js';
import { AshopError, asAshopError } from '../core/errors.js';

export function daemonKey(projectPath) {
  return createHash('sha256').update(path.resolve(projectPath)).digest('hex').slice(0, 16);
}

export function pipePath(projectPath) {
  const key = daemonKey(projectPath);
  if (process.platform === 'win32') return `\\\\.\\pipe\\ashop-${key}`;
  return path.join(os.tmpdir(), `ashop-${key}.sock`);
}

export async function runDaemon({ project, idleMs = Number(process.env.ASHOP_DAEMON_IDLE_MS ?? 10 * 60 * 1000) } = {}) {
  if (!project) throw new AshopError('E_USAGE', 'daemon needs --project');
  const pipe = pipePath(project);
  if (process.platform !== 'win32') {
    try { unlinkSync(pipe); } catch { /* not there */ }
  }
  let session = null;
  let queue = Promise.resolve();
  let idleTimer = null;

  async function getSession() {
    if (!session) session = await Session.open(project);
    return session;
  }

  async function handle(payload) {
    if (payload.command === '__shutdown') {
      setTimeout(() => shutdown(0), 20);
      return { stopping: true, project };
    }
    const { map } = await loadCommands();
    const command = map.get(payload.command);
    if (!command) throw new AshopError('E_USAGE', `unknown command: ${payload.command}`);
    const s = command.needsSession === false ? null : await getSession();
    const ctx = { session: s, projectPath: project, cwd: process.cwd(), args: payload.args ?? {} };
    const data = await command.run(ctx, payload.args ?? {});
    if (s && command.mutates !== false) await s.save();
    return data;
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch (err) {
          socket.write(JSON.stringify({ id: null, ok: false, error: { code: 'E_PROTOCOL', message: 'invalid JSON request' } }) + '\n');
          continue;
        }
        touchIdle();
        queue = queue.then(async () => {
          try {
            const data = await handle(payload);
            socket.write(JSON.stringify({ id: payload.id, ok: true, data }) + '\n');
          } catch (err) {
            const e = asAshopError(err);
            socket.write(JSON.stringify({ id: payload.id, ok: false, error: e.toJSON() }) + '\n');
          }
          touchIdle();
        });
      }
    });
    socket.on('error', () => { /* client went away */ });
  });

  function touchIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, Math.max(5000, idleMs));
    idleTimer.unref?.();
  }

  let shuttingDown = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (session) await session.save(); } catch { /* best effort */ }
    server.close(() => resolveDone(code));
    setTimeout(() => resolveDone(code), 500).unref?.();
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipe, () => resolve());
  });
  touchIdle();

  return done;
}
