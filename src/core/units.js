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

/** Parse "x,y" into a point. */
export function parsePoint(value) {
  if (Array.isArray(value)) return { x: Number(value[0]), y: Number(value[1]) };
  const parts = String(value).trim().split(/[, ]+/).map(Number);
  if (parts.length < 2 || parts.some((v) => !Number.isFinite(v))) {
    throw new AshopError('E_USAGE', `not a point: ${value}`, { hint: 'use "x,y", e.g. "120,40"' });
  }
  return { x: parts[0], y: parts[1] };
}

/** Parse "x,y,w,h" (or an object) into a rect. */
export function parseRect(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { x, y, width, height, w, h } = value;
    return { x: Number(x), y: Number(y), width: Number(width ?? w), height: Number(height ?? h) };
  }
  const parts = String(value).trim().split(/[, ]+/).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new AshopError('E_USAGE', `not a rect: ${value}`, { hint: 'use "x,y,w,h", e.g. "10,10,400,300"' });
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

/** Parse "x1,y1 x2,y2 ..." into a list of points. */
export function parsePolygon(value) {
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
  throw new AshopError('E_USAGE', `not a boolean: ${value}`);
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
