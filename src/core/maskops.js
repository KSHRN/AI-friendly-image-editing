/**
 * Mask operations: boolean combination, feathering and morphology.
 *
 * Masks are 8-bit coverage maps (see src/core/mask.js). All operations are
 * pure: they return a new Mask and never mutate their inputs, and they are
 * deterministic for identical input bytes.
 *
 * Morphology (grow/shrink) is built on an exact squared Euclidean distance
 * transform (Felzenszwalb & Huttenlocher's two-pass 1D algorithm), so timing
 * is linear in pixel count and thresholds may be fractional. The selection is
 * binarised at coverage 128 before growing/eroding, matching how selection
 * tools interpret a mask, and the result is a hard 0/255 mask.
 */

import { Mask } from './mask.js';
import { fail } from './errors.js';

/** Sentinel for "no source found yet" inside the distance transform. */
const DIST_INF = 1e12;
/** Coverage at or above this counts as selected for morphology. */
const SELECT_THRESHOLD = 128;

// --- validation -----------------------------------------------------------

function assertMask(m, name) {
  if (
    !m
    || !Number.isInteger(m.width)
    || !Number.isInteger(m.height)
    || m.width <= 0
    || m.height <= 0
    || !m.data
    || m.data.length !== m.width * m.height
  ) {
    fail('E_USAGE', `${name} must be a Mask`, { hint: 'pass a Mask from src/core/mask.js' });
  }
}

function checkNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    fail('E_USAGE', `${name} must be a finite number, got ${value}`, { hint: 'pass a finite numeric value' });
  }
  return n;
}

function checkRadius(value, name) {
  const n = checkNumber(value, name);
  if (n < 0) {
    fail('E_USAGE', `${name} must be >= 0, got ${n}`, { hint: 'radius is a non-negative distance in pixels' });
  }
  return n;
}

// --- boolean combination --------------------------------------------------

const COMBINE_OPS = new Set(['replace', 'add', 'subtract', 'intersect', 'xor']);

/**
 * Combine two equally sized masks per pixel.
 *
 * replace   -> b
 * add       -> min(255, a + b)      (additive union)
 * subtract  -> max(0, a - b)
 * intersect -> round(a * b / 255)   (product, smooth falloff)
 * xor       -> |a - b|
 *
 * For binary 0/255 masks these reduce to the usual boolean set operations.
 *
 * @param {Mask} a
 * @param {Mask} b
 * @param {'replace'|'add'|'subtract'|'intersect'|'xor'} op
 * @returns {Mask}
 */
export function combine(a, b, op) {
  assertMask(a, 'a');
  assertMask(b, 'b');
  if (!COMBINE_OPS.has(op)) {
    fail('E_USAGE', `unknown combine op: ${op}`, {
      hint: "op must be one of 'replace', 'add', 'subtract', 'intersect', 'xor'",
    });
  }
  if (a.width !== b.width || a.height !== b.height) {
    fail('E_SIZE_MISMATCH', `mask sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}`, {
      hint: 'crop or resize the masks to the same canvas before combining them',
    });
  }

  const ad = a.data;
  const bd = b.data;
  const out = new Mask(a.width, a.height);
  const d = out.data;

  switch (op) {
    case 'replace':
      for (let i = 0; i < d.length; i++) d[i] = bd[i];
      break;
    case 'add':
      for (let i = 0; i < d.length; i++) d[i] = ad[i] + bd[i];
      break;
    case 'subtract':
      for (let i = 0; i < d.length; i++) d[i] = ad[i] - bd[i];
      break;
    case 'intersect':
      for (let i = 0; i < d.length; i++) d[i] = Math.round((ad[i] * bd[i]) / 255);
      break;
    case 'xor':
      for (let i = 0; i < d.length; i++) d[i] = Math.abs(ad[i] - bd[i]);
      break;
    default:
      fail('E_USAGE', `unknown combine op: ${op}`);
  }
  return out;
}

/** Invert coverage: 255 - v. */
export function invertMask(m) {
  assertMask(m, 'mask');
  const out = new Mask(m.width, m.height);
  const src = m.data;
  const d = out.data;
  for (let i = 0; i < d.length; i++) d[i] = 255 - src[i];
  return out;
}

// --- feathering -----------------------------------------------------------

/**
 * Gaussian feather with sigma = radius / 3, implemented as two separable
 * convolutions with a normalised kernel of radius ceil(3 * sigma). Out-of-
 * canvas taps are treated as zero, so selection edges touching the canvas
 * border fade against transparency.
 *
 * @param {Mask} m
 * @param {number} radius feather radius in pixels; <= 0 returns a clone
 * @returns {Mask}
 */
export function featherMask(m, radius) {
  assertMask(m, 'mask');
  const r = checkRadius(radius, 'featherMask radius');
  if (r <= 0) return m.clone();

  const sigma = r / 3;
  const k = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(2 * k + 1);
  const denom = 2 * sigma * sigma;
  let total = 0;
  for (let i = -k; i <= k; i++) {
    const weight = Math.exp(-(i * i) / denom);
    kernel[i + k] = weight;
    total += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;

  const { width: w, height: h } = m;
  const src = m.data;
  const tmp = new Float32Array(w * h);

  // Horizontal pass.
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const lo = x - k < 0 ? 0 : x - k;
      const hi = x + k >= w ? w - 1 : x + k;
      let acc = 0;
      for (let sx = lo; sx <= hi; sx++) acc += src[row + sx] * kernel[sx - x + k];
      tmp[row + x] = acc;
    }
  }

  // Vertical pass.
  const out = new Mask(w, h);
  const dst = out.data;
  for (let y = 0; y < h; y++) {
    const lo = y - k < 0 ? 0 : y - k;
    const hi = y + k >= h ? h - 1 : y + k;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = lo; sy <= hi; sy++) acc += tmp[sy * w + x] * kernel[sy - y + k];
      dst[row + x] = acc;
    }
  }
  return out;
}

// --- exact Euclidean distance transform -----------------------------------

/**
 * 1D squared distance transform. f[q] is 0 for sources and DIST_INF elsewhere;
 * d[q] receives the squared distance to the nearest source.
 */
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Squared Euclidean distance to the nearest source pixel, via two 1D passes. */
function edt2d(sources, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = sources[i] ? 0 : DIST_INF;

  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

/**
 * Grow a selection: keep pixels within `radius` of any selected pixel.
 * The input is binarised at coverage 128; the result is hard 0/255.
 *
 * @param {Mask} m
 * @param {number} radius non-negative, may be fractional
 * @returns {Mask}
 */
export function growMask(m, radius) {
  assertMask(m, 'mask');
  const r = checkRadius(radius, 'growMask radius');
  const { width: w, height: h } = m;
  const out = new Mask(w, h);
  const sources = new Uint8Array(w * h);
  let anySelected = false;
  for (let i = 0; i < sources.length; i++) {
    if (m.data[i] >= SELECT_THRESHOLD) {
      sources[i] = 1;
      anySelected = true;
    }
  }
  if (!anySelected) return out;

  const dist2 = edt2d(sources, w, h);
  const r2 = r * r;
  const d = out.data;
  for (let i = 0; i < d.length; i++) d[i] = dist2[i] <= r2 ? 255 : 0;
  return out;
}

/**
 * Shrink (erode) a selection: keep pixels farther than `radius` from any
 * unselected pixel. Points outside the canvas count as unselected, so a
 * selection touching the border erodes inward from it. The input is
 * binarised at coverage 128; the result is hard 0/255.
 *
 * @param {Mask} m
 * @param {number} radius non-negative, may be fractional
 * @returns {Mask}
 */
export function shrinkMask(m, radius) {
  assertMask(m, 'mask');
  const r = checkRadius(radius, 'shrinkMask radius');
  const { width: w, height: h } = m;
  const out = new Mask(w, h);
  // One pixel of padding beyond the radius is enough to capture every
  // outside-the-canvas source that could matter at the threshold.
  const pad = Math.ceil(r) + 1;
  const pw = w + 2 * pad;
  const ph = h + 2 * pad;
  const sources = new Uint8Array(pw * ph);
  sources.fill(1); // padding ring is unselected
  for (let y = 0; y < h; y++) {
    const srcRow = y * w;
    const dstRow = (y + pad) * pw + pad;
    for (let x = 0; x < w; x++) {
      sources[dstRow + x] = m.data[srcRow + x] >= SELECT_THRESHOLD ? 0 : 1;
    }
  }

  const dist2 = edt2d(sources, pw, ph);
  const r2 = r * r;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const srcRow = (y + pad) * pw + pad;
    for (let x = 0; x < w; x++) {
      out.data[row + x] = dist2[srcRow + x] > r2 ? 255 : 0;
    }
  }
  return out;
}

// --- simple utilities -----------------------------------------------------

/** Inner border band of a selection: originals minus shrink(width). */
export function borderMask(m, width) {
  assertMask(m, 'mask');
  const band = checkRadius(width, 'borderMask width');
  const out = new Mask(m.width, m.height);
  if (band <= 0) return out;
  const inner = shrinkMask(m, band);
  const src = m.data;
  const eroded = inner.data;
  const d = out.data;
  for (let i = 0; i < d.length; i++) {
    const v = src[i] - eroded[i];
    d[i] = v > 0 ? v : 0;
  }
  return out;
}

/** Hard threshold: coverage >= t becomes 255, everything else 0. */
export function thresholdMask(m, t) {
  assertMask(m, 'mask');
  const threshold = checkNumber(t, 'threshold');
  const out = new Mask(m.width, m.height);
  const src = m.data;
  const d = out.data;
  for (let i = 0; i < d.length; i++) d[i] = src[i] >= threshold ? 255 : 0;
  return out;
}

/**
 * Summary statistics for a mask.
 *
 * pixels   number of pixels with non-zero coverage
 * coverage mean coverage over the whole canvas, 0..1 (sum / (255 * w * h))
 * bounds   bounding box of non-zero pixels, or null when empty
 * centroid coverage-weighted centroid of pixel centres, or null when empty
 *
 * @param {Mask} m
 * @returns {{pixels:number, coverage:number, bounds:{x:number,y:number,width:number,height:number}|null, centroid:{x:number,y:number}|null}}
 */
export function maskStats(m) {
  assertMask(m, 'mask');
  const { width: w, height: h, data } = m;
  const total = w * h;
  let pixels = 0;
  let sum = 0;
  let sumX = 0;
  let sumY = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = data[row + x];
      if (v === 0) continue;
      pixels++;
      sum += v;
      sumX += (x + 0.5) * v;
      sumY += (y + 0.5) * v;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  return {
    pixels,
    coverage: sum / (255 * total),
    bounds: pixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    centroid: pixels ? { x: sumX / sum, y: sumY / sum } : null,
  };
}
