/**
 * Daemon pid files.
 *
 * The client that spawns a detached daemon records its PID under the OS temp
 * directory, keyed like the daemon pipe. A later CLI invocation that hits
 * E_DAEMON_TIMEOUT can then tell the caller exactly which process is stuck and
 * print a copy-pasteable cleanup command instead of leaving an orphan behind.
 *
 * The file is only a hint: a stale entry (idle shutdown, crash, PID reuse) is
 * filtered with `process.kill(pid, 0)` before it is ever mentioned.
 */

import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

export function pidFilePath(key) {
  return path.join(os.tmpdir(), `ashop-${key}.pid`);
}

/** Best-effort write; never let a read-only temp dir break a command. */
export function writePidFile(key, info = {}) {
  const file = pidFilePath(key);
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, ...info, updatedAt: new Date().toISOString() }));
    return file;
  } catch {
    return null;
  }
}

export function readPidFile(key) {
  try {
    const parsed = JSON.parse(readFileSync(pidFilePath(key), 'utf8'));
    if (!Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removePidFile(key) {
  try {
    unlinkSync(pidFilePath(key));
    return true;
  } catch {
    return false;
  }
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM still means the process exists, it just is not ours to signal.
    return err?.code === 'EPERM';
  }
}

/** Copy-pasteable cleanup command for the caller's platform. */
export function killCommand(pid, platform = process.platform) {
  return platform === 'win32' ? `Stop-Process -Id ${pid} -Force` : `kill ${pid}`;
}

/**
 * Build the E_DAEMON_TIMEOUT hint from a pid-file record.
 * Returns { hint, details } with pid/pidFile/killCommand when the daemon is
 * provably still alive, and a plain daemon.stop fallback otherwise.
 */
export function daemonTimeoutHint(project, key, info = null) {
  const stop = `ashop daemon.stop --project "${project}"`;
  const file = pidFilePath(key);
  const pid = info?.pid ?? null;
  if (pid && isProcessAlive(pid)) {
    const kill = killCommand(pid);
    return {
      hint: `the project daemon is still running as PID ${pid}; stop it with \`${kill}\` (or \`${stop}\`), then retry with --no-daemon`,
      details: { pid, pidFile: file, killCommand: kill, project },
    };
  }
  return {
    hint: `run \`${stop}\`, then retry with --no-daemon`,
    details: { pid: null, ...(pid ? { stalePid: pid } : {}), pidFile: file, project },
  };
}
