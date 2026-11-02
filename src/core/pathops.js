/**
 * Path booleans — the "pathfinder".
 *
 * Two shape layers are flattened to closed polygons in canvas space, combined
 * with `polygon-clipping`, and written back as one polygonal path layer.
 *
 * Design notes:
 *  - Curves are chord-approximated by the same adaptive flattener that the
 *    selection/mask rasteriser uses, with a fixed default tolerance (0.2
 *    content units). The result is therefore polygonal by construction; pass a
 *    smaller tolerance when a result must stay visually smooth.
 *  - Booleans happen in *canvas* space, so layers with different transforms
 *    (position, scale, rotation) compose correctly. The output layer carries
 *    the result's bounding box as its transform, keeping content coordinates
 *    small and gradients per-object sensible.
 *  - Ring nesting follows the even-odd rule: a ring inside an outer ring
 *    becomes a hole (so compound paths with holes survive a boolean).
 *  - Coordinates are rounded to 1/1000 px before clipping. That, plus a fixed
 *    library version, keeps repeated runs byte-identical.
 */

import polygonClipping from 'polygon-clipping';
import { flattenPath } from './rasterize.js';
import { normalizeShapeContent } from './shapes.js';
import { layerMatrix, multiply, apply } from './matrix.js';
import { AshopError, fail } from './errors.js';

export const PATH_BOOLEAN_OPS = ['unite', 'subtract', 'intersect', 'exclude'];

const OPS = {
  unite: 'union',
  subtract: 'difference',
  intersect: 'intersection',
  exclude: 'xor',
};

const PRECISION = 1000;

function round(v) {
  return Math.round(Number(v) * PRECISION) / PRECISION;
}

function fmt(v) {
  const n = round(v);
  return String(n === 0 ? 0 : n);
}

// ---------------------------------------------------------------------------
// Shape geometry -> rings
// ---------------------------------------------------------------------------

function roundedRectPath(shape) {
  const x = Number(shape.x) || 0;
  const y = Number(shape.y) || 0;
  const w = Math.max(0, Number(shape.width) || 0);
  const h = Math.max(0, Number(shape.height) || 0);
  const r = Math.max(0, Math.min(Number(shape.radius) || 0, w / 2, h / 2));
  if (r <= 0) return `M${x} ${y} H${x + w} V${y + h} H${x} Z`;
  return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r}`
    + ` V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h}`
    + ` H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r}`
    + ` V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

function ellipsePath(shape) {
  const cx = Number(shape.cx) || 0;
  const cy = Number(shape.cy) || 0;
  const rx = Math.max(0, Number(shape.rx) || 0);
  const ry = Math.max(0, Number(shape.ry) || 0);
  return `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;
}

function polygonPath(shape) {
  const points = (shape.points ?? []).map((p) => (Array.isArray(p) ? p : [p.x, p.y]));
  if (points.length < 3) return '';
  const [first, ...rest] = points;
  return `M${first[0]} ${first[1]} ` + rest.map((p) => `L${p[0]} ${p[1]}`).join(' ') + ' Z';
}

/** SVG path data for one vector object, in its local content space. */
export function shapePathData(shape) {
  switch (shape.kind) {
    case 'rect': return roundedRectPath(shape);
    case 'ellipse': return ellipsePath(shape);
    case 'polygon': return polygonPath(shape);
    case 'path': return String(shape.d ?? '');
    default: return '';
  }
}

function ensureRing(points) {
  const ring = [];
  for (const point of points) {
    const x = round(point.x);
    const y = round(point.y);
    const last = ring[ring.length - 1];
    if (last && last[0] === x && last[1] === y) continue;
    ring.push([x, y]);
  }
  if (ring.length < 3) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring.length >= 4 ? ring : null;
}

/**
 * Flatten a shape layer to closed rings in canvas space.
 * @returns {number[][][]} rings of [x, y] pairs
 */
export function shapeToPolygons(layer, { tolerance = 0.2 } = {}) {
  const content = normalizeShapeContent(layer.content);
  const layerM = layerMatrix(layer.transform, content.width, content.height);
  const rings = [];
  for (const shape of content.shapes) {
    const matrix = shape.transform ? multiply(layerM, shape.transform) : layerM;
    const d = shapePathData(shape);
    if (!d) continue;
    for (const contour of flattenPath(d, tolerance)) {
      const ring = ensureRing(contour.map((p) => apply(matrix, p.x, p.y)));
      if (ring) rings.push(ring);
    }
  }
  return rings;
}

// ---------------------------------------------------------------------------
// Ring nesting
// ---------------------------------------------------------------------------

function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return sum / 2;
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = (yi > y) !== (yj > y);
    if (crosses && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Group rings into polygons with holes using even-odd nesting.
 * @param {number[][][]} rings
 * @returns {number[][][][]} MultiPolygon
 */
export function ringsToMultiPolygon(rings) {
  const items = rings
    .filter((ring) => ring.length >= 4)
    .map((ring) => ({ ring, area: Math.abs(ringArea(ring)), depth: 0, parent: null, holes: [] }))
    .filter((item) => item.area > 1e-9);

  for (const item of items) {
    let depth = 0;
    let parent = null;
    let parentArea = Infinity;
    for (const other of items) {
      if (other === item) continue;
      if (pointInRing(item.ring[0], other.ring)) {
        depth++;
        if (other.area < parentArea) {
          parentArea = other.area;
          parent = other;
        }
      }
    }
    item.depth = depth;
    item.parent = parent;
  }

  const outers = items.filter((item) => item.depth % 2 === 0);
  for (const item of items) {
    if (item.depth % 2 === 0) continue;
    let ancestor = item.parent;
    while (ancestor && ancestor.depth % 2 !== 0) ancestor = ancestor.parent;
    if (ancestor) ancestor.holes.push(item.ring);
  }
  return outers.map((outer) => [outer.ring, ...outer.holes]);
}

// ---------------------------------------------------------------------------
// Boolean
// ---------------------------------------------------------------------------

/**
 * Combine two shape layers with a boolean operation.
 * @returns {number[][][][]} MultiPolygon in canvas space
 */
export function booleanShapeLayers(layerA, layerB, op, { tolerance = 0.2 } = {}) {
  const fn = OPS[op];
  if (!fn) {
    fail('E_USAGE', `unknown path boolean: ${op}`, { hint: `use one of: ${PATH_BOOLEAN_OPS.join(', ')}` });
  }
  const a = ringsToMultiPolygon(shapeToPolygons(layerA, { tolerance }));
  const b = ringsToMultiPolygon(shapeToPolygons(layerB, { tolerance }));
  if (a.length === 0) {
    fail('E_PATH_EMPTY', `layer "${layerA.name}" has no fillable geometry`, {
      hint: 'path booleans need shapes with an outline (rect/ellipse/polygon/path)',
    });
  }
  if (b.length === 0) {
    fail('E_PATH_EMPTY', `layer "${layerB.name}" has no fillable geometry`, {
      hint: 'path booleans need shapes with an outline (rect/ellipse/polygon/path)',
    });
  }
  let result;
  try {
    result = polygonClipping[fn](a, b);
  } catch (err) {
    throw new AshopError('E_PATH_BOOLEAN', `path ${op} failed: ${err.message}`, {
      hint: 'self-intersecting outlines are the usual cause; simplify the path first',
      cause: err,
    });
  }
  if (!result || result.length === 0) {
    fail('E_PATH_EMPTY', `path ${op} produced an empty result`, {
      hint: 'intersect/subtract produce nothing when the shapes do not overlap',
    });
  }
  return result;
}

/**
 * Serialise a MultiPolygon into one even-odd path plus its bounding box.
 *
 * The path data is localised to the bounding box (origin 0,0) and the box is
 * returned separately, so the caller can put it on the layer transform. That
 * keeps content coordinates small and object-bounding-box gradients sensible.
 *
 * @returns {{d:string, x:number, y:number, width:number, height:number, rings:number}}
 */
export function multiPolygonToPath(multi) {
  const rings = [];
  for (const polygon of multi) {
    for (const ring of polygon) {
      if (ring && ring.length >= 3) rings.push(ring);
    }
  }
  if (rings.length === 0) fail('E_PATH_EMPTY', 'boolean result has no rings');

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) fail('E_PATH_EMPTY', 'boolean result has no points');

  const parts = [];
  for (const ring of rings) {
    const [sx, sy] = ring[0];
    parts.push(`M${fmt(sx - minX)} ${fmt(sy - minY)}`);
    for (let i = 1; i < ring.length; i++) {
      const [x, y] = ring[i];
      // Rings are closed; the explicit closing point is redundant before Z.
      if (i === ring.length - 1 && x === sx && y === sy) continue;
      parts.push(`L${fmt(x - minX)} ${fmt(y - minY)}`);
    }
    parts.push('Z');
  }
  return {
    d: parts.join(' '),
    x: round(minX),
    y: round(minY),
    width: Math.max(1, round(maxX - minX)),
    height: Math.max(1, round(maxY - minY)),
    rings: rings.length,
  };
}
