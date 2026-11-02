/**
 * Units and small geometry helpers shared by CLI parsing and the engine.
 * Keeping them in one place means "12px", "50%", "0.5" and "12" never mean
 * different things in different commands.
 */

import { AshopError } from './errors.js';

/** Parse "12px" | "12" | "50%" (of `base`) | "0.5" into pixels. */
export function parseLength(value, base, { allowPercent = true } = {}) {
  if (typeof value === 'number') return value;
  if (value == null) return value;
  const s = String(value).trim();
  const m = /^(-?\d+(?:\.\d+)?)(px|%|em)?$/.exec(s);
  if (!m) throw new AshopError('E_USAGE', `not a length: ${value}`, { hint: 'examples: 12, 12px, 50%' });
  const n = Number(m[1]);
  switch (m[2]) {
    case '%':
      if (!allowPercent || base == null) throw new AshopError('E_USAGE', `percentage length needs a base: ${value}`);
      return (n / 100) * base;
    case 'em':
      throw new AshopError('E_USAGE', 'em units are not supported; use px or %');
    default:
      return n;
  }
}

/**
 * Parse "x,y" | [x, y] | {x, y} into a point.
 *
 * The object/array forms matter for the batch runner: an ops file is JSON, so
 * a point there is naturally a list, and it must mean exactly what the CLI
 * means by "x,y".
 */
export function parsePoint(value) {
  if (Array.isArray(value)) {
    const [x, y] = value.map(Number);
    if (value.length !== 2 || !Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AshopError('E_USAGE', `not a point: ${JSON.stringify(value)}`, { hint: 'use [x, y], e.g. [120, 40]' });
    }
    return { x, y };
  }
  if (value && typeof value === 'object') {
    const x = Number(value.x);
    const y = Number(value.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AshopError('E_USAGE', `not a point: ${JSON.stringify(value)}`, { hint: 'use {"x": 120, "y": 40}' });
    }
    return { x, y };
  }
  const parts = String(value).trim().split(/[, ]+/).map(Number);
  if (parts.length < 2 || parts.some((v) => !Number.isFinite(v))) {
    throw new AshopError('E_USAGE', `not a point: ${value}`, { hint: 'use "x,y", e.g. "120,40"' });
  }
  return { x: parts[0], y: parts[1] };
}

/** Parse "x,y,w,h" | [x, y, w, h] | object into a rect. */
export function parseRect(value) {
  if (Array.isArray(value)) {
    const parts = value.map(Number);
    if (value.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
      throw new AshopError('E_USAGE', `not a rect: ${JSON.stringify(value)}`, { hint: 'use [x, y, w, h], e.g. [10, 10, 400, 300]' });
    }
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  if (value && typeof value === 'object') {
    const { x, y, width, height, w, h } = value;
    const rect = { x: Number(x), y: Number(y), width: Number(width ?? w), height: Number(height ?? h) };
    if (Object.values(rect).some((v) => !Number.isFinite(v))) {
      throw new AshopError('E_USAGE', `not a rect: ${JSON.stringify(value)}`, { hint: 'use {"x": 10, "y": 10, "width": 400, "height": 300}' });
    }
    return rect;
  }
  const parts = String(value).trim().split(/[, ]+/).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new AshopError('E_USAGE', `not a rect: ${value}`, { hint: 'use "x,y,w,h", e.g. "10,10,400,300"' });
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/**
 * Parse "x1,y1 x2,y2 ..." | [[x1,y1],[x2,y2],...] | [{x,y},...] into points.
 */
export function parsePolygon(value) {
  if (Array.isArray(value)) {
    const pts = value.map((pair) => parsePoint(pair));
    if (pts.length < 3) throw new AshopError('E_USAGE', 'a polygon needs at least 3 points');
    return pts;
  }
  const pts = String(value).trim().split(/\s+/).filter(Boolean).map((pair) => {
    const [x, y] = pair.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new AshopError('E_USAGE', `not a point: ${pair}`, { hint: 'use a list like "0,0 100,0 50,80"' });
    }
    return { x, y };
  });
  if (pts.length < 3) throw new AshopError('E_USAGE', 'a polygon needs at least 3 points');
  return pts;
}

/** JSON argument parsing with a friendly error. */
export function parseJson(value, what = 'value') {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new AshopError('E_USAGE', `invalid JSON for ${what}`, { hint: err.message });
  }
}

export function parseBool(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  if (['false', 'no', '0', 'off'].includes(s)) return false;
  throw new AshopError('E_USAGE', `not a boolean: ${value}`, { hint: 'use true or false' });
}

/** Clamp helper. */
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Round to a fixed number of decimals, for stable JSON output. */
export const round = (v, d = 4) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};

/** Format an RGBA array as hex. */
export function rgbaToHex([r, g, b, a = 255]) {
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return a === 255 ? `#${h(r)}${h(g)}${h(b)}` : `#${h(r)}${h(g)}${h(b)}${h(a)}`;
}
