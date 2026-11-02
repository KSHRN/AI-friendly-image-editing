/**
 * Paint model: one normalized description of "how a region is coloured".
 *
 * A paint is either a solid colour or a gradient. Everything that can be
 * filled or stroked (shapes, text outlines, future path layers) speaks this
 * model, so appearance features only ever have to be implemented once.
 *
 * Canonical forms:
 *
 *   { type: 'solid', color: '#rrggbb', opacity: 0..1 }
 *
 *   { type: 'linear-gradient', from: {x,y}, to: {x,y}, stops: [stop...], opacity }
 *   { type: 'radial-gradient', center: {x,y}, radius: number, stops: [stop...], opacity }
 *
 *   stop = { offset: 0..1, color: '#rrggbb', opacity: 0..1 }
 *
 * Gradient coordinates live in the object bounding box (`0..1` on both axes),
 * which is exactly SVG's default `objectBoundingBox` space. That keeps
 * gradients per-object like Illustrator, and means a shape can be resized
 * without touching its paint.
 *
 * `normalizePaint` accepts the friendly forms as well as the canonical ones:
 *
 *   '#ff0055'                       solid
 *   'rgb(255 0 85 / 50%)'           solid with alpha
 *   'linear-gradient(90deg, #ff0055 0%, #0000ff 100%)'
 *   'radial-gradient(circle at 30% 20%, #ffffff 0%, #000000 100%)'
 *   { type: 'linear-gradient', angle: 90, stops: [...] }   angle uses CSS degrees
 *   { type: 'linear-gradient', from: [0, 0], to: [1, 1], stops: [...] }
 *   { type: 'radial-gradient', center: [0.5, 0.5], radius: 0.6, stops: [...] }
 */

import { AshopError, fail } from './errors.js';
import { parseColor, colorToHex } from './raster.js';

export const PAINT_TYPES = ['solid', 'linear-gradient', 'radial-gradient'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Stable number formatting: no floating-point noise leaks into SVG output. */
export function fmtNumber(v, decimals = 4) {
  const f = 10 ** decimals;
  const n = Math.round(Number(v) * f) / f;
  return String(n === 0 ? 0 : n);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function point(value, fallback) {
  if (Array.isArray(value)) return { x: num(value[0], fallback.x), y: num(value[1], fallback.y) };
  if (value && typeof value === 'object') return { x: num(value.x, fallback.x), y: num(value.y, fallback.y) };
  return { x: fallback.x, y: fallback.y };
}

// ---------------------------------------------------------------------------
// Solid paint
// ---------------------------------------------------------------------------

function solidPaint(color, opacity = 1) {
  let rgba;
  try {
    rgba = parseColor(color);
  } catch (err) {
    fail('E_USAGE', `invalid paint colour: ${JSON.stringify(color)}`, {
      hint: 'use "#rgb", "#rrggbb", "#rrggbbaa", "r,g,b[,a]" or "rgb(…)/ rgba(…)"',
      cause: err,
    });
  }
  const alpha = (rgba[3] / 255) * clamp01(num(opacity, 1));
  return {
    type: 'solid',
    color: colorToHex([rgba[0], rgba[1], rgba[2]]),
    opacity: Math.round(alpha * 10000) / 10000,
  };
}

// ---------------------------------------------------------------------------
// Gradient geometry helpers (objectBoundingBox space)
// ---------------------------------------------------------------------------

/** CSS angle -> gradient line through the centre of the unit box. */
function lineFromAngle(degrees) {
  const rad = (degrees * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  // Half the projection length so the gradient spans the unit box (CSS rule).
  const half = (Math.abs(dx) + Math.abs(dy)) / 2;
  return {
    from: { x: 0.5 - dx * half, y: 0.5 - dy * half },
    to: { x: 0.5 + dx * half, y: 0.5 + dy * half },
  };
}

const SIDE_ANGLES = {
  'right': 90,
  'left': 270,
  'top': 0,
  'bottom': 180,
  'top right': 45,
  'right top': 45,
  'bottom right': 135,
  'right bottom': 135,
  'bottom left': 225,
  'left bottom': 225,
  'top left': 315,
  'left top': 315,
};

function angleFromKeyword(text) {
  const words = String(text).trim().toLowerCase().replace(/^to\s+/, '').replace(/\s+/g, ' ');
  const angle = SIDE_ANGLES[words];
  if (angle === undefined) {
    fail('E_USAGE', `unknown gradient direction: "${text}"`, {
      hint: 'use "to right", "to bottom right", "45deg" or an object {angle}',
    });
  }
  return angle;
}

function toDegrees(token) {
  const m = /^(-?[\d.]+)(deg|grad|rad|turn)$/i.exec(String(token).trim());
  if (!m) return null;
  const v = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'rad': return (v * 180) / Math.PI;
    case 'grad': return v * 0.9;
    case 'turn': return v * 360;
    default: return v;
  }
}

/** Split on commas that are not nested inside parentheses. */
function splitTopLevel(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Stops
// ---------------------------------------------------------------------------

function stopFrom(input, index) {
  if (typeof input === 'string') {
    const s = input.trim();
    // Trailing position: "… 40%", "… 0.4" (fraction), "… 40px" (px is accepted as %).
    const pos = /\s(-?\d+(?:\.\d+)?)(%|px)?$/.exec(s);
    if (pos) {
      const raw = Number(pos[1]);
      const offset = pos[2] === 'px' ? raw / 100 : raw > 1 && pos[2] !== '%' ? raw / 100 : pos[2] === '%' ? raw / 100 : raw;
      const colorText = s.slice(0, pos.index).trim();
      if (colorText) return stopWithColor(colorText, offset);
    }
    return stopWithColor(s, null);
  }
  if (Array.isArray(input)) {
    // [color, offset] is the CSS order; [offset, color] is accepted too.
    if (typeof input[0] === 'number') return stopWithColor(input[1], input[0]);
    return stopWithColor(input[0], input[1]);
  }
  if (input && typeof input === 'object') {
    const color = input.color ?? input.value ?? '#000000';
    const offset = input.offset ?? input.position ?? input.at ?? null;
    const opacity = input.opacity ?? input.stopOpacity ?? input['stop-opacity'] ?? 1;
    return stopWithColor(color, offset, opacity);
  }
  fail('E_USAGE', `invalid gradient stop at index ${index}`, {
    hint: 'use "#ff0055 0%" or {offset: 0, color: "#ff0055"}',
  });
}

function stopWithColor(colorInput, offsetInput, opacity = 1) {
  let rgba;
  try {
    rgba = parseColor(colorInput);
  } catch (err) {
    fail('E_USAGE', `invalid gradient stop colour: ${JSON.stringify(colorInput)}`, {
      hint: 'stops take colours such as "#ff0055 0%"',
      cause: err,
    });
  }
  const offset = offsetInput == null ? null : clamp01(num(offsetInput, 0));
  return {
    offset,
    color: colorToHex([rgba[0], rgba[1], rgba[2]]),
    opacity: Math.round((rgba[3] / 255) * clamp01(num(opacity, 1)) * 10000) / 10000,
  };
}

/** Fill in omitted offsets (first=0, last=1, the rest interpolated) and clamp. */
export function normalizeStops(input) {
  if (typeof input === 'string') input = splitTopLevel(input);
  if (!Array.isArray(input)) {
    fail('E_USAGE', 'gradient stops must be an array or a comma separated string', {
      hint: 'e.g. ["#ff0055 0%", "#0000ff 100%"]',
    });
  }
  const stops = input.map(stopFrom);
  if (stops.length < 2) {
    fail('E_USAGE', 'a gradient needs at least two stops', {
      hint: 'pass two colours, e.g. --fill "linear-gradient(90deg, #ff0055, #0000ff)"',
    });
  }
  if (stops[0].offset == null) stops[0].offset = 0;
  if (stops[stops.length - 1].offset == null) stops[stops.length - 1].offset = 1;
  for (let i = 0; i < stops.length;) {
    if (stops[i].offset != null) { i++; continue; }
    let j = i;
    while (j < stops.length && stops[j].offset == null) j++;
    const prev = stops[i - 1].offset;
    const next = stops[j].offset;
    const n = j - i + 1;
    for (let k = i; k < j; k++) stops[k].offset = prev + ((next - prev) * (k - i + 1)) / n;
    i = j;
  }
  let prev = 0;
  for (const stop of stops) {
    stop.offset = clamp01(stop.offset);
    if (stop.offset < prev) stop.offset = prev;
    prev = stop.offset;
  }
  return stops;
}

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

function linearGradient(input, opacity = 1) {
  let from;
  let to;
  if (input.from != null || input.to != null) {
    from = point(input.from, { x: 0, y: 0.5 });
    to = point(input.to, { x: 1, y: 0.5 });
  } else {
    const angle = input.angle != null
      ? num(input.angle, 180)
      : (typeof input.direction === 'string' ? angleFromKeyword(input.direction) : 180);
    ({ from, to } = lineFromAngle(angle));
  }
  if (from.x === to.x && from.y === to.y) {
    fail('E_USAGE', 'gradient from and to points are identical', { hint: 'give the gradient a direction' });
  }
  return {
    type: 'linear-gradient',
    from: { x: round4(from.x), y: round4(from.y) },
    to: { x: round4(to.x), y: round4(to.y) },
    stops: normalizeStops(input.stops),
    opacity: round4(clamp01(num(opacity, 1))),
  };
}

function radialGradient(input, opacity = 1) {
  const center = point(input.center ?? input.at, { x: 0.5, y: 0.5 });
  const radius = Math.max(0.0001, num(input.radius ?? input.r ?? 0.5, 0.5));
  return {
    type: 'radial-gradient',
    center: { x: round4(center.x), y: round4(center.y) },
    radius: round4(radius),
    stops: normalizeStops(input.stops),
    opacity: round4(clamp01(num(opacity, 1))),
  };
}

const round4 = (v) => {
  const n = Math.round(Number(v) * 10000) / 10000;
  return n === 0 ? 0 : n;
};

/** "linear-gradient(90deg, #f00 0%, #00f 100%)" -> canonical paint. */
export function parseCssGradient(text) {
  const m = /^(linear|radial)-gradient\s*\(([\s\S]*)\)\s*$/i.exec(String(text).trim());
  if (!m) fail('E_USAGE', `not a gradient: ${text}`, { hint: 'use linear-gradient(…) or radial-gradient(…)' });
  const kind = m[1].toLowerCase();
  const args = splitTopLevel(m[2]);
  if (args.length < 2) {
    fail('E_USAGE', `gradient needs at least two stops: ${text}`, {
      hint: 'e.g. linear-gradient(90deg, #ff0055 0%, #0000ff 100%)',
    });
  }

  if (kind === 'linear') {
    const [first, ...rest] = args;
    if (/^to\s+/i.test(first)) {
      const { from, to } = lineFromAngle(angleFromKeyword(first));
      return linearGradient({ from, to, stops: rest });
    }
    const degrees = toDegrees(first);
    if (degrees != null) {
      const { from, to } = lineFromAngle(degrees);
      return linearGradient({ from, to, stops: rest });
    }
    return linearGradient({ angle: 180, stops: args });
  }

  // radial: optional "[circle|ellipse] at <x> <y>" prefix.
  const first = args[0];
  const atMatch = /\bat\s+(-?[\d.]+)%?\s+(-?[\d.]+)%?/i.exec(first);
  const isConfig = /\b(circle|ellipse|at)\b/i.test(first) && (atMatch || /^(circle|ellipse|closest-side|closest-corner|farthest-side|farthest-corner)\b/i.test(first));
  if (isConfig) {
    const center = atMatch
      ? { x: normalizePosition(atMatch[1]), y: normalizePosition(atMatch[2]) }
      : undefined;
    const radiusMatch = /(?:circle|ellipse)\s+(-?[\d.]+)%?/i.exec(first);
    const radius = radiusMatch ? normalizePosition(radiusMatch[1]) : undefined;
    return radialGradient({ center, radius, stops: args.slice(1) });
  }
  return radialGradient({ stops: args });
}

/** "30%" or "0.3" -> 0.3; "30" is treated as 0.3 for gradient positions. */
function normalizePosition(text) {
  const raw = String(text).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return undefined;
  if (raw.endsWith('%')) return n / 100;
  return n > 1 ? n / 100 : n;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function inferType(input) {
  if (input.type) return String(input.type).toLowerCase();
  if (input.stops) return (input.center || input.radius || input.r) ? 'radial-gradient' : 'linear-gradient';
  return 'solid';
}

/**
 * Normalize any supported paint description.
 * @returns {object|null} canonical paint, or null for "no paint"
 */
export function normalizePaint(input) {
  if (input == null || input === false) return null;
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s || s === 'none') return null;
    if (/^(linear|radial)-gradient\s*\(/i.test(s)) return parseCssGradient(s);
    return solidPaint(s);
  }
  if (Array.isArray(input)) {
    fail('E_USAGE', 'a paint must be a colour string or an object', {
      hint: 'wrap multiple paints in an array only for --fills/--strokes',
    });
  }
  if (typeof input !== 'object') {
    fail('E_USAGE', `invalid paint: ${JSON.stringify(input)}`, { hint: 'use "#ff0055" or {"type":"linear-gradient",…}' });
  }
  const type = inferType(input);
  switch (type) {
    case 'solid':
    case 'color':
      return solidPaint(input.color ?? input.value ?? '#000000', input.opacity ?? 1);
    case 'linear-gradient':
    case 'linear':
      return linearGradient(input, input.opacity ?? 1);
    case 'radial-gradient':
    case 'radial':
      return radialGradient(input, input.opacity ?? 1);
    default:
      fail('E_USAGE', `unknown paint type: ${type}`, { hint: `use one of: ${PAINT_TYPES.join(', ')}` });
  }
}

/** Normalize a paint or an array of paints into a draw-order list (bottom first). */
export function normalizePaintList(input) {
  if (input == null || input === false) return [];
  if (Array.isArray(input)) return input.map(normalizePaint).filter(Boolean);
  const paint = normalizePaint(input);
  return paint ? [paint] : [];
}

// ---------------------------------------------------------------------------
// SVG emission
// ---------------------------------------------------------------------------

/**
 * Turn a paint into an SVG paint server reference plus the `<defs>` entry it
 * needs (gradients only).
 * @returns {{value: string, opacity: number, def: string|null}}
 */
export function paintToSvg(paint, id) {
  if (!paint) return { value: 'none', opacity: 1, def: null };
  if (paint.type === 'solid') return { value: paint.color, opacity: paint.opacity, def: null };

  const stops = paint.stops
    .map((stop) => {
      const opacity = stop.opacity < 1 ? ` stop-opacity="${fmtNumber(stop.opacity)}"` : '';
      return `<stop offset="${fmtNumber(stop.offset)}" stop-color="${stop.color}"${opacity}/>`;
    })
    .join('');

  if (paint.type === 'linear-gradient') {
    const def = `<linearGradient id="${id}" x1="${fmtNumber(paint.from.x)}" y1="${fmtNumber(paint.from.y)}" x2="${fmtNumber(paint.to.x)}" y2="${fmtNumber(paint.to.y)}">${stops}</linearGradient>`;
    return { value: `url(#${id})`, opacity: paint.opacity, def };
  }
  const def = `<radialGradient id="${id}" cx="${fmtNumber(paint.center.x)}" cy="${fmtNumber(paint.center.y)}" r="${fmtNumber(paint.radius)}">${stops}</radialGradient>`;
  return { value: `url(#${id})`, opacity: paint.opacity, def };
}

/**
 * Append the paint's `<defs>` entry (if any) and return the attributes that
 * reference it, e.g. ` fill="url(#p0)" fill-opacity="0.5"`.
 * @param {'fill'|'stroke'} property
 */
export function paintAttributes(property, paint, id, defs) {
  const { value, opacity, def } = paintToSvg(paint, id);
  if (def) defs.push(def);
  let attrs = ` ${property}="${value}"`;
  if (opacity < 1) attrs += ` ${property}-opacity="${fmtNumber(opacity)}"`;
  return attrs;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** Short human/agent readable description, used by shape.info and describe. */
export function paintSummary(paint) {
  if (!paint) return 'none';
  if (paint.type === 'solid') {
    return paint.opacity < 1 ? `solid ${paint.color} @${fmtNumber(paint.opacity)}` : `solid ${paint.color}`;
  }
  const stops = paint.stops.map((s) => `${s.color}@${Math.round(s.offset * 100)}%`).join(' ');
  return `${paint.type} ${paint.stops.length} stops (${stops})`;
}

export function paintCatalog() {
  return {
    types: PAINT_TYPES,
    solid: { color: 'colour string', opacity: '0..1' },
    'linear-gradient': {
      from: '[x, y] in object bounding box (0..1)',
      to: '[x, y] in object bounding box (0..1)',
      angle: 'CSS degrees (0 = to top, 90 = to right); alternative to from/to',
      stops: '[{offset: 0..1, color: "#rrggbb", opacity: 0..1}]',
    },
    'radial-gradient': {
      center: '[x, y] in object bounding box (0..1)',
      radius: 'number, fraction of the bounding box (default 0.5)',
      stops: 'as above',
    },
    strings: [
      '#ff0055',
      'rgb(255 0 85 / 50%)',
      'linear-gradient(90deg, #ff0055 0%, #0000ff 100%)',
      'radial-gradient(circle at 30% 20%, #ffffff 0%, #000000 100%)',
    ],
  };
}

export { AshopError };
