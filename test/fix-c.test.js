/**
 * Fix-C regressions: F-009 (layer.crop) and F-012 (daemon timeout PID hint).
 *
 * Crop is content-space and non-destructive-by-metadata: the cropped pixels
 * become a new asset, the pre-crop asset/size/mask stay in `content.original`,
 * and `--reset` restores them. Daemon timeouts must name the daemon PID and a
 * copy-pasteable cleanup command instead of leaving an orphan to hunt down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { tempDir, cli, ok, fails } from './helpers.js';
import { execViaDaemon, stopDaemon } from '../src/cli/daemon-client.js';
import { pipePath, daemonKey } from '../src/daemon/server.js';
import {
  pidFilePath, writePidFile, readPidFile, removePidFile, isProcessAlive, killCommand,
} from '../src/daemon/pidfile.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 200x100 image: left half red, right half blue. */
async function makeSample(dir) {
  const width = 200;
  const height = 100;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = x < 100 ? 255 : 0;
      data[i + 1] = 0;
      data[i + 2] = x < 100 ? 0 : 255;
      data[i + 3] = 255;
    }
  }
  const file = path.join(dir, 'sample.png');
  await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
  return file;
}

function tempProject(prefix = 'ashop-fix-c-') {
  return path.join(mkdtempSync(path.join(os.tmpdir(), prefix)), 'proj.ashop');
}

/** A named-pipe server that answers like a daemon after `delayMs`. */
async function fakeDaemon(project, { delayMs = 1500 } = {}) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.on('data', async (chunk) => {
      if (!chunk.includes('\n')) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!socket.destroyed) {
        socket.end(JSON.stringify({ id: 'fake', ok: true, data: {} }) + '\n');
      }
    });
    socket.on('error', () => { /* client hung up */ });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath(project), resolve);
  });
  return {
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// ---------------------------------------------------------------------------
// F-009 — layer.crop
// ---------------------------------------------------------------------------

test('layer.crop is discovered by help, describe and schema', () => {
  const help = cli(['help']).stdout;
  assert.match(help, /layer\.crop/);
  assert.match(cli(['help', 'layer.crop']).stdout, /--rect/);

  const catalog = ok(['describe', 'commands']);
  const command = catalog.commands.find((c) => c.name === 'layer.crop');
  assert.ok(command, 'describe commands must list layer.crop');
  assert.equal(command.params.rect.type, 'rect');
  assert.equal(command.params.reset.type, 'bool');
  assert.equal(command.needsSession, true);
  assert.equal(command.mutates, true);

  const schema = ok(['schema']);
  assert.ok(schema.commands.some((c) => c.name === 'layer.crop'), 'schema must list layer.crop');

  const described = ok(['describe', 'layer.crop']);
  assert.equal(described.name, 'layer.crop');
  assert.equal(described.params.rect.type, 'rect');
  assert.ok(described.examples.some((ex) => ex.includes('--rect')));
});

test('layer.crop crops content, changes rendering and --reset restores the original', async () => {
  const dir = tempDir('ashop-fix-c-crop-');
  const project = path.join(dir, 'crop.ashop');
  const sample = await makeSample(dir);
  ok(['init', '100', '100', '--project', project]);
  ok(['layer', 'import', sample, '--name', 'img', '--at', '0,0', '--project', project]);

  // Canvas 100x100 shows the left (red) half of the 200x100 source.
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', project]).rgba, [255, 0, 0, 255]);

  const cropped = ok(['layer', 'crop', 'img', '--rect', '100,0,100,100', '--project', project]);
  assert.equal(cropped.contentSize.width, 100);
  assert.equal(cropped.contentSize.height, 100);
  assert.equal(cropped.originalSize.width, 200);
  assert.equal(cropped.crop.x, 100);
  assert.equal(cropped.layer.content.width, 100);
  assert.equal(cropped.layer.content.original.width, 200);
  assert.equal(cropped.resetAvailable, true);

  // The crop box becomes the new content origin (transform untouched), so the
  // right (blue) half now fills the canvas.
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', project]).rgba, [0, 0, 255, 255]);

  const reset = ok(['layer', 'crop', 'img', '--reset', '--project', project]);
  assert.equal(reset.reset, true);
  const info = ok(['layer', 'info', 'img', '--project', project]);
  assert.equal(info.layer.content.width, 200);
  assert.equal(info.layer.content.crop, undefined);
  assert.equal(info.layer.content.original, undefined);
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', project]).rgba, [255, 0, 0, 255]);
});

test('layer.crop --keep-position keeps the cropped pixels where they were', async () => {
  const dir = tempDir('ashop-fix-c-keep-');
  const project = path.join(dir, 'keep.ashop');
  const sample = await makeSample(dir);
  ok(['init', '100', '100', '--project', project]);
  ok(['layer', 'import', sample, '--name', 'img', '--at', '0,0', '--project', project]);

  const cropped = ok(['layer', 'crop', 'img', '--rect', '100,0,100,100', '--keep-position', '--project', project]);
  assert.equal(cropped.keptPosition, true);
  // The kept region is still anchored at canvas x=100, i.e. outside the canvas.
  assert.equal(cropped.layer.transform.anchorX, -1);
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', project]).rgba, [0, 0, 0, 0]);

  ok(['layer', 'crop', 'img', '--reset', '--project', project]);
  const info = ok(['layer', 'info', 'img', '--project', project]);
  assert.equal(info.layer.transform.anchorX, 0);
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', project]).rgba, [255, 0, 0, 255]);
});

test('layer.crop crops the layer mask with the same box', async () => {
  const dir = tempDir('ashop-fix-c-mask-');
  const project = path.join(dir, 'mask.ashop');
  const sample = await makeSample(dir);
  ok(['init', '100', '100', '--project', project]);
  ok(['layer', 'import', sample, '--name', 'img', '--at', '0,0', '--project', project]);
  ok(['select', 'rect', '--rect', '0,0,100,100', '--project', project]);
  ok(['mask', 'from-selection', '--layer', 'img', '--project', project]);
  const maskedHash = ok(['layer', 'info', 'img', '--project', project]).layer.mask.assetId;

  ok(['layer', 'crop', 'img', '--rect', '100,0,100,100', '--project', project]);
  const croppedMask = ok(['layer', 'info', 'img', '--project', project]).layer.mask;
  assert.ok(croppedMask, 'crop must keep a mask');
  assert.notEqual(croppedMask.assetId, maskedHash, 'the mask is re-cropped, not just carried over');
  // Old mask covered the left half; the right-half crop is fully outside it.
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', project]).rgba, [0, 0, 0, 0]);

  ok(['layer', 'crop', 'img', '--reset', '--project', project]);
  assert.equal(ok(['layer', 'info', 'img', '--project', project]).layer.mask.assetId, maskedHash);
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', project]).rgba, [255, 0, 0, 255]);
});

test('layer.crop works in a run batch and survives history reset', async () => {
  const dir = tempDir('ashop-fix-c-batch-');
  const sample = await makeSample(dir);

  // run batch: registry-based op resolution must find layer.crop.
  const batchProject = path.join(dir, 'batch.ashop');
  ok(['init', '100', '100', '--project', batchProject]);
  const ops = path.join(dir, 'crop.ops.json');
  writeFileSync(ops, JSON.stringify({
    steps: [
      { op: 'layer.import', args: { file: sample, name: 'img', at: '0,0' } },
      { op: 'layer.crop', args: { layer: 'img', rect: '100,0,100,100' } },
    ],
  }));
  const run = ok(['run', ops, '--project', batchProject]);
  assert.deepEqual(run.steps.map((step) => step.op), ['layer.import', 'layer.crop']);
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', batchProject]).rgba, [0, 0, 255, 255]);

  // history: a commit before the crop still renders/restores the original.
  const historyProject = path.join(dir, 'history.ashop');
  ok(['init', '100', '100', '--project', historyProject]);
  ok(['layer', 'import', sample, '--name', 'img', '--at', '0,0', '--project', historyProject]);
  ok(['commit', '-m', 'before crop', '--project', historyProject]);
  ok(['layer', 'crop', 'img', '--rect', '100,0,100,100', '--project', historyProject]);
  ok(['commit', '-m', 'cropped', '--project', historyProject]);
  ok(['history', 'reset', 'HEAD~1', '--project', historyProject]);
  const restored = ok(['layer', 'info', 'img', '--project', historyProject]);
  assert.equal(restored.layer.content.width, 200);
  assert.equal(restored.layer.content.crop, undefined);
  assert.deepEqual(ok(['inspect', 'pixel', '--at', '10,10', '--project', historyProject]).rgba, [255, 0, 0, 255]);
});

test('layer.crop validates its inputs', async () => {
  const dir = tempDir('ashop-fix-c-errors-');
  const project = path.join(dir, 'errors.ashop');
  const sample = await makeSample(dir);
  ok(['init', '100', '100', '--project', project]);
  ok(['layer', 'import', sample, '--name', 'img', '--at', '0,0', '--project', project]);
  ok(['layer', 'fill', '--color', '#102030', '--name', 'bg', '--project', project]);

  assert.equal(fails(['layer', 'crop', 'img', '--project', project]).code, 'E_USAGE');
  assert.equal(fails(['layer', 'crop', 'img', '--rect', '500,500,10,10', '--project', project]).code, 'E_CROP_EMPTY');
  assert.equal(fails(['layer', 'crop', 'bg', '--rect', '0,0,10,10', '--project', project]).code, 'E_UNSUPPORTED');
  assert.equal(fails(['layer', 'crop', 'img', '--reset', '--project', project]).code, 'E_CROP_MISSING');
  assert.equal(fails(['layer', 'crop', 'img', '--rect', '0,0,10,10', '--reset', '--project', project]).code, 'E_USAGE');
  // A partial overlap is clamped to the content box instead of erroring.
  const clamped = ok(['layer', 'crop', 'img', '--rect', '50,50,500,500', '--project', project]);
  assert.deepEqual(clamped.crop, { x: 50, y: 50, width: 150, height: 50 });
});

// ---------------------------------------------------------------------------
// F-012 — daemon timeout PID hint
// ---------------------------------------------------------------------------

test('pid files round-trip and filter dead processes', () => {
  const key = `fix-c-pid-${process.pid}-${Date.now()}`;
  const file = pidFilePath(key);
  try {
    assert.equal(readPidFile(key), null);
    writePidFile(key, { pid: process.pid, project: 'C:/tmp/x.ashop' });
    const info = readPidFile(key);
    assert.equal(info.pid, process.pid);
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(99999999), false);
    assert.equal(removePidFile(key), true);
    assert.equal(readPidFile(key), null);
    assert.equal(removePidFile(key), false);
  } finally {
    removePidFile(key);
    assert.ok(file.length > 0);
  }
});

test('E_DAEMON_TIMEOUT hint names the live daemon PID and a cleanup command', async () => {
  const project = tempProject('ashop-fix-c-live-');
  const daemon = await fakeDaemon(project, { delayMs: 1500 });
  const key = daemonKey(project);
  writePidFile(key, { pid: process.pid, project });
  try {
    await assert.rejects(
      () => execViaDaemon(project, 'layer.fill', { color: '#123456' }, { timeoutMs: 300 }),
      (err) => {
        assert.equal(err.code, 'E_DAEMON_TIMEOUT');
        assert.match(err.hint, new RegExp(String(process.pid)));
        assert.match(err.hint, new RegExp(killCommand(process.pid).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(err.hint, /--no-daemon/);
        assert.equal(err.details.pid, process.pid);
        assert.equal(err.details.killCommand, killCommand(process.pid));
        assert.equal(err.details.pidFile, pidFilePath(key));
        return true;
      },
    );
  } finally {
    removePidFile(key);
    await daemon.close();
  }
});

test('a stale pid file falls back to the daemon.stop hint', async () => {
  const project = tempProject('ashop-fix-c-stale-');
  const daemon = await fakeDaemon(project, { delayMs: 1500 });
  const key = daemonKey(project);
  writePidFile(key, { pid: 99999999, project });
  try {
    await assert.rejects(
      () => execViaDaemon(project, 'layer.fill', { color: '#123456' }, { timeoutMs: 300 }),
      (err) => {
        assert.equal(err.code, 'E_DAEMON_TIMEOUT');
        assert.match(err.hint, /ashop daemon\.stop/);
        assert.doesNotMatch(err.hint, /Stop-Process|kill /);
        assert.equal(err.details.pid, null);
        assert.equal(err.details.stalePid, 99999999);
        return true;
      },
    );
  } finally {
    removePidFile(key);
    await daemon.close();
  }
});

test('a spawned daemon records its PID so timeouts can name it', async () => {
  const project = tempProject('ashop-fix-c-spawn-');
  ok(['init', '20', '20', '--project', project]);
  const key = daemonKey(project);
  const file = pidFilePath(key);
  let pid = null;
  try {
    // Let daemon.start go through the real daemon path.
    const started = cli(['daemon', 'start', '--project', project], { env: { ASHOP_NO_DAEMON: '0' } });
    assert.equal(started.code, 0, started.stderr);
    const info = readPidFile(key);
    assert.ok(info, `daemon.start must write ${file}`);
    assert.equal(info.project, path.resolve(project));
    assert.equal(info.pipe, pipePath(project));
    pid = info.pid;
    assert.equal(isProcessAlive(pid), true);
  } finally {
    stopDaemon(project);
    // Give the daemon a moment to exit, then make sure no orphan survives.
    if (pid) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && isProcessAlive(pid)) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (isProcessAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    removePidFile(key);
  }
});
