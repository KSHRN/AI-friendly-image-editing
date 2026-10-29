/**
 * Project path resolution and the "current project" pointer.
 *
 * Resolution order:
 *   1. --project <path>
 *   2. --session <name>   -> <cwd>/.ashop/sessions/<name>.ashop
 *   3. ASHOP_PROJECT env
 *   4. current pointer    -> ~/.ashop/current.json
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AshopError } from '../core/errors.js';

export const BUNDLE_EXT = '.ashop';

export function ashopHome() {
  return process.env.ASHOP_HOME || path.join(os.homedir(), '.ashop');
}

export function pointerPath() {
  return path.join(ashopHome(), 'current.json');
}

export function sessionPath(cwd, name) {
  return path.join(cwd, '.ashop', 'sessions', `${name}${BUNDLE_EXT}`);
}

export async function readCurrentProject() {
  try {
    const raw = JSON.parse(await readFile(pointerPath(), 'utf8'));
    return raw.project ?? null;
  } catch {
    return null;
  }
}

export async function setCurrentProject(project) {
  await mkdir(ashopHome(), { recursive: true });
  await writeFile(pointerPath(), JSON.stringify({ project, at: new Date().toISOString() }));
}

export async function clearCurrentProject() {
  await setCurrentProject(null);
}

export async function resolveProjectPath({ project, session, cwd, requireExists = true } = {}) {
  let target = null;
  if (project) target = path.resolve(cwd, project);
  else if (session) target = sessionPath(cwd, session);
  else if (process.env.ASHOP_PROJECT) target = path.resolve(cwd, process.env.ASHOP_PROJECT);
  else {
    const current = await readCurrentProject();
    if (current) target = path.resolve(current);
  }
  if (!target) {
    throw new AshopError('E_NO_PROJECT', 'no project selected', {
      hint: 'run `ashop init 1200 1200` (or `ashop open path/to/proj.ashop`), or pass --project',
    });
  }
  if (requireExists && !existsSync(path.join(target, 'manifest.json'))) {
    throw new AshopError('E_PROJECT_NOT_FOUND', `no AShop project at ${target}`, {
      hint: 'run `ashop open <path>` first, or create one with `ashop init`',
    });
  }
  return target;
}
