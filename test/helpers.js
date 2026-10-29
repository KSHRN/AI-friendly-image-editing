import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const BIN = path.join(ROOT, 'bin', 'ashop.js');

export function tempDir(prefix = 'ashop-test-') {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run the CLI. Returns parsed JSON plus raw streams.
 * @param {string[]} args
 * @param {{cwd?: string, env?: object}} [opts]
 */
export function cli(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env: { ...process.env, ASHOP_NO_DAEMON: '1', ...(opts.env ?? {}) },
    timeout: 180000,
  });
  let json = null;
  for (const stream of [res.stdout, res.stderr]) {
    try {
      json = JSON.parse(stream);
      break;
    } catch {
      // not JSON (help output)
    }
  }
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

export function ok(args, opts) {
  const res = cli(args, opts);
  if (res.code !== 0 || !res.json?.ok) {
    throw new Error(`CLI failed: ashop ${args.join(' ')}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  return res.json.data;
}

export function fails(args, opts) {
  const res = cli(args, opts);
  if (res.code === 0 || res.json?.ok) throw new Error(`expected failure: ashop ${args.join(' ')}`);
  return res.json.error;
}

export function ensureDir(...parts) {
  const dir = path.join(...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
