/**
 * Layer style registry. A style receives the layer's already-masked content
 * raster (content units) and returns effects to draw *under* or *over* it:
 *
 *   { name, label, params, apply(content, params) -> { under?, over? } }
 *   where each effect is { raster, dx?, dy? } in content units.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AshopError } from '../errors.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {Map<string, {name:string,label:string,params:object,apply:Function}>} */
export const STYLES = new Map();

for (const file of readdirSync(here).filter((f) => f.endsWith('.js') && f !== 'index.js').sort()) {
  const mod = await import(pathToFileURL(path.join(here, file)).href);
  const def = mod.default;
  if (!def || !def.name) continue;
  if (STYLES.has(def.name)) throw new Error(`duplicate style: ${def.name}`);
  STYLES.set(def.name, def);
}

export function getStyle(name) {
  const def = STYLES.get(name);
  if (!def) {
    throw new AshopError('E_STYLE_NOT_FOUND', `unknown layer style: ${name}`, {
      hint: `known styles: ${[...STYLES.keys()].join(', ')}`,
    });
  }
  return def;
}

export function styleCatalog() {
  return [...STYLES.values()].map((d) => ({ name: d.name, label: d.label, params: d.params ?? {} }));
}
