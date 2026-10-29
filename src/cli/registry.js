/**
 * Command registry: every module in `commands/` may export one command object
 * or an array of them. Dropping a new file in this directory is all it takes
 * to add a CLI command (the same convention as filters/adjustments/styles).
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let cache = null;

export async function loadCommands() {
  if (cache) return cache;
  const map = new Map();
  const list = [];
  const files = readdirSync(path.join(here, 'commands'))
    .filter((f) => f.endsWith('.js'))
    .sort();
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(here, 'commands', file)).href);
    const defs = Array.isArray(mod.default) ? mod.default : [mod.default];
    for (const def of defs) {
      if (!def || !def.name) continue;
      const entry = { ...def, file };
      if (map.has(def.name)) throw new Error(`duplicate command: ${def.name}`);
      map.set(def.name, entry);
      list.push(entry);
      for (const alias of def.aliases ?? []) {
        if (map.has(alias)) throw new Error(`duplicate command alias: ${alias}`);
        map.set(alias, entry);
      }
    }
  }
  cache = { map, list };
  return cache;
}

/** Longest-prefix resolution: "layer import" and "layer.import" both work. */
export function resolveCommand(tokens, map) {
  for (let k = Math.min(3, tokens.length); k >= 1; k--) {
    const candidate = tokens.slice(0, k).join('.');
    if (map.has(candidate)) {
      return { command: map.get(candidate), used: k };
    }
  }
  return null;
}

export function commandCatalog(list) {
  return list.map((c) => ({
    name: c.name,
    summary: c.summary ?? '',
    aliases: c.aliases ?? [],
    params: c.params ?? {},
    examples: c.examples ?? [],
    mutates: c.mutates !== false,
    needsSession: c.needsSession !== false,
  }));
}
