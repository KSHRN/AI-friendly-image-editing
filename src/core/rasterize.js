/**
 * Rasterizers: canvas-space masks for the primitive shapes selection tools
 * need (rectangles, ellipses, polygons, SVG paths) plus masks derived from
 * raster content (colour range, luminance, alpha, contiguous flood fill).
 *
 * Every exported function returns a fresh canvas-sized Mask. Shapes are
 * converted to per-pixel coverage in 0..255 by accumulating spans: coverage is
 * exact along x (the overlap of a span with a pixel column) and sampled at
 * SUB_ROWS evenly spaced sub-scanlines along y. That is effectively a 4x
 * supersampled scanline rasterizer with analytic horizontal coverage, which
 * keeps edges smooth while staying linear in canvas area.
 *
 * All functions are pure and deterministic; curve flattening and flood fill
 * use explicit stacks so no user input can blow the call stack.
 */

import { Mask } from './mask.js';
import { fail } from './errors.js';

/** Number of sub-scanlines evaluated per pixel row. */
const SUB_ROWS = 4;
/** Safety cap for adaptive curve subdivision (flatness converges far sooner). */
const MAX_SUBDIVISION_DEPTH = 24;
/** Safety cap for the number of segments used to flatten one elliptical arc. */
const MAX_ARC_SEGMENTS = 20000;
/** Width in colour-distance units of the soft edge in colorRangeMask. */
const COLOR_FALLOFF = 16;

// --- validation -----------------------------------------------------------

function checkCanvas(width, height) {
  if (!Number.isInteger(width) || width <= 0) {
    fail('E_USAGE', `invalid canvas width: ${width}`, { hint: 'width must be a positive integer' });
  }
  if (!Number.isInteger(height) || height <= 0) {
    fail('E_USAGE', `invalid canvas height: ${height}`, { hint: 'height must be a positive integer' });
  }
}

function checkNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    fail('E_USAGE', `${name} must be a finite number, got ${value}`, { hint: 'pass a finite numeric value' });
  }
  return n;
}

function checkFillRule(rule) {
  if (rule !== 'nonzero' && rule !== 'evenodd') {
    fail('E_USAGE', `unsupported fill rule: ${rule}`, { hint: "fillRule must be 'nonzero' or 'evenodd'" });
  }
  return rule;
}

function assertRaster(raster, name = 'raster') {
  if (
    !raster
    || !Number.isInteger(raster.width)
    || !Number.isInteger(raster.height)
    || !raster.data
    || raster.data.length !== raster.width * raster.height * 4
  ) {
    fail('E_USAGE', `${name} must be a Raster-like object with RGBA data`, {
      hint: 'pass a Raster from src/core/raster.js',
    });
  }
}

// --- coverage accumulation ------------------------------------------------

/**
 * Add the horizontal span [xa, xb) to one scanline, weighting each covered
 * pixel column by `weight` (1 / SUB_ROWS per sub-scanline).
 */
function addSpan(acc, width, rowOffset, xa, xb, weight) {
  if (!(xb > xa)) return;
  const wgt = weight * 255;
  let x0 = Math.floor(xa);
  if (x0 < 0) x0 = 0;
  let x1 = Math.ceil(xb);
  if (x1 > width) x1 = width;
  for (let x = x0; x < x1; x++) {
    let l = xa;
    if (l < x) l = x;
    let r = xb;
    if (r > x + 1) r = x + 1;
    if (r > l) acc[rowOffset + x] += (r - l) * wgt;
  }
}

function accumulatorToMask(acc, width, height) {
  const mask = new Mask(width, height);
  const d = mask.data;
  for (let i = 0; i < d.length; i++) d[i] = Math.round(acc[i]);
  return mask;
}

// --- rectangles -----------------------------------------------------------

/**
 * Axis-aligned rectangle mask with analytic edge coverage.
 * Rectangles may extend beyond the canvas; the result is clipped.
 *
 * @param {number} width canvas width
 * @param {number} height canvas height
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @returns {Mask}
 */
export function rectMask(width, height, rect) {
  checkCanvas(width, height);
  if (!rect || typeof rect !== 'object') {
    fail('E_USAGE', 'rectMask requires a rect {x,y,width,height}');
  }
  let x = checkNumber(rect.x, 'rect.x');
  let y = checkNumber(rect.y, 'rect.y');
  let rw = checkNumber(rect.width, 'rect.width');
  let rh = checkNumber(rect.height, 'rect.height');
  // Negative extents are normalised so callers can build rects from two corners.
  if (rw < 0) {
    x += rw;
    rw = -rw;
  }
  if (rh < 0) {
    y += rh;
    rh = -rh;
  }

  const mask = new Mask(width, height);
  const d = mask.data;
  const x0 = Math.max(0, Math.floor(x));
  const x1 = Math.min(width, Math.ceil(x + rw));
  const y0 = Math.max(0, Math.floor(y));
  const y1 = Math.min(height, Math.ceil(y + rh));
  if (x1 <= x0 || y1 <= y0) return mask;

  const right = x + rw;
  const bottom = y + rh;
  for (let py = y0; py < y1; py++) {
    const oy = (bottom < py + 1 ? bottom : py + 1) - (y > py ? y : py);
    if (oy <= 0) continue;
    const row = py * width;
    for (let px = x0; px < x1; px++) {
      const ox = (right < px + 1 ? right : px + 1) - (x > px ? x : px);
      if (ox <= 0) continue;
      d[row + px] = Math.round(ox * oy * 255);
    }
  }
  return mask;
}

// --- ellipses -------------------------------------------------------------

/**
 * Ellipse mask with optional rotation (degrees). Coverage is analytic along x
 * and sampled with SUB_ROWS sub-scanlines along y.
 *
 * @param {number} width
 * @param {number} height
 * @param {{cx:number,cy:number,rx:number,ry:number,rotation?:number}} ellipse
 * @returns {Mask}
 */
export function ellipseMask(width, height, ellipse = {}) {
  checkCanvas(width, height);
  if (!ellipse || typeof ellipse !== 'object') {
    fail('E_USAGE', 'ellipseMask requires {cx,cy,rx,ry,rotation}');
  }
  const cx = checkNumber(ellipse.cx, 'ellipse.cx');
  const cy = checkNumber(ellipse.cy, 'ellipse.cy');
  const rx = checkNumber(ellipse.rx, 'ellipse.rx');
  const ry = checkNumber(ellipse.ry, 'ellipse.ry');
  const rotation = ellipse.rotation === undefined ? 0 : checkNumber(ellipse.rotation, 'ellipse.rotation');
  if (rx < 0 || ry < 0) {
    fail('E_USAGE', 'ellipse radii must be >= 0', { hint: 'rx and ry are semi-axis lengths; pass absolute values' });
  }

  const mask = new Mask(width, height);
  if (rx === 0 || ry === 0) return mask;

  const theta = (rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // Axis-aligned extent of the rotated ellipse.
  const ex = Math.sqrt(rx * rx * cos * cos + ry * ry * sin * sin);
  const ey = Math.sqrt(rx * rx * sin * sin + ry * ry * cos * cos);
  const left = Math.max(0, Math.floor(cx - ex));
  const right = Math.min(width, Math.ceil(cx + ex));
  const top = Math.max(0, Math.floor(cy - ey));
  const bottom = Math.min(height, Math.ceil(cy + ey));
  if (right <= left || bottom <= top) return mask;

  const invRx2 = 1 / (rx * rx);
  const invRy2 = 1 / (ry * ry);
  // u = cos*dx + sin*dy, v = -sin*dx + cos*dy; inside when u^2/rx^2 + v^2/ry^2 <= 1.
  const a = cos * cos * invRx2 + sin * sin * invRy2;
  const bPerDy = 2 * cos * sin * (invRx2 - invRy2);
  const acc = new Float32Array(width * height);
  const weight = 1 / SUB_ROWS;

  for (let py = top; py < bottom; py++) {
    const rowOffset = py * width;
    for (let s = 0; s < SUB_ROWS; s++) {
      const y = py + (s + 0.5) / SUB_ROWS;
      const dy = y - cy;
      const b = bPerDy * dy;
      const c = sin * sin * dy * dy * invRx2 + cos * cos * dy * dy * invRy2 - 1;
      const disc = b * b - 4 * a * c;
      if (disc <= 0) continue;
      const root = Math.sqrt(disc);
      const dxa = (-b - root) / (2 * a);
      const dxb = (-b + root) / (2 * a);
      addSpan(acc, width, rowOffset, cx + dxa, cx + dxb, weight);
    }
  }
  return accumulatorToMask(acc, width, height);
}

// --- polygons -------------------------------------------------------------

function normalizePoints(points, label) {
  if (!Array.isArray(points)) {
    fail('E_USAGE', `${label} points must be an array of {x,y}`, { hint: 'pass [{x,y}, ...]' });
  }
  const out = new Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || typeof p !== 'object') {
      fail('E_USAGE', `${label} point ${i} must be an object with x and y`);
    }
    out[i] = {
      x: checkNumber(p.x, `${label} point ${i}.x`),
      y: checkNumber(p.y, `${label} point ${i}.y`),
    };
  }
  return out;
}

/**
 * Scanline-rasterize one or more closed contours into a coverage mask.
 * Fill rules are applied across all contours, so subpaths can punch holes.
 */
function rasterizePolygons(width, height, contours, fillRule) {
  const mask = new Mask(width, height);
  if (!contours.length) return mask;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let ci = 0; ci < contours.length; ci++) {
    const c = contours[ci];
    for (let pi = 0; pi < c.length; pi++) {
      const p = c[pi];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!(maxX >= minX) || !(maxY >= minY)) return mask;

  const left = Math.max(0, Math.floor(minX));
  const right = Math.min(width, Math.ceil(maxX));
  const top = Math.max(0, Math.floor(minY));
  const bottom = Math.min(height, Math.ceil(maxY));
  if (right <= left || bottom <= top) return mask;

  // Collect edges once; each contour is implicitly closed for filling.
  const edges = [];
  for (let ci = 0; ci < contours.length; ci++) {
    const c = contours[ci];
    for (let pi = 0; pi < c.length; pi++) {
      const a = c[pi];
      const b = c[(pi + 1) % c.length];
      if (a.y === b.y) continue; // horizontal edges never cross a scanline
      edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
    }
  }
  if (!edges.length) return mask;

  const acc = new Float32Array(width * height);
  const weight = 1 / SUB_ROWS;
  const crossings = [];

  for (let py = top; py < bottom; py++) {
    const rowOffset = py * width;
    for (let s = 0; s < SUB_ROWS; s++) {
      const y = py + (s + 0.5) / SUB_ROWS;
      crossings.length = 0;
      for (let ei = 0; ei < edges.length; ei++) {
        const e = edges[ei];
        const y0 = e.y0;
        const y1 = e.y1;
        // Half-open rule keeps shared vertices from double-counting.
        if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
          const x = e.x0 + ((y - y0) * (e.x1 - e.x0)) / (y1 - y0);
          crossings.push({ x, dir: y1 > y0 ? 1 : -1 });
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((p, q) => p.x - q.x);

      if (fillRule === 'evenodd') {
        for (let i = 0; i + 1 < crossings.length; i += 2) {
          addSpan(acc, width, rowOffset, crossings[i].x, crossings[i + 1].x, weight);
        }
      } else {
        let winding = 0;
        let spanStart = 0;
        for (let i = 0; i < crossings.length; i++) {
          const prev = winding;
          winding += crossings[i].dir;
          if (prev === 0 && winding !== 0) {
            spanStart = crossings[i].x;
          } else if (prev !== 0 && winding === 0) {
            addSpan(acc, width, rowOffset, spanStart, crossings[i].x, weight);
          }
        }
      }
    }
  }
  return accumulatorToMask(acc, width, height);
}

/**
 * Polygon mask with a 4x supersampled scanline rasterizer.
 *
 * @param {number} width
 * @param {number} height
 * @param {{x:number,y:number}[]} points
 * @param {{fillRule?:'nonzero'|'evenodd'}} [opts]
 * @returns {Mask}
 */
export function polygonMask(width, height, points, opts = {}) {
  checkCanvas(width, height);
  const fillRule = checkFillRule(opts && opts.fillRule !== undefined ? opts.fillRule : 'nonzero');
  const contour = normalizePoints(points, 'polygon');
  return rasterizePolygons(width, height, contour.length ? [contour] : [], fillRule);
}

// --- SVG paths ------------------------------------------------------------

const PATH_COMMANDS = new Set('MmLlHhVvCcSsQqTtAaZz'.split(''));
const NUMBER_RE = /[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?/y;

function emitPoint(points, x, y) {
  const last = points[points.length - 1];
  if (last && last.x === x && last.y === y) return;
  points.push({ x, y });
}

/**
 * Parse an SVG path 'd' string into flattened closed contours.
 *
 * Supports absolute and relative M L H V C S Q T A Z. Curves and arcs are
 * adaptively subdivided to a chord tolerance and appended as polylines; the
 * fill rule is applied later, across all subpaths.
 *
 * @returns {{x:number,y:number}[][]}
 */
function parsePath(svgPath, tolerance) {
  if (typeof svgPath !== 'string') {
    fail('E_USAGE', 'svgPath must be a string', { hint: "pass path data such as 'M0 0 L10 0 L10 10 Z'" });
  }
  const src = svgPath;
  const len = src.length;
  let i = 0;
  let cmd = null;
  let px = 0;
  let py = 0;
  let startX = 0;
  let startY = 0;
  let lastCtrlX = 0;
  let lastCtrlY = 0;
  let lastCtrlType = null; // 'C' | 'Q' | null
  let contour = null;
  const contours = [];
  let sawCommand = false;
  let started = false;

  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ',';
  const isNumberStart = (c) => c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9');

  function skipWs() {
    while (i < len && isWs(src[i])) i++;
  }

  function parseError(message) {
    fail('E_USAGE', `invalid SVG path: ${message} at offset ${i}`, {
      hint: 'check the path data syntax and command arguments',
    });
  }

  function readNumber(what) {
    skipWs();
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(src);
    if (!m) parseError(`expected ${what}`);
    i = NUMBER_RE.lastIndex;
    const value = Number(m[0]);
    if (!Number.isFinite(value)) parseError(`${what} is not finite`);
    return value;
  }

  function readFlag(what) {
    skipWs();
    const c = src[i];
    if (c !== '0' && c !== '1') parseError(`expected ${what} (0 or 1)`);
    i++;
    return c === '1';
  }

  function ensureContour() {
    if (!contour) contour = [{ x: px, y: py }];
    return contour;
  }

  function pushPoint(x, y) {
    emitPoint(ensureContour(), x, y);
  }

  function beginContour(x, y) {
    if (contour) contours.push(contour);
    contour = [{ x, y }];
    px = x;
    py = y;
    startX = x;
    startY = y;
  }

  while (true) {
    skipWs();
    if (i >= len) break;
    if (PATH_COMMANDS.has(src[i])) {
      cmd = src[i];
      i++;
      sawCommand = true;
    } else if (isNumberStart(src[i])) {
      // Implicit repetition: M/m repeats as L/l, everything else repeats itself.
      if (cmd === null) parseError('expected a command');
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
      else if (cmd === 'Z' || cmd === 'z') parseError('unexpected number after closepath');
    } else {
      parseError(`unexpected character '${src[i]}'`);
    }

    if (!started && cmd !== 'M' && cmd !== 'm') {
      parseError('path data must begin with a moveto command');
    }

    switch (cmd) {
      case 'M':
      case 'm': {
        let x = readNumber('x');
        let y = readNumber('y');
        if (cmd === 'm') {
          x += px;
          y += py;
        }
        beginContour(x, y);
        started = true;
        lastCtrlType = null;
        break;
      }
      case 'L':
      case 'l': {
        let x = readNumber('x');
        let y = readNumber('y');
        if (cmd === 'l') {
          x += px;
          y += py;
        }
        pushPoint(x, y);
        px = x;
        py = y;
        lastCtrlType = null;
        break;
      }
      case 'H':
      case 'h': {
        let x = readNumber('x');
        if (cmd === 'h') x += px;
        pushPoint(x, py);
        px = x;
        lastCtrlType = null;
        break;
      }
      case 'V':
      case 'v': {
        let y = readNumber('y');
        if (cmd === 'v') y += py;
        pushPoint(px, y);
        py = y;
        lastCtrlType = null;
        break;
      }
      case 'C':
      case 'c': {
        let x1 = readNumber('x1');
        let y1 = readNumber('y1');
        let x2 = readNumber('x2');
        let y2 = readNumber('y2');
        let x = readNumber('x');
        let y = readNumber('y');
        if (cmd === 'c') {
          x1 += px;
          y1 += py;
          x2 += px;
          y2 += py;
          x += px;
          y += py;
        }
        flattenCubic(px, py, x1, y1, x2, y2, x, y, tolerance, ensureContour());
        px = x;
        py = y;
        lastCtrlX = x2;
        lastCtrlY = y2;
        lastCtrlType = 'C';
        break;
      }
      case 'S':
      case 's': {
        let x2 = readNumber('x2');
        let y2 = readNumber('y2');
        let x = readNumber('x');
        let y = readNumber('y');
        if (cmd === 's') {
          x2 += px;
          y2 += py;
          x += px;
          y += py;
        }
        const x1 = lastCtrlType === 'C' ? 2 * px - lastCtrlX : px;
        const y1 = lastCtrlType === 'C' ? 2 * py - lastCtrlY : py;
        flattenCubic(px, py, x1, y1, x2, y2, x, y, tolerance, ensureContour());
        px = x;
        py = y;
        lastCtrlX = x2;
        lastCtrlY = y2;
        lastCtrlType = 'C';
        break;
      }
      case 'Q':
      case 'q': {
        let x1 = readNumber('x1');
        let y1 = readNumber('y1');
        let x = readNumber('x');
        let y = readNumber('y');
        if (cmd === 'q') {
          x1 += px;
          y1 += py;
          x += px;
          y += py;
        }
        flattenQuadratic(px, py, x1, y1, x, y, tolerance, ensureContour());
        px = x;
        py = y;
        lastCtrlX = x1;
        lastCtrlY = y1;
        lastCtrlType = 'Q';
        break;
      }
      case 'T':
      case 't': {
        let x = readNumber('x');
        let y = readNumber('y');
        if (cmd === 't') {
          x += px;
          y += py;
        }
        const x1 = lastCtrlType === 'Q' ? 2 * px - lastCtrlX : px;
        const y1 = lastCtrlType === 'Q' ? 2 * py - lastCtrlY : py;
        flattenQuadratic(px, py, x1, y1, x, y, tolerance, ensureContour());
        px = x;
        py = y;
        lastCtrlX = x1;
        lastCtrlY = y1;
        lastCtrlType = 'Q';
        break;
      }
      case 'A':
      case 'a': {
        const rx = readNumber('rx');
        const ry = readNumber('ry');
        const rotation = readNumber('x-axis-rotation');
        const largeArc = readFlag('large-arc-flag');
        const sweep = readFlag('sweep-flag');
        let x = readNumber('x');
        let y = readNumber('y');
        if (cmd === 'a') {
          x += px;
          y += py;
        }
        flattenArc(px, py, rx, ry, rotation, largeArc, sweep, x, y, tolerance, ensureContour());
        px = x;
        py = y;
        lastCtrlType = null;
        break;
      }
      case 'Z':
      case 'z': {
        if (contour && contour.length >= 2) {
          const first = contour[0];
          const last = contour[contour.length - 1];
          if (first.x !== last.x || first.y !== last.y) {
            contour.push({ x: first.x, y: first.y });
          }
          contours.push(contour);
        }
        contour = null;
        px = startX;
        py = startY;
        lastCtrlType = null;
        break;
      }
      default:
        parseError(`unsupported command '${cmd}'`);
    }
  }

  if (!sawCommand) {
    fail('E_USAGE', 'invalid SVG path: empty path data', { hint: 'provide at least one drawing command' });
  }
  if (contour && contour.length >= 2) {
    const first = contour[0];
    const last = contour[contour.length - 1];
    if (first.x !== last.x || first.y !== last.y) {
      contour.push({ x: first.x, y: first.y });
    }
    contours.push(contour);
  }
  return contours;
}

function isCubicFlat(x0, y0, x1, y1, x2, y2, x3, y3, tolerance) {
  const dx = x3 - x0;
  const dy = y3 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) {
    // Degenerate chord: only flatten when the control polygon itself is tiny.
    return (
      Math.hypot(x1 - x0, y1 - y0)
      + Math.hypot(x2 - x0, y2 - y0)
      + Math.hypot(x3 - x0, y3 - y0)
      <= tolerance
    );
  }
  const invLen = 1 / Math.sqrt(len2);
  const d1 = Math.abs((x1 - x0) * dy - (y1 - y0) * dx) * invLen;
  const d2 = Math.abs((x2 - x0) * dy - (y2 - y0) * dx) * invLen;
  return (d1 > d2 ? d1 : d2) <= tolerance;
}

/** Adaptively flatten a cubic Bezier, appending the endpoint last. */
function flattenCubic(x0, y0, x1, y1, x2, y2, x3, y3, tolerance, points) {
  const stack = [[x0, y0, x1, y1, x2, y2, x3, y3, 0]];
  while (stack.length) {
    const s = stack.pop();
    if (s[8] >= MAX_SUBDIVISION_DEPTH || isCubicFlat(s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], tolerance)) {
      emitPoint(points, s[6], s[7]);
      continue;
    }
    // de Casteljau split at t = 0.5.
    const ax = (s[0] + s[2]) / 2;
    const ay = (s[1] + s[3]) / 2;
    const bx = (s[2] + s[4]) / 2;
    const by = (s[3] + s[5]) / 2;
    const cx = (s[4] + s[6]) / 2;
    const cy = (s[5] + s[7]) / 2;
    const abx = (ax + bx) / 2;
    const aby = (ay + by) / 2;
    const bcx = (bx + cx) / 2;
    const bcy = (by + cy) / 2;
    const mx = (abx + bcx) / 2;
    const my = (aby + bcy) / 2;
    // Push right half first so the left half is processed first.
    stack.push([mx, my, bcx, bcy, cx, cy, s[6], s[7], s[8] + 1]);
    stack.push([s[0], s[1], ax, ay, abx, aby, mx, my, s[8] + 1]);
  }
}

/** Adaptively flatten a quadratic Bezier (converted exactly to a cubic). */
function flattenQuadratic(x0, y0, x1, y1, x2, y2, tolerance, points) {
  const c1x = x0 + (2 / 3) * (x1 - x0);
  const c1y = y0 + (2 / 3) * (y1 - y0);
  const c2x = x2 + (2 / 3) * (x1 - x2);
  const c2y = y2 + (2 / 3) * (y1 - y2);
  flattenCubic(x0, y0, c1x, c1y, c2x, c2y, x2, y2, tolerance, points);
}

/**
 * Flatten an SVG elliptical arc (endpoint parameterisation) to a polyline.
 * Implements the endpoint -> center conversion from the SVG specification.
 */
function flattenArc(x1, y1, rx, ry, rotationDeg, largeArc, sweep, x2, y2, tolerance, points) {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) {
    // Degenerate arc is treated as a straight line.
    emitPoint(points, x2, y2);
    return;
  }

  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Scale up radii that are too small to reach the endpoint.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    rx *= scale;
    ry *= scale;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const sign = largeArc !== sweep ? 1 : -1;
  const numerator = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const coef = denominator > 0 ? sign * Math.sqrt(Math.max(0, numerator / denominator)) : 0;
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (-coef * (ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (Math.abs(delta) < 1e-12) {
    emitPoint(points, x2, y2);
    return;
  }

  // Max angular step whose chord sagitta stays within tolerance.
  const rMax = Math.max(rx, ry);
  const ratio = tolerance / rMax;
  let step = ratio >= 1 ? Math.PI / 2 : 2 * Math.acos(1 - ratio);
  if (!(step > 0)) step = Math.PI / 8;
  if (step > Math.PI / 8) step = Math.PI / 8;
  const n = Math.min(MAX_ARC_SEGMENTS, Math.max(1, Math.ceil(Math.abs(delta) / step)));

  for (let k = 1; k < n; k++) {
    const t = theta1 + (delta * k) / n;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    emitPoint(points, cx + rx * ct * cosPhi - ry * st * sinPhi, cy + rx * ct * sinPhi + ry * st * cosPhi);
  }
  emitPoint(points, x2, y2);
}

/**
 * SVG path mask. Supports M m L l H h V v C c S s Q q T t A a Z z, relative and
 * absolute forms, adaptive curve flattening and multi-subpath fill rules
 * (holes work for both nonzero and evenodd).
 *
 * @param {number} width
 * @param {number} height
 * @param {string} svgPath
 * @param {{fillRule?:'nonzero'|'evenodd', tolerance?:number}} [opts]
 * @returns {Mask}
 */
export function pathMask(width, height, svgPath, opts = {}) {
  checkCanvas(width, height);
  const fillRule = checkFillRule(opts && opts.fillRule !== undefined ? opts.fillRule : 'nonzero');
  const tolerance = opts && opts.tolerance !== undefined ? checkNumber(opts.tolerance, 'tolerance') : 0.2;
  if (tolerance <= 0) {
    fail('E_USAGE', `tolerance must be > 0, got ${tolerance}`, { hint: 'use a small positive tolerance such as 0.2' });
  }
  const contours = parsePath(svgPath, tolerance);
  return rasterizePolygons(width, height, contours, fillRule);
}

// --- content-derived masks ------------------------------------------------

// Integer Rec.601 weights keep threshold comparisons exact at integer levels
// (0.299+0.587+0.114 in floats gives 127.99999999999999 for 128).
const luminanceOf = (r, g, b) => (299 * r + 587 * g + 114 * b) / 1000;

function distanceToCoverage(distance, tolerance) {
  if (distance <= tolerance) return 255;
  // With a zero tolerance the selection is exact: no soft edge is desired.
  if (tolerance <= 0) return 0;
  const excess = distance - tolerance;
  if (excess >= COLOR_FALLOFF) return 0;
  return Math.round(255 * (1 - excess / COLOR_FALLOFF));
}

function softCoverage(value, threshold, softness) {
  if (value >= threshold) return 255;
  if (softness <= 0) return 0;
  const lo = threshold - softness;
  if (value <= lo) return 0;
  return Math.round(((value - lo) / softness) * 255);
}

/**
 * Select pixels close to a reference colour.
 *
 * metric 'rgb' uses Euclidean distance in RGB, 'luma' uses |luma - luma(color)|.
 * Distances <= tolerance are fully selected; when tolerance > 0 the next
 * COLOR_FALLOFF units fade linearly to zero. Metric 'lab' is not implemented.
 *
 * @param {object} raster Raster-like {width,height,data}
 * @param {{color:number[], tolerance?:number, metric?:'rgb'|'luma'|'lab'}} opts
 * @returns {Mask}
 */
export function colorRangeMask(raster, opts = {}) {
  assertRaster(raster);
  if (!opts || typeof opts !== 'object') {
    fail('E_USAGE', 'colorRangeMask requires {color, tolerance, metric}');
  }
  const color = opts.color;
  if (!Array.isArray(color) || color.length < 3) {
    fail('E_USAGE', 'colorRangeMask color must be [r,g,b]', { hint: 'pass an RGB triple, e.g. [255, 0, 0]' });
  }
  const cr = checkNumber(color[0], 'color[0]');
  const cg = checkNumber(color[1], 'color[1]');
  const cb = checkNumber(color[2], 'color[2]');
  const tolerance = opts.tolerance === undefined ? 0 : checkNumber(opts.tolerance, 'tolerance');
  if (tolerance < 0) {
    fail('E_USAGE', `tolerance must be >= 0, got ${tolerance}`);
  }
  const metric = opts.metric === undefined ? 'rgb' : opts.metric;
  if (metric !== 'rgb' && metric !== 'luma' && metric !== 'lab') {
    fail('E_USAGE', `unsupported colour metric: ${metric}`, { hint: "use 'rgb' or 'luma'" });
  }
  if (metric === 'lab') {
    fail('E_USAGE', "colour metric 'lab' is not implemented yet", {
      hint: "use metric 'rgb' or 'luma'; lab support is planned",
    });
  }

  const { width, height, data } = raster;
  const mask = new Mask(width, height);
  const out = mask.data;
  const targetLuma = luminanceOf(cr, cg, cb);

  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    let distance;
    if (metric === 'luma') {
      distance = Math.abs(luminanceOf(data[p], data[p + 1], data[p + 2]) - targetLuma);
    } else {
      const dr = data[p] - cr;
      const dg = data[p + 1] - cg;
      const db = data[p + 2] - cb;
      distance = Math.sqrt(dr * dr + dg * dg + db * db);
    }
    out[i] = distanceToCoverage(distance, tolerance);
  }
  return mask;
}

/**
 * Select pixels by luminance (Rec.601 weights).
 * Values >= threshold are fully selected; [threshold-softness, threshold)
 * fades linearly.
 */
export function luminanceMask(raster, opts = {}) {
  assertRaster(raster);
  if (!opts || typeof opts !== 'object') {
    fail('E_USAGE', 'luminanceMask requires {threshold, softness}');
  }
  const threshold = checkNumber(opts.threshold, 'threshold');
  const softness = opts.softness === undefined ? 0 : checkNumber(opts.softness, 'softness');
  if (softness < 0) {
    fail('E_USAGE', `softness must be >= 0, got ${softness}`);
  }
  const { width, height, data } = raster;
  const mask = new Mask(width, height);
  const out = mask.data;
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = softCoverage(luminanceOf(data[p], data[p + 1], data[p + 2]), threshold, softness);
  }
  return mask;
}

/** Select pixels by alpha channel; same threshold/softness semantics. */
export function alphaMask(raster, opts = {}) {
  assertRaster(raster);
  if (!opts || typeof opts !== 'object') {
    fail('E_USAGE', 'alphaMask requires {threshold, softness}');
  }
  const threshold = opts.threshold === undefined ? 1 : checkNumber(opts.threshold, 'threshold');
  const softness = opts.softness === undefined ? 0 : checkNumber(opts.softness, 'softness');
  if (softness < 0) {
    fail('E_USAGE', `softness must be >= 0, got ${softness}`);
  }
  const { width, height, data } = raster;
  const mask = new Mask(width, height);
  const out = mask.data;
  for (let i = 0, p = 3; i < out.length; i++, p += 4) {
    out[i] = softCoverage(data[p], threshold, softness);
  }
  return mask;
}

/**
 * Contiguous 4-connected flood fill from (x, y).
 *
 * Compares against the seed colour with the same Euclidean RGB distance used
 * by colorRangeMask, or against the seed alpha when sampleLayerAlpha is true.
 * Uses an explicit stack (never recurses) and never leaves the canvas.
 */
export function floodFillMask(raster, opts = {}) {
  assertRaster(raster);
  if (!opts || typeof opts !== 'object') {
    fail('E_USAGE', 'floodFillMask requires {x, y, tolerance, sampleLayerAlpha}');
  }
  const { width, height, data } = raster;
  const x = opts.x;
  const y = opts.y;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    fail('E_USAGE', `flood fill seed (${x}, ${y}) is outside the ${width}x${height} raster`, {
      hint: 'seed x/y must be integer pixel coordinates inside the canvas',
    });
  }
  const tolerance = opts.tolerance === undefined ? 0 : checkNumber(opts.tolerance, 'tolerance');
  if (tolerance < 0) {
    fail('E_USAGE', `tolerance must be >= 0, got ${tolerance}`);
  }
  const sampleLayerAlpha = Boolean(opts.sampleLayerAlpha);
  const mask = new Mask(width, height);
  const out = mask.data;
  const seen = new Uint8Array(width * height);

  const seedPixel = y * width + x;
  const seed = seedPixel * 4;
  const sr = data[seed];
  const sg = data[seed + 1];
  const sb = data[seed + 2];
  const sa = data[seed + 3];
  const tol2 = tolerance * tolerance;

  function matches(pixel) {
    const p = pixel * 4;
    if (sampleLayerAlpha) {
      const da = data[p + 3] - sa;
      return da * da <= tol2;
    }
    const dr = data[p] - sr;
    const dg = data[p + 1] - sg;
    const db = data[p + 2] - sb;
    return dr * dr + dg * dg + db * db <= tol2;
  }

  seen[seedPixel] = 1;
  out[seedPixel] = 255;
  const stack = [seedPixel];

  while (stack.length) {
    const pixel = stack.pop();
    const py = (pixel / width) | 0;
    const px = pixel - py * width;

    if (px > 0) visit(pixel - 1);
    if (px + 1 < width) visit(pixel + 1);
    if (py > 0) visit(pixel - width);
    if (py + 1 < height) visit(pixel + width);
  }

  function visit(pixel) {
    if (seen[pixel]) return;
    if (!matches(pixel)) return;
    seen[pixel] = 1;
    out[pixel] = 255;
    stack.push(pixel);
  }

  return mask;
}


