/**
 * Adjustment registry.
 *
 * Drop a new `*.js` file in this directory exporting a default object:
 *
 *   { name, label, params, create(params) -> { map(r, g, b, out) } }
 *
 * and it becomes available as `<name>` for `ashop adjust add <name>` with no
 * other wiring. That is the intended extension point for new colour maths.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AshopError } from '../errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, {name:string,label:string,params:object,create:Function}>} */
export const ADJUSTMENTS = new Map();

const files = readdirSync(here)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .sort();

for (const file of files) {
  const mod = await import(pathToFileURL(path.join(here, file)).href);
  const def = mod.default;
  if (!def || !def.name) continue;
  if (ADJUSTMENTS.has(def.name)) throw new Error(`duplicate adjustment: ${def.name}`);
  ADJUSTMENTS.set(def.name, def);
}

export function getAdjustment(name) {
  const def = ADJUSTMENTS.get(name);
  if (!def) {
    throw new AshopError('E_ADJUSTMENT_NOT_FOUND', `unknown adjustment: ${name}`, {
      hint: `known adjustments: ${[...ADJUSTMENTS.keys()].join(', ')}`,
    });
  }
  return def;
}

export function adjustmentNames() {
  return [...ADJUSTMENTS.keys()];
}

/** Serialisable metadata for `ashop describe` / `ashop schema`. */
export function adjustmentCatalog() {
  return [...ADJUSTMENTS.values()].map((d) => ({
    name: d.name,
    label: d.label,
    params: d.params ?? {},
  }));
}
