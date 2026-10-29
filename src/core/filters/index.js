/**
 * Filter registry. Same drop-in convention as adjustments:
 *
 *   { name, label, params, apply(raster, params) -> Raster }
 *
 * Filters are destructive by design: they run on a layer's content before the
 * layer transform, and are recorded in the layer's filter list for auditing.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AshopError } from '../errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, {name:string,label:string,params:object,apply:Function}>} */
export const FILTERS = new Map();

for (const file of readdirSync(here).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()) {
  const mod = await import(pathToFileURL(path.join(here, file)).href);
  const def = mod.default;
  if (!def || !def.name) continue;
  if (FILTERS.has(def.name)) throw new Error(`duplicate filter: ${def.name}`);
  FILTERS.set(def.name, def);
}

export function getFilter(name) {
  const def = FILTERS.get(name);
  if (!def) {
    throw new AshopError('E_FILTER_NOT_FOUND', `unknown filter: ${name}`, {
      hint: `known filters: ${[...FILTERS.keys()].join(', ')}`,
    });
  }
  return def;
}

export function filterCatalog() {
  return [...FILTERS.values()].map((d) => ({ name: d.name, label: d.label, params: d.params ?? {} }));
}
