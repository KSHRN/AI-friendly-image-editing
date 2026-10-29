/**
 * Regression tests for the pixel diff + image probe module.
 *
 * Numbers are hand-derived from the constructor rasters so a failure points at
 * the implementation, not at a golden file.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Raster } from '../src/core/raster.js';
import { AshopError } from '../src/core/errors.js';
import { computeDiff, diffRaster, ssim, srgbToLinear, linearToSrgb } from '../src/core/diff.js';
import {
  pixelAt,
  regionStats,
  histogram,
  topColors,
  imageSummary,
  pixelDistance,
  assertSameSize,
} from '../src/core/stats.js';

const isUsage = (err) => err instanceof AshopError && err.code === 'E_USAGE';
const isSizeMismatch = (err) => err instanceof AshopError && err.code === 'E_SIZE_MISMATCH';
const close = (actual, expected, eps = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} != ${expected} (eps ${eps})`);

/** Deterministic pseudo-noise so the "identical" case is not a flat fill. */
function pattern(width, height, seed = 0) {
  const r = new Raster(width, height);
  for (let i = 0; i < r.data.length; i++) r.data[i] = (i * 37 + seed * 101 + 13) & 255;
  return r;
}

/** 3x2 fixture with known colours (see comments in the probes below). */
function knownRaster() {
  const r = new Raster(3, 2);
  r.set(0, 0, [255, 0, 0, 255]);     // A opaque red
  r.set(1, 0, [0, 255, 0, 255]);     // B opaque green
  r.set(2, 0, [0, 0, 0, 0]);         // C fully transparent
  r.set(0, 1, [0, 0, 255, 128]);     // D half-transparent blue
  r.set(1, 1, [10, 20, 30, 0]);      // E transparent, hidden RGB
  r.set(2, 1, [255, 255, 255, 255]); // F opaque white
  return r;
}

// ---------------------------------------------------------------------------
// computeDiff
// ---------------------------------------------------------------------------

test('computeDiff: identical rasters are a clean pass', () => {
  const a = pattern(8, 8, 1);
  const d = computeDiff(a, a.clone());

  assert.equal(d.width, 8);
  assert.equal(d.height, 8);
  assert.equal(d.identical, true);
  assert.equal(d.pass, true);
  assert.equal(d.metrics.mismatchRatio, 0);
  assert.equal(d.metrics.mae, 0);
  assert.equal(d.metrics.rmse, 0);
  assert.equal(d.metrics.maxDelta, 0);
  assert.deepEqual(d.metrics.channelMae, [0, 0, 0, 0]);
  assert.equal(d.metrics.ssim, 1);
  assert.equal(d.metrics.changedBounds, null);
  assert.equal('diffRaster' in d, false);
});

test('computeDiff: one changed channel pixel gives exact bounds and MAE', () => {
  const a = Raster.create(4, 4, [100, 100, 100, 255]);
  const b = a.clone();
  b.data[b.index(1, 2)] = 200; // R only, |delta| = 100

  const d = computeDiff(a, b);
  assert.equal(d.identical, false);
  assert.equal(d.pass, false); // 1/16 = 0.0625 > default threshold 0.001
  assert.equal(d.metrics.mismatchRatio, 1 / 16);
  assert.equal(d.metrics.maxDelta, 100);
  // abs error spread over 16 pixels * 4 channels, normalised by 255
  close(d.metrics.mae, 100 / 16 / 4 / 255);
  assert.equal(d.metrics.channelMae[0], 100 / 16 / 255);
  assert.deepEqual(d.metrics.channelMae.slice(1), [0, 0, 0]);
  close(d.metrics.rmse, Math.sqrt(100 * 100 / 16 / 4) / 255);
  assert.deepEqual(d.metrics.changedBounds, { x: 1, y: 2, width: 1, height: 1 });
  assert.ok(d.metrics.ssim < 1, 'a changed pixel must lower SSIM');

  // A looser threshold accepts the same image.
  assert.equal(computeDiff(a, b, { threshold: 0.1 }).pass, true);
});

test('computeDiff: tolerance suppresses small deltas but not "identical"', () => {
  const a = Raster.create(4, 4, [100, 100, 100, 255]);
  const b = a.clone();
  b.data[b.index(1, 2)] = 160; // delta 60, under tolerance 100

  const d = computeDiff(a, b, { tolerance: 100 });
  assert.equal(d.identical, false);
  assert.equal(d.metrics.mismatchRatio, 0);
  assert.equal(d.metrics.changedBounds, null);
  assert.equal(d.pass, true);
  close(d.metrics.mae, 60 / 16 / 4 / 255);
  assert.equal(d.metrics.maxDelta, 60);
});

test('computeDiff: all-black vs all-white (all four channels differ)', () => {
  // [0,0,0,0] is literally "all channels zero"; against opaque white every
  // channel moves by 255, so the all-channel MAE is exactly 1.
  const black = Raster.create(8, 8, [0, 0, 0, 0]);
  const white = Raster.create(8, 8, [255, 255, 255, 255]);
  const d = computeDiff(black, white);

  assert.equal(d.identical, false);
  assert.equal(d.pass, false);
  assert.equal(d.metrics.mismatchRatio, 1);
  assert.equal(d.metrics.mae, 1);
  assert.equal(d.metrics.rmse, 1);
  assert.equal(d.metrics.maxDelta, 255);
  assert.deepEqual(d.metrics.channelMae, [1, 1, 1, 1]);
  assert.ok(d.metrics.ssim < 0.01, `expected SSIM near 0, got ${d.metrics.ssim}`);
  assert.deepEqual(d.metrics.changedBounds, { x: 0, y: 0, width: 8, height: 8 });

  // Opaque black vs opaque white leaves alpha equal: 3 of 4 channels move, so
  // MAE is 0.75 -- documented alpha-participating semantics, not a bug.
  const opaqueBlack = computeDiff(Raster.create(8, 8, [0, 0, 0, 255]), white);
  assert.equal(opaqueBlack.metrics.mae, 0.75);
  assert.equal(opaqueBlack.metrics.mismatchRatio, 1);
  assert.ok(opaqueBlack.metrics.ssim < 0.01);
});

test('computeDiff: alpha participates, including transparent-to-transparent RGB', () => {
  const a = Raster.create(2, 2, [0, 0, 0, 0]);
  const b = a.clone();
  b.data[0] = 255; // hidden red under alpha 0

  const d = computeDiff(a, b);
  assert.equal(d.identical, false);
  assert.equal(d.metrics.mismatchRatio, 1 / 4);
  assert.equal(d.metrics.channelMae[0], 1 / 4); // 255 / 4 pixels / 255
  assert.equal(d.metrics.channelMae[3], 0);
  assert.equal(d.metrics.maxDelta, 255);
  // same bytes (including the hidden RGB) is still identical
  assert.equal(computeDiff(a, a.clone()).identical, true);
});

test('computeDiff / ssim / diffRaster: size mismatch is E_SIZE_MISMATCH', () => {
  const small = Raster.create(2, 2, [0, 0, 0, 255]);
  const big = Raster.create(3, 2, [0, 0, 0, 255]);

  assert.throws(() => computeDiff(small, big), isSizeMismatch);
  assert.throws(() => ssim(small, big), isSizeMismatch);
  assert.throws(() => diffRaster(small, big), isSizeMismatch);
  assert.throws(() => assertSameSize(small, big), isSizeMismatch);
  assert.throws(() => computeDiff(small, null), isUsage);
});

test('computeDiff: options gate ssim / diffRaster and validate input', () => {
  const a = pattern(4, 4, 1);
  const b = pattern(4, 4, 2);

  const bare = computeDiff(a, b, { ssim: false, diffImage: true });
  assert.equal('ssim' in bare.metrics, false);
  assert.ok(bare.diffRaster instanceof Raster);
  assert.equal(bare.diffRaster.width, 4);

  assert.throws(() => computeDiff(a, b, { threshold: 2 }), isUsage);
  assert.throws(() => computeDiff(a, b, { threshold: -0.1 }), isUsage);
  assert.throws(() => computeDiff(a, b, { tolerance: -1 }), isUsage);
  assert.throws(() => computeDiff(a, b, { diffImage: true, amplify: 0 }), isUsage);
});

// ---------------------------------------------------------------------------
// diffRaster
// ---------------------------------------------------------------------------

test('diffRaster: unchanged pixels keep the dimmed base, changed pixels light up', () => {
  const a = Raster.create(4, 3, [100, 100, 100, 255]);
  const b = a.clone();
  b.set(2, 1, [255, 100, 100, 255]); // R delta 155 -> amplified 255 (clamped)

  const img = diffRaster(a, b);
  assert.equal(img.width, 4);
  assert.equal(img.height, 3);
  // Y(100,100,100) = 100, base = 25
  assert.deepEqual(img.get(0, 0), [25, 25, 25, 255]);
  assert.deepEqual(img.get(3, 2), [25, 25, 25, 255]);
  assert.deepEqual(img.get(0, 2), [25, 25, 25, 255]);

  const changed = img.get(2, 1);
  assert.deepEqual(changed, [255, 255, 56, 255]);
  assert.notDeepEqual(changed, [25, 25, 25, 255]);

  // identical inputs -> uniform dimmed base
  const flat = diffRaster(a, a.clone());
  assert.deepEqual(flat.get(2, 1), [25, 25, 25, 255]);

  // deterministic, and amplify 1 is visibly weaker than amplify 4
  const soft = diffRaster(a, b, { amplify: 1 });
  assert.deepEqual(soft.get(2, 1), diffRaster(a, b, { amplify: 1 }).get(2, 1));
  assert.ok(soft.get(2, 1)[0] < changed[0]);
});

test('diffRaster: pure alpha differences show up too', () => {
  const a = Raster.create(2, 1, [50, 60, 70, 255]);
  const b = a.clone();
  b.set(0, 0, [50, 60, 70, 0]);
  const img = diffRaster(a, b);
  // base = Y(50,60,70) * 0.25 = 58.15 * 0.25 = 14.5375 -> 15
  assert.deepEqual(img.get(1, 0), [15, 15, 15, 255]);
  const lit = img.get(0, 0);
  assert.ok(lit[0] > 15 && lit[1] > 15);
  assert.equal(lit[3], 255);
  assert.notDeepEqual(lit, [15, 15, 15, 255]);
});

// ---------------------------------------------------------------------------
// ssim
// ---------------------------------------------------------------------------

test('ssim: identical luminance is exactly 1, incl. smaller-than-window images', () => {
  const a = pattern(5, 3, 7);
  assert.equal(ssim(a, a.clone()), 1);

  const tiny = Raster.create(1, 1, [12, 34, 56, 255]);
  assert.equal(ssim(tiny, tiny.clone()), 1);

  // alpha is ignored by SSIM: same RGB with different alpha is still 1
  const transparent = Raster.create(1, 1, [12, 34, 56, 0]);
  assert.equal(ssim(tiny, transparent), 1);
});

test('ssim: optional window/sigma overrides work and are validated', () => {
  const a = pattern(6, 6, 3);
  assert.equal(ssim(a, a.clone(), { window: 5, sigma: 2 }), 1);
  assert.throws(() => ssim(a, a.clone(), { window: 0 }), isUsage);
  assert.throws(() => ssim(a, a.clone(), { window: 2.5 }), isUsage);
  assert.throws(() => ssim(a, a.clone(), { sigma: 0 }), isUsage);
});

test('sRGB transfer helpers round-trip (normalised 0..1)', () => {
  assert.equal(srgbToLinear(0), 0);
  close(linearToSrgb(1), 1, 1e-15);
  close(srgbToLinear(0.5), 0.21404114048223255, 1e-12);
  // 0.04045 is the piecewise seam, where a round-trip loses ~3e-8.
  for (const v of [0, 0.02, 0.04045, 0.18, 0.5, 1]) {
    close(linearToSrgb(srgbToLinear(v)), v, 1e-6);
  }
});

// ---------------------------------------------------------------------------
// stats: pixelAt
// ---------------------------------------------------------------------------

test('pixelAt: in-bounds pixel and out-of-bounds fallback', () => {
  const known = knownRaster();

  const red = pixelAt(known, 0, 0);
  assert.equal(red.inBounds, true);
  assert.deepEqual(red.rgba, [255, 0, 0, 255]);
  assert.equal(red.hex, '#ff0000');

  const blue = pixelAt(known, 0, 1);
  assert.deepEqual(blue.rgba, [0, 0, 255, 128]);
  assert.equal(blue.hex, '#0000ff80');

  const outside = pixelAt(known, 9, 9);
  assert.equal(outside.inBounds, false);
  assert.deepEqual(outside.rgba, [0, 0, 0, 0]);
  assert.equal(outside.hex, '#00000000');

  const negative = pixelAt(known, -1, 0);
  assert.equal(negative.inBounds, false);

  // coordinates are floored
  assert.deepEqual(pixelAt(known, 0.9, 0.2).rgba, [255, 0, 0, 255]);
});

// ---------------------------------------------------------------------------
// stats: regionStats
// ---------------------------------------------------------------------------

test('regionStats: whole known raster (hand-computed moments)', () => {
  const known = knownRaster();
  const s = regionStats(known, { x: 0, y: 0, width: 3, height: 2 });

  assert.equal(s.width, 3);
  assert.equal(s.height, 2);
  assert.equal(s.pixels, 6);
  close(s.alphaCoverage, 4 / 6); // A, B, D, F painted; C and E transparent

  // RGB over painted pixels: (255+0+0+255)/4 = 127.5 for each channel
  // alpha over all 6: (255+255+0+128+0+255)/6 = 893/6
  assert.deepEqual(s.mean, [127.5, 127.5, 127.5, 893 / 6]);
  assert.deepEqual(s.min, [0, 0, 0, 0]);
  assert.deepEqual(s.max, [255, 255, 255, 255]);
  // R values 255,0,0,255: population stddev = 127.5
  // alpha squares 255^2*3 + 128^2 = 211459 over 6 pixels
  assert.deepEqual(s.stdDev, [127.5, 127.5, 127.5, Math.sqrt(211459 / 6 - (893 / 6) ** 2)]);
  assert.deepEqual(s.opaqueBounds, { x: 0, y: 0, width: 3, height: 2 });
});

test('regionStats: sub-rect keeps absolute bounds and splits RGB/alpha semantics', () => {
  const known = knownRaster();
  const s = regionStats(known, { x: 0, y: 1, width: 2, height: 1 }); // D (alpha 128) + E (alpha 0)

  assert.equal(s.width, 2);
  assert.equal(s.height, 1);
  assert.equal(s.pixels, 2);
  close(s.alphaCoverage, 0.5);
  assert.deepEqual(s.mean, [0, 0, 255, 64]); // RGB from D only; alpha (128+0)/2
  assert.deepEqual(s.min, [0, 0, 255, 0]);
  assert.deepEqual(s.max, [0, 0, 255, 128]);
  assert.deepEqual(s.stdDev, [0, 0, 0, 64]);
  assert.deepEqual(s.opaqueBounds, { x: 0, y: 1, width: 1, height: 1 });
});

test('regionStats: alphaThreshold is exclusive for RGB inclusion', () => {
  const known = knownRaster();
  const s = regionStats(known, { x: 0, y: 0, width: 3, height: 2 }, { alphaThreshold: 128 });

  close(s.alphaCoverage, 3 / 6); // D has alpha exactly 128 -> not painted
  assert.deepEqual(s.mean, [170, 170, 85, 893 / 6]);
  assert.deepEqual(s.opaqueBounds, { x: 0, y: 0, width: 3, height: 2 }); // A, B, F
});

test('regionStats: region with nothing painted reports zeros and null bounds', () => {
  const known = knownRaster();
  const s = regionStats(known, { x: 2, y: 0, width: 1, height: 1 }); // C only

  assert.equal(s.pixels, 1);
  assert.equal(s.alphaCoverage, 0);
  assert.deepEqual(s.mean, [0, 0, 0, 0]);
  assert.deepEqual(s.min, [0, 0, 0, 0]);
  assert.deepEqual(s.max, [0, 0, 0, 0]);
  assert.deepEqual(s.stdDev, [0, 0, 0, 0]);
  assert.equal(s.opaqueBounds, null);
});

test('regionStats: out-of-bounds rect is clipped, not rejected', () => {
  const known = knownRaster();
  // {x:-2,y:-1,w:4,h:3} clips to x 0..2 (width 2), y 0..2 (height 2)
  // -> A, B, D, E  => mean RGB 85 each, mean alpha (255+255+128+0)/4
  const s = regionStats(known, { x: -2, y: -1, width: 4, height: 3 });

  assert.equal(s.width, 2);
  assert.equal(s.height, 2);
  assert.equal(s.pixels, 4);
  close(s.alphaCoverage, 3 / 4);
  assert.deepEqual(s.mean, [85, 85, 85, 159.5]);
  assert.deepEqual(s.opaqueBounds, { x: 0, y: 0, width: 2, height: 2 });
});

test('regionStats: empty rect, invalid rect or fully-outside rect is E_USAGE', () => {
  const known = knownRaster();
  assert.throws(() => regionStats(known, null), isUsage);
  assert.throws(() => regionStats(known, undefined), isUsage);
  assert.throws(() => regionStats(known, { x: 0, y: 0, width: 0, height: 2 }), isUsage);
  assert.throws(() => regionStats(known, { x: 0, y: 0, width: 2, height: -3 }), isUsage);
  assert.throws(() => regionStats(known, { x: 10, y: 10, width: 2, height: 2 }), isUsage);
  assert.throws(() => regionStats(known, { x: 0, y: 0, width: 2 }), isUsage);
});

// ---------------------------------------------------------------------------
// stats: histogram
// ---------------------------------------------------------------------------

test('histogram: 4-bin counts are hand-verified', () => {
  const known = knownRaster();
  const h = histogram(known, { bins: 4 });

  // R/G/B skip fully transparent pixels (C and E):
  //   r: A=255 (bin 3), B=0 (bin 0), D=0 (bin 0), F=255 (bin 3)
  //   a: all 6 pixels -> 0,0 (bin 0); 128 (bin 2); 255,255,255 (bin 3)
  assert.deepEqual(h, {
    r: [2, 0, 0, 2],
    g: [2, 0, 0, 2],
    b: [2, 0, 0, 2],
    a: [2, 0, 1, 3],
  });
});

test('histogram: channel subset, defaults and validation', () => {
  const known = knownRaster();
  assert.deepEqual(histogram(known, { bins: 4, channel: ['r', 'a'] }), {
    r: [2, 0, 0, 2],
    a: [2, 0, 1, 3],
  });
  assert.deepEqual(Object.keys(histogram(known, { bins: 4, channel: 'g' })), ['g']);

  const full = histogram(known);
  assert.equal(full.r.length, 256);
  assert.equal(full.a.length, 256);
  assert.equal(full.r.reduce((sum, v) => sum + v, 0), 4); // painted pixels only
  assert.equal(full.a.reduce((sum, v) => sum + v, 0), 6); // every pixel

  assert.throws(() => histogram(known, { bins: 0 }), isUsage);
  assert.throws(() => histogram(known, { bins: 2.5 }), isUsage);
  assert.throws(() => histogram(known, { channel: 'x' }), isUsage);
  assert.throws(() => histogram(known, { channel: [] }), isUsage);
});

// ---------------------------------------------------------------------------
// stats: topColors
// ---------------------------------------------------------------------------

test('topColors: quantised bucket reports mean colour and count', () => {
  const dom = new Raster(2, 2);
  // 10/11, 20/21, 30/31 all land in the same 16-wide buckets
  dom.set(0, 0, [10, 20, 30, 255]);
  dom.set(1, 0, [11, 21, 31, 255]);
  dom.set(0, 1, [11, 21, 31, 255]);
  dom.set(1, 1, [11, 21, 31, 255]);

  assert.deepEqual(topColors(dom), [{
    rgba: [11, 21, 31, 255], // rounded bucket means
    hex: '#0b151f',
    count: 4,
    ratio: 1,
  }]);
});

test('topColors: descending counts, deterministic tie-break, minAlpha filter', () => {
  const known = knownRaster();
  const all = topColors(known);
  assert.equal(all.length, 4);
  assert.deepEqual(all.map((e) => e.count), [1, 1, 1, 1]);
  assert.deepEqual(all.map((e) => e.ratio), [0.25, 0.25, 0.25, 0.25]);
  // ties break on the quantised colour key ascending
  assert.deepEqual(all.map((e) => e.hex), ['#0000ff80', '#00ff00', '#ff0000', '#ffffff']);
  assert.deepEqual(all.map((e) => e.rgba[3]), [128, 255, 255, 255]);

  const opaqueOnly = topColors(known, { minAlpha: 200 });
  assert.equal(opaqueOnly.length, 3);
  assert.ok(opaqueOnly.every((e) => e.ratio === 1 / 3));

  assert.equal(topColors(known, { limit: 2 }).length, 2);
  assert.deepEqual(topColors(Raster.create(2, 2)), []);

  assert.throws(() => topColors(known, { limit: 0 }), isUsage);
  assert.throws(() => topColors(known, { quantize: 0 }), isUsage);
  assert.throws(() => topColors(known, { quantize: 300 }), isUsage);
});

// ---------------------------------------------------------------------------
// stats: imageSummary / pixelDistance / assertSameSize
// ---------------------------------------------------------------------------

test('imageSummary: known raster and fully transparent raster', () => {
  const known = knownRaster();
  const s = imageSummary(known);
  assert.equal(s.width, 3);
  assert.equal(s.height, 2);
  assert.equal(s.hasAlpha, true);
  close(s.alphaCoverage, 4 / 6);
  assert.equal(s.isEmpty, false);
  assert.equal(s.pixelHash, known.pixelHash());
  assert.deepEqual(s.meanColor, [127.5, 127.5, 127.5, 893 / 6]);
  assert.deepEqual(s.dominantColor, [0, 0, 255, 128]);

  const empty = Raster.create(2, 2);
  const e = imageSummary(empty);
  assert.equal(e.hasAlpha, true); // alpha 0 everywhere is still "not opaque"
  assert.equal(e.alphaCoverage, 0);
  assert.equal(e.isEmpty, true);
  assert.equal(e.dominantColor, null);
  assert.deepEqual(e.meanColor, [0, 0, 0, 0]);
  assert.equal(e.pixelHash, empty.pixelHash());

  const opaque = imageSummary(Raster.create(1, 1, [1, 2, 3, 255]));
  assert.equal(opaque.hasAlpha, false);
  assert.deepEqual(opaque.dominantColor, [1, 2, 3, 255]);
  assert.equal(opaque.pixelHash.length, 64);
});

test('pixelDistance: RGB euclidean distance, alpha ignored', () => {
  close(pixelDistance([0, 0, 0], [255, 255, 255]), Math.sqrt(3 * 255 * 255));
  assert.equal(pixelDistance([1, 2, 3], [4, 6, 3]), 5);
  assert.equal(pixelDistance([1, 2, 3, 255], [1, 2, 3, 0]), 0);
  assert.throws(() => pixelDistance([1, 2], [1, 2]), isUsage);
  assert.throws(() => pixelDistance(null, [0, 0, 0]), isUsage);
});

test('assertSameSize: rejects non-rasters with E_USAGE', () => {
  assert.throws(() => assertSameSize(null, null), isUsage);
  assert.throws(() => assertSameSize({ width: 1 }, { width: 1 }), isUsage);
});
