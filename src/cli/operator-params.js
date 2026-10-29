/**
 * Operator parameter collection for `filter.add` / `style.add` / `adjust.add`.
 *
 * These commands accept any `--<param>` that the operator itself declares, so
 * adding a new filter or adjustment automatically gets a working CLI surface
 * with correct types and help.
 */

import { AshopError, fail } from '../core/errors.js';
import { parsePoint, parseRect, parseJson, parseBool } from '../core/units.js';

export function collectOperatorParams(def, extra = {}, { allowPointRect = false } = {}) {
  const spec = def.params ?? {};
  const out = {};
  const known = Object.keys(spec);
  const findKey = (key) => {
    if (spec[key]) return key;
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return spec[camel] ? camel : null;
  };
  for (const [rawKey, raw] of Object.entries(extra)) {
    if (rawKey === 'params') {
      const parsed = parseJson(raw, 'params');
      if (!parsed || typeof parsed !== 'object') fail('E_USAGE', '--params must be a JSON object');
      for (const [k, v] of Object.entries(parsed)) {
        const resolved = findKey(k);
        if (!resolved) fail('E_USAGE', `unknown parameter for ${def.name}: ${k}`, { hint: `known: ${known.join(', ') || '(none)'}` });
        out[resolved] = v;
      }
      continue;
    }
    if (rawKey === 'help') continue;
    const key = findKey(rawKey);
    if (!key) {
      const near = known.filter((k) => k.toLowerCase().includes(rawKey.toLowerCase().split('-')[0]));
      throw new AshopError('E_USAGE', `unknown parameter for ${def.name}: --${rawKey}`, {
        hint: near.length ? `did you mean: ${near.map((k) => '--' + kebab(k)).join(', ')}?` : `known: ${known.map(kebab).join(', ') || '(none)'}`,
      });
    }
    out[key] = coerceParam(raw, spec[key], key, allowPointRect);
  }
  return out;
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
}

function coerceParam(raw, spec, name, allowPointRect) {
  const type = spec.type ?? 'string';
  switch (type) {
    case 'number': {
      const v = Number(String(raw).trim().replace(/px$/i, ''));
      if (!Number.isFinite(v)) fail('E_USAGE', `${name} must be a number`);
      return v;
    }
    case 'integer': {
      const v = Number(raw);
      if (!Number.isInteger(v)) fail('E_USAGE', `${name} must be an integer`);
      return v;
    }
    case 'boolean':
      return parseBool(raw);
    case 'json':
    case 'curve':
    case 'vec3':
      return parseJson(raw, name);
    case 'point':
      return parsePoint(raw);
    case 'rect':
      return parseRect(raw);
    case 'enum': {
      const allowed = spec.values ?? [];
      if (!allowed.includes(String(raw))) fail('E_USAGE', `${name} must be one of: ${allowed.join(', ')}`);
      return String(raw);
    }
    case 'color':
      return String(raw);
    default:
      if (allowPointRect && typeof raw === 'string' && raw.includes(',')) return raw;
      return String(raw);
  }
}
