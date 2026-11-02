/**
 * Shape content model (version 2).
 *
 * A shape layer is a box of vector objects drawn bottom-to-top. Each object
 * has geometry plus a *paint stack*: several fills underneath, several strokes
 * on top — the Illustrator appearance order, not a single `fill` + `stroke`.
 *
 * v1 content stored `{ fill: '#ff0055', stroke: { color, width } }`. Those
 * documents keep rendering: `normalizeShapeContent` upgrades them in memory
 * to the v2 stacks, and commands write v2 from now on. Normalization is
 * non-destructive and idempotent, so old projects never need a migration pass.
 *
 * v2 content:
 *
 *   {
 *     type: 'shape', version: 2, width, height,
 *     fills:   [paint, ...],      // layer defaults, bottom first
 *     strokes: [stroke, ...],     // layer defaults, bottom first
 *     shapes: [
 *       {
 *         kind: 'rect' | 'ellipse' | 'polygon' | 'path',
 *         // geometry fields...
 *         fills?:   [paint],        // per-object override of the layer stack
 *         strokes?: [stroke],
 *         opacity?: 0..1,           // per-object opacity (group opacity)
 *         transform?: [a,b,c,d,e,f],// per-object affine, content units
 *         fillRule?: 'nonzero' | 'evenodd',
 *       },
 *     ],
 *   }
 *
 * stroke = { paint, width, lineCap, lineJoin, miterLimit, dash, dashOffset }
 */

import { fail } from './errors.js';
import { normalizePaint, normalizePaintList, paintSummary } from './paint.js';

export const SHAPE_KINDS = ['rect', 'ellipse', 'polygon', 'path'];
export const SHAPE_CONTENT_VERSION = 2;

const LINE_CAPS = ['butt', 'round', 'square'];
const LINE_JOINS = ['miter', 'round', 'bevel'];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const fmt = (v) => {
  const n = Math.round(Number(v) * 10000) / 10000;
  return String(n);
};

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Stroke normalization
// ---------------------------------------------------------------------------

function parseDash(input) {
  if (input == null || input === false || input === 'none' || input === '') return null;
  let values;
  if (Array.isArray(input)) values = input;
  else values = String(input).split(/[\s,]+/).filter(Boolean);
  const dash = values.map((v) => Number(String(v).replace(/px$/i, ''))).filter((v) => Number.isFinite(v) && v >= 0);
  if (dash.length === 0 || dash.every((v) => v === 0)) return null;
  return dash;
}

/**
 * Normalize a stroke description.
 * Accepts a colour string, `{color, width}`, `{paint, width, …}` or the
 * canonical form. Returns null when there is nothing to stroke.
 */
export function normalizeStroke(input, defaults = {}) {
  if (input == null || input === false || input === 'none') return null;
  if (typeof input === 'string') input = { color: input };
  if (typeof input !== 'object' || Array.isArray(input)) {
    fail('E_USAGE', `invalid stroke: ${JSON.stringify(input)}`, {
      hint: 'use "--stroke \'#ffffff\' --stroke-width 3" or a JSON object',
    });
  }
  const width = num(input.width ?? input['stroke-width'] ?? defaults.width, 0);
  const opacity = clamp01(num(input.opacity ?? defaults.opacity, 1));
  const paint = normalizePaint(input.paint ?? input.color ?? input.fill ?? defaults.color ?? '#000000');
  if (!paint || !(width > 0)) return null;
  paint.opacity = Math.round(paint.opacity * opacity * 10000) / 10000;

  const lineCap = String(input.lineCap ?? input.linecap ?? input['stroke-linecap'] ?? input.cap ?? defaults.lineCap ?? 'butt').toLowerCase();
  if (!LINE_CAPS.includes(lineCap)) {
    fail('E_USAGE', `invalid line cap: ${lineCap}`, { hint: `use one of: ${LINE_CAPS.join(', ')}` });
  }
  const lineJoin = String(input.lineJoin ?? input.linejoin ?? input['stroke-linejoin'] ?? input.join ?? defaults.lineJoin ?? 'miter').toLowerCase();
  if (!LINE_JOINS.includes(lineJoin)) {
    fail('E_USAGE', `invalid line join: ${lineJoin}`, { hint: `use one of: ${LINE_JOINS.join(', ')}` });
  }

  return {
    paint,
    width,
    lineCap,
    lineJoin,
    miterLimit: num(input.miterLimit ?? input['stroke-miterlimit'], defaults.miterLimit ?? 4),
    dash: parseDash(input.dash ?? input.dashArray ?? input['stroke-dasharray']),
    dashOffset: num(input.dashOffset ?? input['stroke-dashoffset'], 0),
  };
}

export function normalizeStrokeList(input, defaults = {}) {
  if (input == null || input === false) return [];
  const list = Array.isArray(input) ? input : [input];
  return list.map((item) => normalizeStroke(item, defaults)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Shape normalization
// ---------------------------------------------------------------------------

/** Normalize one vector object, upgrading legacy `fill`/`stroke` fields. */
export function normalizeShape(shape) {
  if (!shape || typeof shape !== 'object') fail('E_USAGE', 'invalid shape object');
  const kind = String(shape.kind ?? '').toLowerCase();
  if (!SHAPE_KINDS.includes(kind)) {
    fail('E_USAGE', `unknown shape kind: ${shape.kind}`, { hint: `use ${SHAPE_KINDS.join(', ')}` });
  }
  const out = { ...shape, kind };

  if (shape.fill !== undefined || shape.fills !== undefined) {
    out.fills = normalizePaintList(shape.fills !== undefined ? shape.fills : shape.fill);
    delete out.fill;
  }
  if (shape.stroke !== undefined || shape.strokes !== undefined) {
    out.strokes = normalizeStrokeList(shape.strokes !== undefined ? shape.strokes : shape.stroke);
    delete out.stroke;
  }
  if (shape.opacity !== undefined) out.opacity = clamp01(num(shape.opacity, 1));
  if (shape.transform != null) {
    if (!Array.isArray(shape.transform) || shape.transform.length !== 6 || shape.transform.some((v) => !Number.isFinite(Number(v)))) {
      fail('E_USAGE', 'shape transform must be a 6-number affine array', { hint: '[a, b, c, d, e, f]' });
    }
    out.transform = shape.transform.map(Number);
  }
  if (shape.fillRule != null) {
    const rule = String(shape.fillRule).toLowerCase();
    if (rule !== 'nonzero' && rule !== 'evenodd') {
      fail('E_USAGE', `invalid fill rule: ${shape.fillRule}`, { hint: 'use nonzero or evenodd' });
    }
    out.fillRule = rule;
  }
  return out;
}

/**
 * Upgrade shape content to the version 2 paint stacks.
 * Returns the input untouched when it is already canonical (so render caching
 * and hashing stay stable).
 */
export function normalizeShapeContent(content) {
  if (!content || typeof content !== 'object') fail('E_USAGE', 'shape content must be an object');
  const shapes = Array.isArray(content.shapes) ? content.shapes : [];
  const canonical = content.version === SHAPE_CONTENT_VERSION
    && Array.isArray(content.fills)
    && Array.isArray(content.strokes)
    && !('fill' in content)
    && !('stroke' in content)
    && shapes.every((s) => s && !('fill' in s) && !('stroke' in s));
  if (canonical) return content;

  const out = { ...content, version: SHAPE_CONTENT_VERSION };
  out.fills = content.fills !== undefined ? normalizePaintList(content.fills) : normalizePaintList(content.fill);
  out.strokes = content.strokes !== undefined ? normalizeStrokeList(content.strokes) : normalizeStrokeList(content.stroke);
  delete out.fill;
  delete out.stroke;
  out.shapes = shapes.map(normalizeShape);
  return out;
}

/** Default paint stack for a new shape layer (kept for v1 compatibility). */
export function defaultFills(fill) {
  return normalizePaintList(fill === undefined ? '#ff0055' : fill);
}

// ---------------------------------------------------------------------------
// SVG geometry
// ---------------------------------------------------------------------------

function transformAttr(shape) {
  return shape.transform ? ` transform="matrix(${shape.transform.map(fmt).join(' ')})"` : '';
}

function fillRuleAttr(shape) {
  return shape.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
}

/**
 * Render one object's geometry as an SVG element, with `attrs` appended.
 * Paint is intentionally not baked in here: the caller emits one element per
 * paint in the stack, which is what makes multiple fills/strokes possible.
 */
export function shapeGeometryElement(shape, attrs = '') {
  switch (shape.kind) {
    case 'rect': {
      const radius = num(shape.radius, 0);
      const rx = radius > 0 ? ` rx="${fmt(radius)}" ry="${fmt(radius)}"` : '';
      return `<rect x="${fmt(shape.x)}" y="${fmt(shape.y)}" width="${fmt(shape.width)}" height="${fmt(shape.height)}"${rx}${attrs}/>`;
    }
    case 'ellipse':
      return `<ellipse cx="${fmt(shape.cx)}" cy="${fmt(shape.cy)}" rx="${fmt(shape.rx)}" ry="${fmt(shape.ry)}"${attrs}/>`;
    case 'polygon': {
      const points = (shape.points ?? [])
        .map((p) => `${fmt(Array.isArray(p) ? p[0] : p.x)},${fmt(Array.isArray(p) ? p[1] : p.y)}`)
        .join(' ');
      return `<polygon points="${points}"${fillRuleAttr(shape)}${attrs}/>`;
    }
    case 'path':
      return `<path d="${escapeAttr(shape.d ?? '')}"${fillRuleAttr(shape)}${attrs}/>`;
    default:
      fail('E_USAGE', `unknown shape kind: ${shape.kind}`, { hint: `use ${SHAPE_KINDS.join(', ')}` });
  }
}

/** Wrap a sequence of element strings in a per-object group when needed. */
export function wrapShapeElements(shape, elements) {
  if (elements.length === 0) return '';
  const opacity = shape.opacity != null && shape.opacity < 1 ? ` opacity="${fmt(shape.opacity)}"` : '';
  const transform = transformAttr(shape);
  if (!opacity && !transform) return elements.join('');
  return `<g${opacity}${transform}>${elements.join('')}</g>`;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export function strokeSummary(stroke) {
  if (!stroke) return 'none';
  const dash = stroke.dash ? ` dash=${stroke.dash.join(',')}` : '';
  return `stroke ${paintSummary(stroke.paint)} width=${fmt(stroke.width)} ${stroke.lineJoin}/${stroke.lineCap}${dash}`;
}

/** Machine-readable description used by `shape.info`. */
export function shapeContentSummary(content) {
  const c = normalizeShapeContent(content);
  return {
    version: c.version,
    width: c.width,
    height: c.height,
    fills: c.fills.map(paintSummary),
    strokes: c.strokes.map(strokeSummary),
    shapes: c.shapes.map((shape, index) => ({
      index,
      kind: shape.kind,
      fills: (shape.fills ?? c.fills).map(paintSummary),
      strokes: (shape.strokes ?? c.strokes).map(strokeSummary),
      opacity: shape.opacity ?? 1,
      transform: shape.transform ?? null,
      fillRule: shape.fillRule ?? 'nonzero',
    })),
  };
}
