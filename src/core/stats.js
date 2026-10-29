/**
 * Image probes: small, precise answers about what a raster actually contains.
 *
 * These are the primitives an agent (or a test) uses to verify a render without
 * eyeballing it: read one pixel, describe a region, count colours. All of them
 * are synchronous, deterministic and single-pass over the pixel buffer.
 *
 * Alpha semantics, stated once so every probe is predictable:
 *  - the raster is straight (non-premultiplied) RGBA, so RGB under alpha=0 is
 *    still real data;
 *  - region stats (mean/min/max/stdDev) describe RGB over pixels with
 *    alpha > alphaThreshold, while the alpha entry of those arrays describes
 *    *all* pixels in the region -- coverage is a property of the area, not of
 *    the painted part;
 *  - histograms count R/G/B only for alpha > 0 pixels but count A for all;
 *  - topColors ignores pixels below minAlpha (default 1, i.e. alpha=0).
 */

import { colorToHex } from './raster.js';
import { AshopError } from './errors.js';

const CHANNEL_ORDER = ['r', 'g', 'b', 'a'];
const CHANNEL_OFFSET = { r: 0, g: 1, b: 2, a: 3 };

function requireRaster(raster, what) {
  if (!raster || !Number.isInteger(raster.width) || !Number.isInteger(raster.height) || !raster.data) {
    throw new AshopError('E_USAGE', `${what} needs a Raster {width, height, data}`, {
      hint: 'build one with Raster.create(width, height, color)',
    });
  }
  return raster;
}

/**
 * Assert two rasters share dimensions.
 * @throws {AshopError} E_USAGE for non-rasters, E_SIZE_MISMATCH for unequal sizes
 */
export function assertSameSize(a, b, what = 'operation') {
  requireRaster(a, what);
  requireRaster(b, what);
  if (a.width !== b.width || a.height !== b.height) {
    throw new AshopError('E_SIZE_MISMATCH', `raster size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`, {
      hint: 'resize or crop one raster so both have identical dimensions',
      details: { a: { width: a.width, height: a.height }, b: { width: b.width, height: b.height } },
    });
  }
}

/**
 * Read a single pixel. Out-of-bounds coordinates are not an error: they return
 * transparent black with `inBounds: false`, which keeps probe loops simple.
 * Coordinates are floored to integers.
 *
 * @returns {{x:number, y:number, rgba:[number,number,number,number], hex:string, inBounds:boolean}}
 */
export function pixelAt(raster, x, y) {
  requireRaster(raster, 'pixelAt');
  const px = Math.floor(Number(x));
  const py = Math.floor(Number(y));
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    throw new AshopError('E_USAGE', `pixelAt needs numeric coordinates, got (${x}, ${y})`);
  }
  const inBounds = px >= 0 && py >= 0 && px < raster.width && py < raster.height;
  const rgba = inBounds ? raster.get(px, py) : [0, 0, 0, 0];
  return { x: px, y: py, rgba, hex: colorToHex(rgba), inBounds };
}

/**
 * Clamp a caller rect to the raster; out-of-bounds edges are cropped, not an
 * error. A rect with no area (or one entirely outside) is E_USAGE.
 * @returns {{x0:number, y0:number, x1:number, y1:number}} half-open bounds
 */
function normalizeRect(rect, raster, what) {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) {
    throw new AshopError('E_USAGE', `${what} needs a rect {x, y, width, height}`, {
      hint: 'example: {x: 10, y: 10, width: 200, height: 120}',
    });
  }
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width ?? rect.w);
  const height = Number(rect.height ?? rect.h);
  if (![x, y, width, height].every(Number.isFinite)) {
    throw new AshopError('E_USAGE', `${what}: rect components must be finite numbers`, {
      details: { rect },
    });
  }
  if (!(width > 0) || !(height > 0)) {
    throw new AshopError('E_USAGE', `${what}: rect is empty`, {
      hint: 'width and height must both be greater than zero',
      details: { rect },
    });
  }
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(raster.width, Math.ceil(x + width));
  const y1 = Math.min(raster.height, Math.ceil(y + height));
  if (x1 <= x0 || y1 <= y0) {
    throw new AshopError('E_USAGE', `${what}: rect lies outside the raster`, {
      hint: `raster is ${raster.width}x${raster.height}; the rect does not overlap it`,
      details: { rect },
    });
  }
  return { x0, y0, x1, y1 };
}

/**
 * Statistics for a rectangle, clipped to the raster.
 *
 * `alphaThreshold` is exclusive: a pixel is "painted" when alpha > threshold.
 * RGB moments are over painted pixels only; the alpha moments are over every
 * pixel in the (clipped) rect. `opaqueBounds` is the painted bounding box in
 * raster coordinates, or null when nothing is painted.
 *
 * @returns {{width:number,height:number,pixels:number,alphaCoverage:number,
 *   mean:number[],min:number[],max:number[],stdDev:number[],
 *   opaqueBounds:{x:number,y:number,width:number,height:number}|null}}
 */
export function regionStats(raster, rect, { alphaThreshold = 0 } = {}) {
  requireRaster(raster, 'regionStats');
  if (typeof alphaThreshold !== 'number' || !Number.isFinite(alphaThreshold)) {
    throw new AshopError('E_USAGE', `alphaThreshold must be a number, got ${alphaThreshold}`);
  }
  const { x0, y0, x1, y1 } = normalizeRect(rect, raster, 'regionStats');
  const { width: rasterWidth, data } = raster;
  const width = x1 - x0;
  const height = y1 - y0;
  const pixels = width * height;

  const sums = new Float64Array(4);
  const sumSq = new Float64Array(4);
  const min = [255, 255, 255, 255];
  const max = [0, 0, 0, 0];
  let alphaSum = 0;
  let painted = 0;
  let minX = raster.width, minY = raster.height, maxX = -1, maxY = -1;

  for (let y = y0; y < y1; y++) {
    const row = y * rasterWidth;
    for (let x = x0; x < x1; x++) {
      const i = (row + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      // Alpha covers the whole region, painted or not.
      alphaSum += a;
      sumSq[3] += a * a;
      if (a < min[3]) min[3] = a;
      if (a > max[3]) max[3] = a;

      if (a > alphaThreshold) {
        painted++;
        sums[0] += r; sums[1] += g; sums[2] += b;
        sumSq[0] += r * r; sumSq[1] += g * g; sumSq[2] += b * b;
        if (r < min[0]) min[0] = r;
        if (r > max[0]) max[0] = r;
        if (g < min[1]) min[1] = g;
        if (g > max[1]) max[1] = g;
        if (b < min[2]) min[2] = b;
        if (b > max[2]) max[2] = b;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const mean = [0, 0, 0, 0];
  const stdDev = [0, 0, 0, 0];
  if (painted === 0) {
    // No painted pixels: colour moments are all zero by definition.
    min[0] = 0; min[1] = 0; min[2] = 0;
    max[0] = 0; max[1] = 0; max[2] = 0;
  } else {
    for (let c = 0; c < 3; c++) {
      mean[c] = sums[c] / painted;
      stdDev[c] = Math.sqrt(Math.max(0, sumSq[c] / painted - mean[c] * mean[c]));
    }
  }
  mean[3] = alphaSum / pixels;
  stdDev[3] = Math.sqrt(Math.max(0, sumSq[3] / pixels - mean[3] * mean[3]));

  return {
    width,
    height,
    pixels,
    alphaCoverage: painted / pixels,
    mean,
    min,
    max,
    stdDev,
    opaqueBounds: maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
}

function parseChannels(channel) {
  const list = Array.isArray(channel) ? channel : String(channel).split('');
  const seen = new Set();
  for (const c of list) {
    if (!(c in CHANNEL_OFFSET)) {
      throw new AshopError('E_USAGE', `unknown colour channel: ${c}`, {
        hint: 'use any of r, g, b, a (e.g. "rgba" or ["r", "g"])',
      });
    }
    seen.add(c);
  }
  if (seen.size === 0) {
    throw new AshopError('E_USAGE', 'histogram needs at least one channel');
  }
  return CHANNEL_ORDER.filter((c) => seen.has(c));
}

/**
 * Per-channel intensity histogram with `bins` buckets over 0..255.
 *
 * R/G/B count only pixels with alpha > 0 (fully transparent pixels would
 * otherwise dominate a histogram with garbage colour); A counts every pixel.
 * Only the requested channels appear in the result.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
 * @param {{bins?:number, channel?:string|string[]}} [opts]
 * @returns {Record<string, number[]>}
 */
export function histogram(raster, { bins = 256, channel = 'rgba' } = {}) {
  requireRaster(raster, 'histogram');
  if (!Number.isInteger(bins) || bins < 1) {
    throw new AshopError('E_USAGE', `bins must be a positive integer, got ${bins}`);
  }
  const channels = parseChannels(channel);
  const counts = {};
  for (const c of channels) counts[c] = new Uint32Array(bins);

  const data = raster.data;
  const scale = bins / 256;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    for (const c of channels) {
      if (c !== 'a' && alpha === 0) continue;
      let bin = Math.floor(data[i + CHANNEL_OFFSET[c]] * scale);
      if (bin >= bins) bin = bins - 1;
      counts[c][bin]++;
    }
  }

  const out = {};
  for (const c of channels) out[c] = Array.from(counts[c]);
  return out;
}

/**
 * Most frequent colours after quantisation.
 *
 * Each channel is bucketed by `quantize` (16 => 16 buckets of 0..15, 16..31,
 * ...). Buckets are keyed on quantised RGBA, and the reported `rgba` is the
 * rounded mean of the *original* pixels in that bucket, so a single-pixel
 * bucket reports its exact colour. Pixels with alpha < minAlpha are skipped;
 * `ratio` is relative to the skipped-filtered pixel count. Ties break by
 * quantised colour key ascending, which keeps the output deterministic.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
 * @param {{limit?:number, quantize?:number, minAlpha?:number}} [opts]
 * @returns {{rgba:number[], hex:string, count:number, ratio:number}[]}
 */
export function topColors(raster, { limit = 8, quantize = 16, minAlpha = 1 } = {}) {
  requireRaster(raster, 'topColors');
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AshopError('E_USAGE', `limit must be a positive integer, got ${limit}`);
  }
  if (!Number.isInteger(quantize) || quantize < 1 || quantize > 256) {
    throw new AshopError('E_USAGE', `quantize must be an integer within 1..256, got ${quantize}`);
  }
  if (typeof minAlpha !== 'number' || !Number.isFinite(minAlpha)) {
    throw new AshopError('E_USAGE', `minAlpha must be a number, got ${minAlpha}`);
  }

  const bucketCount = Math.ceil(256 / quantize);
  const data = raster.data;
  /** @type {Map<number, Float64Array>} bucket key -> [count, sumR, sumG, sumB, sumA] */
  const buckets = new Map();
  let counted = 0;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < minAlpha) continue;
    counted++;
    const br = Math.min(bucketCount - 1, Math.floor(data[i] / quantize));
    const bg = Math.min(bucketCount - 1, Math.floor(data[i + 1] / quantize));
    const bb = Math.min(bucketCount - 1, Math.floor(data[i + 2] / quantize));
    const ba = Math.min(bucketCount - 1, Math.floor(a / quantize));
    const key = ((br * bucketCount + bg) * bucketCount + bb) * bucketCount + ba;
    let entry = buckets.get(key);
    if (!entry) {
      entry = new Float64Array(5);
      buckets.set(key, entry);
    }
    entry[0] += 1;
    entry[1] += data[i];
    entry[2] += data[i + 1];
    entry[3] += data[i + 2];
    entry[4] += a;
  }

  const entries = [...buckets.entries()].sort((p, q) => (q[1][0] - p[1][0]) || (p[0] - q[0]));
  const out = [];
  for (let i = 0; i < entries.length && out.length < limit; i++) {
    const entry = entries[i][1];
    const count = entry[0];
    const rgba = [
      Math.round(entry[1] / count),
      Math.round(entry[2] / count),
      Math.round(entry[3] / count),
      Math.round(entry[4] / count),
    ];
    out.push({ rgba, hex: colorToHex(rgba), count, ratio: counted === 0 ? 0 : count / counted });
  }
  return out;
}

/**
 * Cheap "what is in this image" summary for logs and assertions.
 *
 * `meanColor` = RGB mean over painted pixels (alpha > 0) plus mean alpha over
 * all pixels; `dominantColor` is the top entry of `topColors(raster, {limit:1})`
 * or null for a fully transparent raster. `hasAlpha` is true when any pixel is
 * not fully opaque (fully transparent images therefore report true).
 */
export function imageSummary(raster) {
  requireRaster(raster, 'imageSummary');
  const { width: w, height: h, data } = raster;
  const n = w * h;
  let alphaSum = 0;
  let painted = 0;
  let hasAlpha = false;
  const rgbSum = new Float64Array(3);

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    alphaSum += a;
    if (a !== 255) hasAlpha = true;
    if (a > 0) {
      painted++;
      rgbSum[0] += data[i];
      rgbSum[1] += data[i + 1];
      rgbSum[2] += data[i + 2];
    }
  }

  const meanColor = painted === 0
    ? [0, 0, 0, 0]
    : [rgbSum[0] / painted, rgbSum[1] / painted, rgbSum[2] / painted, alphaSum / n];
  const top = topColors(raster, { limit: 1 });

  return {
    width: w,
    height: h,
    hasAlpha,
    alphaCoverage: painted / n,
    isEmpty: painted === 0,
    pixelHash: raster.pixelHash(),
    meanColor,
    dominantColor: top.length === 0 ? null : top[0].rgba,
  };
}

/**
 * Euclidean distance between two RGB triples, 0..sqrt(3)*255 (~441.67).
 * Alpha is intentionally not part of this metric: it measures colour distance.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
export function pixelDistance(a, b) {
  if (!a || !b || a.length < 3 || b.length < 3) {
    throw new AshopError('E_USAGE', 'pixelDistance needs two RGB(A) arrays with at least 3 components');
  }
  const dr = Number(a[0]) - Number(b[0]);
  const dg = Number(a[1]) - Number(b[1]);
  const db = Number(a[2]) - Number(b[2]);
  if (!Number.isFinite(dr) || !Number.isFinite(dg) || !Number.isFinite(db)) {
    throw new AshopError('E_USAGE', 'pixelDistance components must be finite numbers');
  }
  return Math.sqrt(dr * dr + dg * dg + db * db);
}
