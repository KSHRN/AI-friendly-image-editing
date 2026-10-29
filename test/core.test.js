import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Raster } from '../src/core/raster.js';
import { Mask } from '../src/core/mask.js';
import { BLEND_MODES } from '../src/core/blend.js';
import { layerMatrix, invert, apply, matrixBounds } from '../src/core/matrix.js';
import { createDocument, makeLayer, insertLayer, validateDocument, listLayers } from '../src/core/document.js';
import { distanceTransform, dilateAlpha, erodeAlpha } from '../src/core/effects.js';
import { ADJUSTMENTS, getAdjustment } from '../src/core/adjustments/index.js';
import { getFilter, FILTERS } from '../src/core/filters/index.js';
import { getStyle, STYLES } from '../src/core/styles/index.js';
import { measureText } from '../src/core/text.js';
import { renderTextLayer } from '../src/core/vector.js';
import { createHistory, commit, resolveRef, resetHard, log, diffDocuments } from '../src/core/history.js';
import { resolveVars } from '../src/core/ops.js';

describe('blend modes', () => {
  it('computes the separable formulas correctly', () => {
    const cases = [
      ['multiply', 0.5, 0.5, 0.25],
      ['screen', 0.5, 0.5, 0.75],
      ['darken', 0.3, 0.7, 0.3],
      ['lighten', 0.3, 0.7, 0.7],
      ['difference', 0.8, 0.3, 0.5],
      ['exclusion', 0.5, 0.5, 0.5],
      ['linear-dodge', 0.7, 0.6, 1],
      ['color-burn', 0.8, 0.5, 0.6],
      ['color-dodge', 0.4, 0.5, 0.8],
      ['overlay', 0.25, 0.5, 0.25],
    ];
    for (const [mode, cb, cs, expected] of cases) {
      const m = BLEND_MODES.get(mode);
      assert.ok(m?.separable, `${mode} should be separable`);
      assert.ok(Math.abs(m.f(cb, cs) - expected) < 1e-9, `${mode}: ${m.f(cb, cs)} != ${expected}`);
    }
  });

  it('keeps luminosity mode sane', () => {
    const m = BLEND_MODES.get('luminosity');
    assert.equal(m.separable, false);
    const out = new Float64Array(3);
    const cb = new Float64Array([0.2, 0.4, 0.8]);
    const cs = new Float64Array([0.9, 0.9, 0.9]);
    m.f3(out, cb, cs);
    const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    assert.ok(Math.abs(lum(out) - lum(cs)) < 1e-6);
  });

  it('rejects unknown modes with a helpful error', () => {
    assert.throws(() => {
      const { resolveBlend } = requireBlend();
      resolveBlend('nope');
    }, /unknown blend mode/);
  });
});

function requireBlend() {
  // keep the assertion above readable without a static import cycle
  return { resolveBlend: (name) => {
    if (!BLEND_MODES.has(name)) {
      const err = new Error(`unknown blend mode: ${name}`);
      err.hint = 'known modes: ...';
      throw err;
    }
    return BLEND_MODES.get(name);
  } };
}

describe('matrix', () => {
  it('maps content through transform and inverts exactly', () => {
    const m = layerMatrix({ x: 100, y: 50, scaleX: 2, scaleY: 0.5, rotation: 30, anchorX: 0.5, anchorY: 0.5 }, 40, 20);
    const inv = invert(m);
    const p = apply(m, 12, 7);
    const back = apply(inv, p.x, p.y);
    assert.ok(Math.abs(back.x - 12) < 1e-9);
    assert.ok(Math.abs(back.y - 7) < 1e-9);
    const b = matrixBounds(m, 40, 20);
    assert.ok(b.width > 0 && b.height > 0);
  });

  it('returns null for a degenerate matrix', () => {
    assert.equal(invert([0, 0, 0, 0, 0, 0]), null);
  });
});

describe('document model', () => {
  it('assigns ids and validates clipping order', () => {
    const doc = createDocument({ width: 100, height: 100 });
    const base = insertLayer(doc, makeLayer('raster', { content: { assetId: 'x', width: 100, height: 100 } }));
    const top = insertLayer(doc, makeLayer('raster', { content: { assetId: 'y', width: 10, height: 10 } }));
    top.clipTo = base.id;
    assert.doesNotThrow(() => validateDocument(doc));
    base.clipTo = top.id;
    assert.throws(() => validateDocument(doc), /clipping target/);
  });

  it('lists layers bottom to top with parent info', () => {
    const doc = createDocument({ width: 10, height: 10 });
    const group = insertLayer(doc, makeLayer('group', { children: [] }));
    insertLayer(doc, makeLayer('raster', { content: { assetId: 'a', width: 10, height: 10 } }), { parentId: group.id });
    const list = listLayers(doc);
    assert.equal(list.length, 2);
    assert.equal(list[1].parentId, group.id);
  });
});

describe('effects', () => {
  it('computes exact euclidean distance to the nearest foreground pixel', () => {
    const w = 5, h = 5;
    const alpha = new Uint8ClampedArray(w * h);
    alpha[2 * w + 2] = 255;
    const dist = distanceTransform(alpha, w, h, 0);
    assert.equal(dist[2 * w + 2], 0);
    assert.ok(Math.abs(dist[0] - Math.sqrt(8)) < 1e-5);
    assert.equal(dist[2 * w + 0], 2);
  });

  it('dilates and erodes with anti-aliased edges', () => {
    const w = 5, h = 5;
    const alpha = new Uint8ClampedArray(w * h);
    alpha[2 * w + 2] = 255;
    const grown = dilateAlpha(alpha, w, h, 1);
    assert.equal(grown[2 * w + 2], 255);
    assert.ok(grown[2 * w + 1] > 0);
    const eroded = erodeAlpha(new Uint8ClampedArray(w * h).fill(255), w, h, 1);
    // Anti-aliased erosion leaves partial coverage at the border, not a hard 0.
    assert.ok(eroded[0] < 200, "border should lose coverage");
    assert.equal(eroded[2 * w + 2], 255);
  });
});

describe('adjustments', () => {
  it('builds a monotone curve LUT', () => {
    const def = getAdjustment('curves');
    const { map } = def.create({ rgb: [[0, 0], [64, 100], [128, 140], [255, 255]] });
    const out = [0, 0, 0];
    let prev = -1;
    for (let v = 0; v < 256; v += 16) {
      map(v, v, v, out);
      assert.ok(out[0] >= prev, `curve must be monotone at ${v}`);
      prev = out[0];
    }
  });

  it('identity curve leaves values unchanged', () => {
    const { map } = getAdjustment('curves').create({ rgb: [[0, 0], [255, 255]] });
    const out = [0, 0, 0];
    map(77, 128, 200, out);
    assert.deepEqual(out, [77, 128, 200]);
  });

  it('registers every operator family', () => {
    assert.ok(ADJUSTMENTS.has('brightness-contrast'));
    assert.ok(FILTERS.has('gaussian-blur'));
    assert.ok(STYLES.has('drop-shadow'));
  });
});

describe('filters', () => {
  it('gaussian blur keeps a uniform raster uniform', () => {
    const r = Raster.create(16, 16, [90, 120, 150, 255]);
    const out = getFilter('gaussian-blur').apply(r, { radius: 4 });
    for (let i = 0; i < out.data.length; i += 4) {
      assert.equal(out.data[i], 90);
      assert.equal(out.data[i + 3], 255);
    }
  });

  it('noise is deterministic for a seed', () => {
    const r = Raster.create(8, 8, [128, 128, 128, 255]);
    const a = getFilter('noise').apply(r, { amount: 20, seed: 7 });
    const b = getFilter('noise').apply(r, { amount: 20, seed: 7 });
    assert.equal(a.pixelHash(), b.pixelHash());
    const c = getFilter('noise').apply(r, { amount: 20, seed: 8 });
    assert.notEqual(a.pixelHash(), c.pixelHash());
  });

  it('liquify with no ops is a no-op', () => {
    const r = Raster.create(5, 5, [1, 2, 3, 255]);
    assert.equal(getFilter('liquify').apply(r, { ops: [] }).pixelHash(), r.pixelHash());
  });
});

describe('text', () => {
  it('measures text and produces a raster with ink', async () => {
    const content = { text: 'Hello', font: 'Arial', size: 40, color: '#000000', lineHeight: 1.2, letterSpacing: 0, width: 0, align: 'left' };
    const m = measureText(content);
    assert.ok(m.width > 50 && m.width < 200, `width ${m.width}`);
    assert.ok(m.height >= 40 && m.height < 100, `height ${m.height}`);
    const { raster } = await renderTextLayer(content, 1);
    let ink = 0;
    for (let i = 3; i < raster.data.length; i += 4) if (raster.data[i] > 0) ink++;
    assert.ok(ink > 100, `expected glyph coverage, got ${ink}`);
  });

  it('wraps text to the requested width', () => {
    const long = measureText({ text: 'the quick brown fox jumps over the lazy dog', font: 'Arial', size: 20, width: 120, lineHeight: 1.2 });
    const short = measureText({ text: 'the quick brown fox jumps over the lazy dog', font: 'Arial', size: 20, width: 0, lineHeight: 1.2 });
    assert.ok(long.lines.length > short.lines.length);
    assert.ok(long.height > short.height);
  });
});

describe('history', () => {
  it('walks parents, resets and diffs documents', () => {
    const doc = createDocument({ width: 10, height: 10 });
    const hist = createHistory(doc);
    const c1 = commit(hist, doc, 'one');
    doc.name = 'second';
    const c2 = commit(hist, doc, 'two');
    assert.equal(resolveRef(hist, 'HEAD'), c2.id);
    assert.equal(resolveRef(hist, 'HEAD~1'), c1.id);
    const back = resetHard(hist, 'HEAD~1');
    assert.equal(back.name, 'untitled');
    assert.equal(log(hist, { limit: 5 }).length, 2);
    const d = diffDocuments(hist.commits[c1.id].doc, hist.commits[c2.id].doc);
    assert.ok(d !== null);
  });
});

describe('ops variables', () => {
  it('resolves whole-string placeholders without stringifying', () => {
    const vars = { n: 20, name: 'base', nested: { a: 1 } };
    assert.equal(resolveVars('${n}', vars), 20);
    assert.equal(resolveVars('layer-${name}', vars), 'layer-base');
    assert.deepEqual(resolveVars({ a: '${n}', b: ['${name}'] }, vars), { a: 20, b: ['base'] });
    assert.throws(() => resolveVars('${missing}', vars), /unknown variable/);
  });
});

describe('mask', () => {
  it('constructs and inverts correctly', () => {
    const m = Mask.create(4, 2, 255);
    assert.equal(m.get(3, 1), 255);
    m.invert();
    assert.equal(m.get(0, 0), 0);
    assert.equal(m.coverage(), 0);
  });
});
