/**
 * Regressions for the daemon client's request/retry policy.
 *
 * A slow-but-healthy daemon used to look like "no daemon": the first request
 * timed out after a hard-coded 3s, the client spawned another daemon and
 * replayed the same payload, so one `ashop run recipe.json` mutated the
 * document twice. The client must either deliver a request exactly once or
 * fail loudly — never silently repeat a mutation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { execViaDaemon } from '../src/cli/daemon-client.js';
import { pipePath } from '../src/daemon/server.js';

function tempProject(prefix = 'ashop-daemon-') {
  return path.join(mkdtempSync(path.join(os.tmpdir(), prefix)), 'proj.ashop');
}

/** A named-pipe server that answers like a daemon after `delayMs`. */
async function fakeDaemon(project, { delayMs = 0 } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }
      requests.push(payload);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!socket.destroyed) {
        socket.end(JSON.stringify({ id: payload.id, ok: true, data: { pong: payload.id } }) + '\n');
      }
    });
    socket.on('error', () => { /* client hung up */ });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath(project), resolve);
  });
  return {
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('a slow daemon is waited for, not replayed', async () => {
  const project = tempProject();
  // 3.5s > the old hard-coded 3s probe that triggered the replay.
  const daemon = await fakeDaemon(project, { delayMs: 3500 });
  try {
    const data = await execViaDaemon(project, 'layer.fill', { color: '#123456' }, { timeoutMs: 30000 });
    assert.equal(data.pong.startsWith('r'), true);
    assert.equal(daemon.requests.length, 1, 'the command must reach the daemon exactly once');
  } finally {
    await daemon.close();
  }
});

test('a timed-out command is reported, not replayed', async () => {
  const project = tempProject();
  const daemon = await fakeDaemon(project, { delayMs: 1500 });
  try {
    await assert.rejects(
      () => execViaDaemon(project, 'layer.fill', { color: '#123456' }, { timeoutMs: 300 }),
      (err) => err.code === 'E_DAEMON_TIMEOUT',
    );
    assert.equal(daemon.requests.length, 1, 'a timeout must not resend the payload');
  } finally {
    await daemon.close();
  }
});
