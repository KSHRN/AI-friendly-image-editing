import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Raster } from '../src/core/raster.js';
import { Mask } from '../src/core/mask.js';
import { AshopError } from '../src/core/errors.js';
import {
  rectMask,
  ellipseMask,
  polygonMask,
  pathMask,
  colorRangeMask,
  luminanceMask,
  alphaMask,
  floodFillMask,
} from '../src/core/rasterize.js';
import {
  combine,
  invertMask,
  featherMask,
  growMask,
  shrinkMask,
  borderMask,
  thresholdMask,
  maskStats,
} from '../src/core/maskops.js';

// --- helpers --------------------------------------------------------------

const sumMask = (m) => {
  let s = 0;
  for (let i = 0; i < m.data.length; i++) s += m.data[i];
  return s;
};
/** Coverage-weighted area in pixels (sum of coverage / 255). */
const area = (m) => sumMask(m) / 255;
const near = (actual, expected, tolerance, label) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`,
  );
};
const isUsageError = (err) => err instanceof AshopError && err.code === 'E_USAGE';

function starPoints(cx, cy, outer, inner, spikes = 5) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / spikes;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// --- rectangles -----------------------------------------------------------

describe('rectMask', () => {
  it('covers a full canvas at 255 with the right bounds', () => {
    const m = rectMask(20, 20, { x: 0, y: 0, width: 20, height: 20 });
    assert.equal(m.width, 20);
    assert.equal(m.height, 20);
    assert.equal(sumMask(m), 20 * 20 * 255);
    assert.deepEqual(m.alphaBounds(), { x: 0, y: 0, width: 20, height: 20 });
  });

  it('anti-aliases fractional edges analytically', () => {
    const m = rectMask(12, 12, { x: 2.5, y: 3, width: 5, height: 4 });
    near(area(m), 20, 0.1, 'area');
    assert.deepEqual(m.alphaBounds(), { x: 2, y: 3, width: 6, height: 4 });
    assert.equal(m.get(2, 3), 128); // half-covered left column
    assert.equal(m.get(3, 3), 255);
    assert.equal(m.get(7, 3), 128); // half-covered right column
    assert.equal(m.get(2, 2), 0);
  });

  it('clips rectangles that extend past the canvas', () => {
    const m = rectMask(10, 10, { x: -5, y: -5, width: 8, height: 8 });
    near(area(m), 9, 1e-6, 'area');
    assert.deepEqual(m.alphaBounds(), { x: 0, y: 0, width: 3, height: 3 });
  });

  it('normalises negative extents', () => {
    const m = rectMask(10, 10, { x: 8, y: 8, width: -3, height: -3 });
    near(area(m), 9, 1e-6, 'area');
    assert.deepEqual(m.alphaBounds(), { x: 5, y: 5, width: 3, height: 3 });
  });

  it('rejects malformed rects with E_USAGE', () => {
    assert.throws(() => rectMask(10, 10, { x: 1, y: 2, width: NaN, height: 3 }), isUsageError);
    assert.throws(() => rectMask(0, 10, { x: 0, y: 0, width: 1, height: 1 }), isUsageError);
  });
});

// --- ellipses -------------------------------------------------------------

describe('ellipseMask', () => {
  it('matches the analytic area and bounds', () => {
    const m = ellipseMask(80, 80, { cx: 40, cy: 40, rx: 25, ry: 15 });
    near(area(m), Math.PI * 25 * 15, Math.PI * 25 * 15 * 0.02, 'ellipse area');
    const b = m.alphaBounds();
    near(b.x, 15, 1, 'bounds.x');
    near(b.width, 50, 1, 'bounds.width');
    near(b.y, 25, 1, 'bounds.y');
    near(b.height, 30, 1, 'bounds.height');
  });

  it('is left-right and top-bottom symmetric', () => {
    const m = ellipseMask(80, 80, { cx: 40, cy: 40, rx: 25, ry: 15 });
    let maxDiff = 0;
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        maxDiff = Math.max(maxDiff, Math.abs(m.get(x, y) - m.get(79 - x, y)));
        maxDiff = Math.max(maxDiff, Math.abs(m.get(x, y) - m.get(x, 79 - y)));
      }
    }
    assert.ok(maxDiff <= 1, `ellipse symmetry deviation ${maxDiff}`);
  });

  it('preserves area under rotation', () => {
    const m = ellipseMask(100, 100, { cx: 50, cy: 50, rx: 30, ry: 10, rotation: 30 });
    near(area(m), Math.PI * 30 * 10, Math.PI * 30 * 10 * 0.02, 'rotated ellipse area');
    const b = m.alphaBounds();
    assert.ok(b && b.width > 0 && b.height > 0);
  });

  it('returns an empty mask for degenerate radii or fully off-canvas ellipses', () => {
    assert.equal(rectMask(10, 10, { x: 0, y: 0, width: 0, height: 0 }).isEmpty(), true);
    assert.equal(ellipseMask(10, 10, { cx: 5, cy: 5, rx: 0, ry: 3 }).isEmpty(), true);
    assert.equal(ellipseMask(10, 10, { cx: 100, cy: 100, rx: 5, ry: 5 }).isEmpty(), true);
  });
});

// --- polygons -------------------------------------------------------------

describe('polygonMask', () => {
  it('rasterizes a triangle within 2% of its analytic area', () => {
    const m = polygonMask(60, 60, [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 30, y: 45 },
    ]);
    near(area(m), 700, 700 * 0.02, 'triangle area');
    const b = m.alphaBounds();
    near(b.x, 10, 1, 'bounds.x');
    near(b.width, 40, 1, 'bounds.width');
    near(b.y, 10, 1, 'bounds.y');
    near(b.height, 35, 1, 'bounds.height');
  });

  it('gives identical results for nonzero and evenodd on a simple polygon', () => {
    const pts = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 30, y: 45 },
    ];
    const nz = polygonMask(60, 60, pts, { fillRule: 'nonzero' });
    const eo = polygonMask(60, 60, pts, { fillRule: 'evenodd' });
    assert.deepEqual(Array.from(nz.data), Array.from(eo.data));
  });

  it('fills a self-intersecting star differently for nonzero vs evenodd', () => {
    // A pentagram: vertices of a regular pentagon connected every second step,
    // so its five edges cross each other and enclose a pentagonal core.
    const pts = [];
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI * 2) / 5;
      pts.push({ x: 60 + 45 * Math.cos(a), y: 60 + 45 * Math.sin(a) });
    }
    const nz = polygonMask(120, 120, pts, { fillRule: 'nonzero' });
    const eo = polygonMask(120, 120, pts, { fillRule: 'evenodd' });
    const nzArea = area(nz);
    const eoArea = area(eo);
    assert.ok(nzArea > 0 && eoArea > 0);
    // The pentagonal core is filled by nonzero winding and empty under evenodd.
    assert.ok(nzArea > eoArea + 100, `nonzero ${nzArea} should exceed evenodd ${eoArea}`);
    // The core hole is roughly a third of the star silhouette.
    assert.ok((nzArea - eoArea) / nzArea > 0.15);
  });

  it('rejects bad fill rules and bad points with E_USAGE', () => {
    assert.throws(() => polygonMask(10, 10, [{ x: 0, y: 0 }], { fillRule: 'bogus' }), isUsageError);
    assert.throws(() => polygonMask(10, 10, [{ x: 0 }]), isUsageError);
    assert.throws(() => polygonMask(10, 10, 'nope'), isUsageError);
  });
});

// --- SVG paths ------------------------------------------------------------

describe('pathMask', () => {
  it('matches rectMask for an axis-aligned rectangle path', () => {
    const path = pathMask(60, 60, 'M10 10 L50 10 L50 50 L10 50 Z');
    const rect = rectMask(60, 60, { x: 10, y: 10, width: 40, height: 40 });
    near(area(path), 1600, 1, 'path rect area');
    assert.deepEqual(path.alphaBounds(), rect.alphaBounds());
    assert.deepEqual(Array.from(path.data), Array.from(rect.data));
  });

  it('supports relative commands, H/V shortcuts and implicit lineto', () => {
    const base = pathMask(60, 60, 'M10 10 L50 10 L50 50 L10 50 Z');
    const relative = pathMask(60, 60, 'm10 10 l40 0 l0 40 l-40 0 z');
    const shorthand = pathMask(60, 60, 'M10 10 H50 V50 H10 Z');
    const implicit = pathMask(60, 60, 'M10 10 50 10 50 50 10 50 Z');
    assert.deepEqual(Array.from(relative.data), Array.from(base.data));
    assert.deepEqual(Array.from(shorthand.data), Array.from(base.data));
    assert.deepEqual(Array.from(implicit.data), Array.from(base.data));
  });

  it('flattens cubic, quadratic and arc commands', () => {
    const cubic = pathMask(60, 60, 'M10 50 C 10 20, 50 20, 50 50 Z');
    // Exact area of this cubic arch above its chord is 720 (see integral of
    // (50 - y) dx over the Bezier); allow a little AA/raster error.
    near(area(cubic), 720, 8, 'cubic segment area');
    const b = cubic.alphaBounds();
    assert.ok(b && b.x >= 8 && b.x + b.width <= 52);
    assert.ok(b && b.y >= 20 && b.y + b.height <= 51);

    const quad = pathMask(60, 60, 'M10 50 Q 30 10 50 50 Z');
    // Exact area = 1600/3 ~= 533.33.
    near(area(quad), 533.33, 8, 'quadratic segment area');

    const arc = pathMask(60, 60, 'M10 50 A 20 20 0 0 1 50 50 Z');
    near(area(arc), (Math.PI * 20 * 20) / 2, 15, 'semicircle area');
    const ab = arc.alphaBounds();
    near(ab.width, 40, 2, 'arc bounds.width');
    near(ab.height, 20, 2, 'arc bounds.height');
  });

  it('supports smooth curves, T and multiple subpaths with holes', () => {
    const mixed = pathMask(
      220,
      160,
      'M20 80 C 30 20, 60 20, 70 80 S 110 140 130 80 Q 150 40 160 80 T 190 80 A 15 15 0 0 1 200 95 Z',
    );
    assert.ok(!mixed.isEmpty(), 'mixed path should produce coverage');
    assert.ok(mixed.alphaBounds().width > 50);

    const outer = 'M10 10 L50 10 L50 50 L10 50 Z';
    const inner = 'M20 20 L40 20 L40 40 L20 40 Z';
    const holeEvenOdd = pathMask(60, 60, `${outer} ${inner}`, { fillRule: 'evenodd' });
    const holeNonZero = pathMask(60, 60, `${outer} ${inner}`, { fillRule: 'nonzero' });
    near(area(holeEvenOdd), 1600 - 400, 4, 'evenodd frame area');
    near(area(holeNonZero), 1600, 4, 'nonzero filled area');
  });

  it('rejects illegal path data with E_USAGE', () => {
    assert.throws(() => pathMask(20, 20, 'M 10'), isUsageError);
    assert.throws(() => pathMask(20, 20, 'M0 0 X10 10'), isUsageError);
    assert.throws(() => pathMask(20, 20, ''), isUsageError);
    assert.throws(() => pathMask(20, 20, 'L 10 10'), isUsageError);
    assert.throws(() => pathMask(20, 20, 'M0 0 A 5 5 0 2 1 10 10'), isUsageError);
    assert.throws(() => pathMask(20, 20, 42), isUsageError);
  });
});

// --- content-derived masks ------------------------------------------------

describe('colorRangeMask', () => {
  function makeRaster() {
    const r = Raster.create(40, 20, [10, 20, 30, 255]);
    for (let y = 5; y < 15; y++) {
      for (let x = 5; x < 15; x++) r.set(x, y, [200, 100, 50, 255]);
    }
    r.set(20, 5, [200, 101, 50, 255]); // distance 1
    r.set(21, 5, [208, 100, 50, 255]); // distance 8
    r.set(22, 5, [218, 100, 50, 255]); // distance 18
    return r;
  }

  it('selects exactly the target colour at tolerance 0', () => {
    const m = colorRangeMask(makeRaster(), { color: [200, 100, 50], tolerance: 0 });
    near(area(m), 100, 1e-6, 'target area');
    assert.equal(m.get(5, 5), 255);
    assert.equal(m.get(20, 5), 0); // adjacent colour, distance 1
    assert.equal(m.get(21, 5), 0); // distance 8
    assert.equal(m.get(22, 5), 0); // distance 18
    assert.equal(m.get(0, 0), 0); // background
  });

  it('extends the full selection by tolerance and fades over the next 16 units', () => {
    const m = colorRangeMask(makeRaster(), { color: [200, 100, 50], tolerance: 2 });
    assert.equal(m.get(20, 5), 255); // distance 1 <= 2
    assert.equal(m.get(21, 5), 159); // distance 8: 255 * (1 - 6/16)
    assert.equal(m.get(22, 5), 0); // distance 18: beyond tolerance + 16
    near(area(m), 100 + 1 + 159 / 255, 0.01, 'tolerance area');
  });

  it('supports the luma metric', () => {
    const r = Raster.create(3, 1);
    r.set(0, 0, [100, 100, 100, 255]);
    r.set(1, 0, [200, 200, 200, 255]);
    r.set(2, 0, [50, 50, 50, 255]);
    const m = colorRangeMask(r, { color: [0, 0, 0], tolerance: 100, metric: 'luma' });
    assert.equal(m.get(0, 0), 255); // luma distance 100
    assert.equal(m.get(1, 0), 0); // 200 > 100 + 16
    assert.equal(m.get(2, 0), 255); // 50 <= 100
  });

  it('reports lab as unimplemented and validates input', () => {
    assert.throws(
      () => colorRangeMask(makeRaster(), { color: [0, 0, 0], tolerance: 0, metric: 'lab' }),
      (err) => isUsageError(err) && /lab/.test(err.message),
    );
    assert.throws(() => colorRangeMask(makeRaster(), { color: [0, 0], tolerance: 0 }), isUsageError);
    assert.throws(() => colorRangeMask(makeRaster(), { color: [0, 0, 0], tolerance: -1 }), isUsageError);
    assert.throws(() => colorRangeMask(makeRaster(), { color: [0, 0, 0], metric: 'hsv' }), isUsageError);
  });
});

describe('luminanceMask / alphaMask', () => {
  it('thresholds luminance with an optional soft edge', () => {
    const r = Raster.create(256, 1);
    for (let x = 0; x < 256; x++) r.set(x, 0, [x, x, x, 255]);

    const hard = luminanceMask(r, { threshold: 128 });
    assert.equal(hard.get(127, 0), 0);
    assert.equal(hard.get(128, 0), 255);

    const soft = luminanceMask(r, { threshold: 128, softness: 64 });
    assert.equal(soft.get(63, 0), 0);
    assert.equal(soft.get(96, 0), 128); // halfway through the ramp
    assert.equal(soft.get(127, 0), 251);
    assert.equal(soft.get(128, 0), 255);
  });

  it('thresholds the alpha channel', () => {
    const r = Raster.create(4, 1);
    const alphas = [0, 64, 128, 255];
    for (let x = 0; x < 4; x++) r.set(x, 0, [10, 20, 30, alphas[x]]);

    const hard = alphaMask(r, { threshold: 100 });
    assert.deepEqual(Array.from(hard.data), [0, 0, 255, 255]);

    const soft = alphaMask(r, { threshold: 100, softness: 50 });
    assert.deepEqual(Array.from(soft.data), [0, 71, 255, 255]); // (64-50)/50*255
  });
});

describe('floodFillMask', () => {
  function twoBlocks() {
    const r = Raster.create(30, 30, [10, 10, 10, 255]);
    for (let y = 2; y < 7; y++) {
      for (let x = 2; x < 7; x++) r.set(x, y, [200, 0, 0, 255]);
    }
    for (let y = 20; y < 25; y++) {
      for (let x = 20; x < 25; x++) r.set(x, y, [200, 0, 0, 255]);
    }
    return r;
  }

  it('selects only the 4-connected region containing the seed', () => {
    const m = floodFillMask(twoBlocks(), { x: 3, y: 3, tolerance: 0 });
    near(area(m), 25, 1e-6, 'block area');
    assert.deepEqual(m.alphaBounds(), { x: 2, y: 2, width: 5, height: 5 });
    assert.equal(m.get(20, 20), 0);
    assert.equal(m.get(0, 0), 0);
  });

  it('floods the background without leaking into differently coloured regions', () => {
    const m = floodFillMask(twoBlocks(), { x: 0, y: 0, tolerance: 0 });
    near(area(m), 30 * 30 - 50, 1e-6, 'background area');
    assert.equal(m.get(3, 3), 0);
    assert.equal(m.get(22, 22), 0);
  });

  it('respects tolerance, and tolerance 0 selects only identical colours', () => {
    const r = Raster.create(10, 10, [10, 10, 10, 255]);
    r.set(5, 5, [12, 10, 10, 255]); // Euclidean distance 2
    const strict = floodFillMask(r, { x: 0, y: 0, tolerance: 0 });
    near(area(strict), 99, 1e-6, 'strict area');
    assert.equal(strict.get(5, 5), 0);
    const loose = floodFillMask(r, { x: 0, y: 0, tolerance: 2 });
    assert.equal(loose.get(5, 5), 255);
    near(area(loose), 100, 1e-6, 'tolerant area');
  });

  it('can flood on layer alpha instead of colour', () => {
    const r = Raster.create(10, 1);
    for (let x = 0; x < 10; x++) r.set(x, 0, [5, 5, 5, x < 5 ? 255 : 128]);
    const byAlpha = floodFillMask(r, { x: 0, y: 0, tolerance: 0, sampleLayerAlpha: true });
    near(area(byAlpha), 5, 1e-6, 'alpha flood area');
    const byColor = floodFillMask(r, { x: 0, y: 0, tolerance: 0 });
    near(area(byColor), 10, 1e-6, 'colour flood area');
  });

  it('rejects out-of-canvas seeds', () => {
    assert.throws(() => floodFillMask(twoBlocks(), { x: -1, y: 0 }), isUsageError);
    assert.throws(() => floodFillMask(twoBlocks(), { x: 30, y: 0 }), isUsageError);
    assert.throws(() => floodFillMask(twoBlocks(), { x: 1.5, y: 0 }), isUsageError);
  });
});

// --- boolean combination --------------------------------------------------

describe('combine', () => {
  const A = new Mask(2, 2, Uint8ClampedArray.from([0, 255, 100, 150]));
  const B = new Mask(2, 2, Uint8ClampedArray.from([255, 0, 150, 100]));

  it('implements replace per pixel', () => {
    assert.deepEqual(Array.from(combine(A, B, 'replace').data), [255, 0, 150, 100]);
  });

  it('implements add as a clamped sum', () => {
    assert.deepEqual(Array.from(combine(A, B, 'add').data), [255, 255, 250, 250]);
  });

  it('implements subtract as a clamped difference', () => {
    assert.deepEqual(Array.from(combine(A, B, 'subtract').data), [0, 255, 0, 50]);
  });

  it('implements intersect as round(a*b/255)', () => {
    assert.deepEqual(Array.from(combine(A, B, 'intersect').data), [0, 0, 59, 59]);
  });

  it('implements xor as |a-b|', () => {
    assert.deepEqual(Array.from(combine(A, B, 'xor').data), [255, 255, 50, 50]);
  });

  it('reduces to boolean set ops on binary masks', () => {
    const a = new Mask(4, 1, Uint8ClampedArray.from([0, 0, 255, 255]));
    const b = new Mask(4, 1, Uint8ClampedArray.from([0, 255, 0, 255]));
    assert.deepEqual(Array.from(combine(a, b, 'add').data), [0, 255, 255, 255]);
    assert.deepEqual(Array.from(combine(a, b, 'subtract').data), [0, 0, 255, 0]);
    assert.deepEqual(Array.from(combine(a, b, 'intersect').data), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(combine(a, b, 'xor').data), [0, 255, 255, 0]);
  });

  it('throws E_SIZE_MISMATCH for different canvas sizes', () => {
    const small = new Mask(2, 2);
    const other = new Mask(3, 3);
    assert.throws(
      () => combine(small, other, 'add'),
      (err) => err instanceof AshopError && err.code === 'E_SIZE_MISMATCH',
    );
  });

  it('throws E_USAGE for unknown ops and non-masks', () => {
    assert.throws(() => combine(A, B, 'blend'), isUsageError);
    assert.throws(() => combine(A, { width: 2, height: 2 }, 'add'), isUsageError);
  });
});

// --- invert / feather / morphology ---------------------------------------

describe('invertMask', () => {
  it('inverts coverage', () => {
    const m = new Mask(3, 1, Uint8ClampedArray.from([0, 100, 255]));
    assert.deepEqual(Array.from(invertMask(m).data), [255, 155, 0]);
    assert.deepEqual(Array.from(m.data), [0, 100, 255]); // input untouched
  });
});

describe('featherMask', () => {
  it('conserves total coverage and softens the edge', () => {
    const mask = rectMask(100, 100, { x: 40, y: 40, width: 20, height: 20 });
    const before = sumMask(mask);
    const out = featherMask(mask, 5);
    const after = sumMask(out);
    assert.ok(Math.abs(after - before) / before < 0.1, `coverage lost: ${before} -> ${after}`);
    assert.equal(out.data.length, mask.data.length);
    assert.equal(out.get(50, 50), 255); // centre stays fully selected
    assert.equal(out.get(0, 0), 0); // far away stays empty
    const edge = out.get(40, 50);
    assert.ok(edge > 0 && edge < 255, `edge should be soft, got ${edge}`);
    assert.ok(out.get(41, 50) >= out.get(40, 50)); // monotone into the selection
  });

  it('returns a clone for radius <= 0', () => {
    const mask = rectMask(10, 10, { x: 2, y: 2, width: 5, height: 5 });
    const out = featherMask(mask, 0);
    assert.notEqual(out, mask);
    assert.deepEqual(Array.from(out.data), Array.from(mask.data));
  });

  it('keeps every value inside 0..255', () => {
    const mask = new Mask(9, 1, Uint8ClampedArray.from([0, 0, 255, 0, 0, 255, 255, 0, 0]));
    const out = featherMask(mask, 2);
    for (let i = 0; i < out.data.length; i++) {
      assert.ok(out.data[i] >= 0 && out.data[i] <= 255);
    }
  });
});

describe('growMask / shrinkMask', () => {
  const mask = rectMask(100, 100, { x: 40, y: 40, width: 20, height: 20 });

  it('grows bounds outward by about radius', () => {
    const out = growMask(mask, 5);
    const b = out.alphaBounds();
    assert.deepEqual(b, { x: 35, y: 35, width: 30, height: 30 });
    for (let i = 0; i < out.data.length; i++) assert.ok(out.data[i] === 0 || out.data[i] === 255);
  });

  it('shrinks bounds inward by about radius', () => {
    const out = shrinkMask(mask, 5);
    assert.deepEqual(out.alphaBounds(), { x: 45, y: 45, width: 10, height: 10 });
  });

  it('erodes from the canvas border for a full-canvas selection', () => {
    const full = new Mask(100, 100);
    full.data.fill(255);
    const out = shrinkMask(full, 3);
    assert.deepEqual(out.alphaBounds(), { x: 3, y: 3, width: 94, height: 94 });
  });

  it('handles fractional radii and radius 0', () => {
    // Integer pixel distances means 5.5 reaches exactly the same pixels as 5.
    assert.deepEqual(growMask(mask, 5.5).alphaBounds(), growMask(mask, 5).alphaBounds());
    assert.deepEqual(shrinkMask(mask, 5.5).alphaBounds(), shrinkMask(mask, 5).alphaBounds());

    const grown = growMask(mask, 0);
    const shrunk = shrinkMask(mask, 0);
    assert.deepEqual(Array.from(grown.data), Array.from(mask.data));
    assert.deepEqual(Array.from(shrunk.data), Array.from(mask.data));
  });

  it('returns empty masks for empty input and rejects bad radii', () => {
    const empty = new Mask(10, 10);
    assert.equal(growMask(empty, 4).isEmpty(), true);
    assert.equal(shrinkMask(empty, 4).isEmpty(), true);
    assert.throws(() => growMask(mask, -1), isUsageError);
    assert.throws(() => shrinkMask(mask, NaN), isUsageError);
  });
});

describe('borderMask / thresholdMask / maskStats', () => {
  it('returns the inner band of a selection', () => {
    const mask = rectMask(100, 100, { x: 40, y: 40, width: 20, height: 20 });
    const border = borderMask(mask, 3);
    near(area(border), 20 * 20 - 14 * 14, 1e-6, 'band area');
    assert.equal(border.get(40, 40), 255); // corner of the band
    assert.equal(border.get(41, 50), 255);
    assert.equal(border.get(50, 50), 0); // interior is not band
    assert.equal(border.get(35, 50), 0); // outside is not band
    assert.equal(borderMask(mask, 0).isEmpty(), true);
  });

  it('thresholds coverage', () => {
    const m = new Mask(4, 1, Uint8ClampedArray.from([0, 100, 128, 255]));
    assert.deepEqual(Array.from(thresholdMask(m, 128).data), [0, 0, 255, 255]);
  });

  it('summarises coverage, bounds and centroid', () => {
    const full = new Mask(10, 10);
    full.data.fill(255);
    const stats = maskStats(full);
    assert.equal(stats.pixels, 100);
    assert.equal(stats.coverage, 1);
    assert.deepEqual(stats.bounds, { x: 0, y: 0, width: 10, height: 10 });
    assert.deepEqual(stats.centroid, { x: 5, y: 5 });

    const empty = maskStats(new Mask(10, 10));
    assert.equal(empty.pixels, 0);
    assert.equal(empty.coverage, 0);
    assert.equal(empty.bounds, null);
    assert.equal(empty.centroid, null);

    const half = new Mask(10, 10);
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 5; x++) half.set(x, y, 255);
    }
    const hs = maskStats(half);
    assert.equal(hs.pixels, 50);
    near(hs.coverage, 0.5, 1e-12, 'half coverage');
    assert.deepEqual(hs.centroid, { x: 2.5, y: 5 });
  });
});

// --- determinism ----------------------------------------------------------

describe('determinism', () => {
  it('produces byte-identical output for repeated calls', () => {
    const a = rectMask(64, 64, { x: 3.25, y: 4.5, width: 40, height: 30 });
    const b = rectMask(64, 64, { x: 3.25, y: 4.5, width: 40, height: 30 });
    assert.deepEqual(Array.from(a.data), Array.from(b.data));

    const e1 = ellipseMask(64, 64, { cx: 32, cy: 32, rx: 20, ry: 12, rotation: 17 });
    const e2 = ellipseMask(64, 64, { cx: 32, cy: 32, rx: 20, ry: 12, rotation: 17 });
    assert.deepEqual(Array.from(e1.data), Array.from(e2.data));

    const p1 = polygonMask(64, 64, starPoints(32, 32, 28, 11));
    const p2 = polygonMask(64, 64, starPoints(32, 32, 28, 11));
    assert.deepEqual(Array.from(p1.data), Array.from(p2.data));

    const mask = rectMask(64, 64, { x: 10, y: 10, width: 30, height: 30 });
    assert.deepEqual(
      Array.from(featherMask(mask, 4).data),
      Array.from(featherMask(mask, 4).data),
    );
  });
});
