/**
 * Appearance layer tests: paint model, v2 shape content, per-object drawing
 * stacks, stroke padding and SVG export.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { tempDir, cli, ok } from './helpers.js';
import { normalizePaint, normalizePaintList, paintToSvg, parseCssGradient } from '../src/core/paint.js';
import { normalizeShapeContent, normalizeStroke, shapeGeometryElement } from '../src/core/shapes.js';
import { shapeToSvg, renderShapeLayer, rasterizeSvg, shapePadding } from '../src/core/vector.js';
import { Session } from '../src/core/session.js';

function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return [raster.data[i], raster.data[i + 1], raster.data[i + 2], raster.data[i + 3]];
}

function plainRect(width, height, fill) {
  return {
    type: 'shape',
    width,
    height,
    fill,
    shapes: [{ kind: 'rect', x: 0, y: 0, width, height }],
  };
}

describe('paint model', () => {
  it('normalizes solid colours, alpha and CSS colour functions', () => {
    assert.deepEqual(normalizePaint('#f00'), { type: 'solid', color: '#ff0000', opacity: 1 });
    assert.deepEqual(normalizePaint('red'), { type: 'solid', color: '#ff0000', opacity: 1 });
    const half = normalizePaint('rgb(255 0 85 / 50%)');
    assert.equal(half.type, 'solid');
    assert.equal(half.color, '#ff0055');
    assert.ok(Math.abs(half.opacity - 0.502) < 0.01);
    assert.equal(normalizePaint('none'), null);
  });

  it('parses CSS linear gradients into objectBoundingBox endpoints', () => {
    const paint = parseCssGradient('linear-gradient(90deg, #ff0055 0%, #0000ff 100%)');
    assert.deepEqual(paint.from, { x: 0, y: 0.5 });
    assert.deepEqual(paint.to, { x: 1, y: 0.5 });
    assert.equal(paint.stops.length, 2);
    assert.equal(paint.stops[1].color, '#0000ff');

    const diagonal = parseCssGradient('linear-gradient(to bottom right, red, blue)');
    assert.deepEqual(diagonal.from, { x: 0, y: 0 });
    assert.deepEqual(diagonal.to, { x: 1, y: 1 });

    const angle = normalizePaint({ type: 'linear-gradient', angle: 180, stops: ['#fff', '#000'] });
    assert.deepEqual(angle.from, { x: 0.5, y: 0 });
    assert.deepEqual(angle.to, { x: 0.5, y: 1 });
  });

  it('parses radial gradients with a centre and radius', () => {
    const paint = parseCssGradient('radial-gradient(circle at 30% 20%, #ffffff 0%, #000000 100%)');
    assert.equal(paint.type, 'radial-gradient');
    assert.deepEqual(paint.center, { x: 0.3, y: 0.2 });
    assert.equal(paint.radius, 0.5);
    assert.deepEqual(paint.stops.map((s) => s.color), ['#ffffff', '#000000']);
  });

  it('distributes omitted stop offsets and keeps them monotonic', () => {
    const paint = normalizePaint({ type: 'linear-gradient', stops: ['#ff0000', '#00ff00', '#0000ff'] });
    assert.deepEqual(paint.stops.map((s) => s.offset), [0, 0.5, 1]);
    const sorted = normalizePaint({ type: 'linear-gradient', stops: ['#f00 80%', '#0f0 20%'] });
    assert.deepEqual(sorted.stops.map((s) => s.offset), [0.8, 0.8]);
  });

  it('rejects malformed paints with actionable errors', () => {
    assert.throws(() => normalizePaint({ type: 'linear-gradient', stops: ['#ff0000'] }), /at least two stops/);
    assert.throws(() => normalizePaint('linear-gradient(90deg)'), /at least two stops/);
    assert.throws(() => normalizePaint('not-a-colour'), /invalid paint colour/);
    assert.throws(() => normalizePaint({ type: 'spot-colour' }), /unknown paint type/);
  });

  it('emits SVG paint servers with stable gradient ids', () => {
    const paint = normalizePaint('linear-gradient(90deg, #ff0000, #0000ff)');
    const { value, def } = paintToSvg(paint, 'f0_0');
    assert.equal(value, 'url(#f0_0)');
    assert.match(def, /<linearGradient id="f0_0"/);
    assert.match(def, /stop-color="#0000ff"/);
  });
});

describe('shape content v2', () => {
  it('upgrades legacy fill/stroke content and stays idempotent', () => {
    const legacy = {
      type: 'shape',
      width: 100,
      height: 40,
      fill: '#00ff00',
      stroke: { color: '#000000', width: 3, lineJoin: 'round', dash: '8 4' },
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 40 }],
    };
    const v2 = normalizeShapeContent(legacy);
    assert.equal(v2.version, 2);
    assert.equal(v2.fill, undefined);
    assert.equal(v2.fills[0].color, '#00ff00');
    assert.equal(v2.strokes[0].width, 3);
    assert.equal(v2.strokes[0].lineJoin, 'round');
    assert.deepEqual(v2.strokes[0].dash, [8, 4]);
    assert.equal(normalizeShapeContent(v2), v2, 'canonical content is returned as-is');
  });

  it('carries per-object paints, opacity and transforms', () => {
    const content = normalizeShapeContent({
      type: 'shape',
      width: 50,
      height: 50,
      fills: ['#ff0000'],
      strokes: [],
      shapes: [
        { kind: 'rect', x: 0, y: 0, width: 25, height: 50, fill: 'linear-gradient(90deg,#00f,#0ff)', opacity: 0.5 },
        { kind: 'ellipse', cx: 37, cy: 25, rx: 12, ry: 12, transform: [1, 0, 0, 1, 2, 3] },
      ],
    });
    assert.equal(content.shapes[0].fills[0].type, 'linear-gradient');
    assert.equal(content.shapes[0].opacity, 0.5);
    assert.deepEqual(content.shapes[1].transform, [1, 0, 0, 1, 2, 3]);
    // No per-object override means the layer stack applies.
    assert.equal(content.shapes[1].fills, undefined);
  });

  it('normalizes stroke details and rejects bad values', () => {
    const stroke = normalizeStroke({ color: '#fff', width: 4, lineCap: 'round', lineJoin: 'bevel', miterLimit: 8 });
    assert.equal(stroke.lineCap, 'round');
    assert.equal(stroke.lineJoin, 'bevel');
    assert.equal(stroke.miterLimit, 8);
    assert.equal(normalizeStroke({ color: '#fff', width: 0 }), null);
    assert.throws(() => normalizeStroke({ color: '#fff', width: 2, lineCap: 'funky' }), /invalid line cap/);
  });

  it('builds geometry elements without baking paint in', () => {
    const rect = shapeGeometryElement({ kind: 'rect', x: 1, y: 2, width: 3, height: 4, radius: 2 }, ' fill="#fff"');
    assert.match(rect, /^<rect x="1" y="2" width="3" height="4" rx="2" ry="2" fill="#fff"\/>$/);
    const pathEl = shapeGeometryElement({ kind: 'path', d: 'M0 0 L5 0', fillRule: 'evenodd' });
    assert.match(pathEl, /fill-rule="evenodd"/);
  });
});

describe('shape svg document', () => {
  it('emits one element per fill and stroke, in appearance order', () => {
    const { svg } = shapeToSvg(normalizeShapeContent({
      type: 'shape',
      width: 100,
      height: 100,
      fills: ['#ff0000', 'linear-gradient(90deg,#00f,#0ff)'],
      strokes: [{ color: '#ffffff', width: 4 }],
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 100 }],
    }));
    const fills = [...svg.matchAll(/<rect[^>]*fill="(#[0-9a-f]+|url\(#[^)]+\))"/g)].map((m) => m[1]);
    assert.deepEqual(fills, ['#ff0000', 'url(#f0_1)']);
    assert.ok(svg.indexOf('fill="#ff0000"') < svg.indexOf('url(#f0_1)'), 'paints keep draw order');
    assert.match(svg, /<rect[^>]*stroke="#ffffff"[^>]*stroke-width="4"/);
    assert.match(svg, /<linearGradient id="f0_1"/);
  });

  it('pads the viewport so centred strokes are not clipped', () => {
    const content = normalizeShapeContent({
      type: 'shape',
      width: 100,
      height: 100,
      fills: ['#ff0000'],
      strokes: [{ color: '#000', width: 20 }],
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 100, height: 100 }],
    });
    assert.equal(shapePadding(content), 11);
    const { svg, pad } = shapeToSvg(content, 1);
    assert.equal(pad, 11);
    assert.match(svg, /viewBox="-11 -11 122 122"/);
    assert.match(svg, /width="122" height="122"/);
  });
});

describe('shape rendering', () => {
  it('renders a linear gradient with the expected ends', async () => {
    const { raster } = await renderShapeLayer(normalizeShapeContent({
      type: 'shape',
      width: 120,
      height: 60,
      fills: ['linear-gradient(90deg,#ff0000,#0000ff)'],
      strokes: [],
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 120, height: 60 }],
    }));
    const left = pixel(raster, 2, 30);
    const right = pixel(raster, 117, 30);
    assert.ok(left[0] > 240 && left[2] < 20, `left should be red, got ${left}`);
    assert.ok(right[2] > 240 && right[0] < 20, `right should be blue, got ${right}`);
    assert.equal(left[3], 255);
  });

  it('renders legacy v1 content and v2 content identically', async () => {
    const dir = path.join(tempDir('ashop-appearance-'), 'p.ashop');
    const session = await Session.createProject(dir, { width: 80, height: 40 });
    const legacyLayer = session.addShapeLayer({
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 80, height: 40 }],
      width: 80,
      height: 40,
      name: 'legacy',
    });
    // Simulate a document authored before v2 existed.
    legacyLayer.content = plainRect(80, 40, '#334455');
    const v2Layer = session.addShapeLayer({
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 80, height: 40 }],
      width: 80,
      height: 40,
      fills: ['#334455'],
      strokes: [],
      name: 'v2',
    });
    const a = await session.renderer.renderLayerIsolated(session.doc, legacyLayer);
    const b = await session.renderer.renderLayerIsolated(session.doc, v2Layer);
    assert.deepEqual(Array.from(a.data), Array.from(b.data));
  });

  it('draws strokes outside the content box thanks to padding', async () => {
    const dir = path.join(tempDir('ashop-appearance-'), 'p.ashop');
    const session = await Session.createProject(dir, { width: 120, height: 120 });
    session.addShapeLayer({
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 40, height: 40 }],
      width: 40,
      height: 40,
      x: 40,
      y: 40,
      fills: ['#ff0000'],
      strokes: [{ color: '#0000ff', width: 20 }],
      name: 'ring',
    });
    const canvas = await session.render();
    assert.equal(pixel(canvas, 35, 60)[2], 255, 'stroke should be visible 5px outside the box');
    assert.equal(pixel(canvas, 60, 60)[3], 255, 'fill should remain opaque');
    assert.equal(pixel(canvas, 25, 60)[3], 0, 'nothing should be drawn far outside');
  });

  it('applies per-object opacity', async () => {
    const dir = path.join(tempDir('ashop-appearance-'), 'p.ashop');
    const session = await Session.createProject(dir, { width: 80, height: 40 });
    session.addShapeLayer({
      shapes: [
        { kind: 'rect', x: 0, y: 0, width: 40, height: 40, fill: '#ff0000' },
        { kind: 'rect', x: 40, y: 0, width: 40, height: 40, fill: '#0000ff', opacity: 0.5 },
      ],
      width: 80,
      height: 40,
      fills: [],
      strokes: [],
      name: 'objects',
    });
    const canvas = await session.render();
    assert.equal(pixel(canvas, 20, 20)[0], 255);
    const right = pixel(canvas, 60, 20);
    assert.ok(Math.abs(right[3] - 128) <= 2, `expected ~50% alpha, got ${right[3]}`);
  });

  it('renders gradient text', async () => {
    const dir = path.join(tempDir('ashop-appearance-'), 'p.ashop');
    const session = await Session.createProject(dir, { width: 400, height: 140 });
    const layer = session.addTextLayer({
      text: 'GRADIENT',
      font: 'Arial',
      size: 64,
      fill: 'linear-gradient(90deg,#ff0000,#0000ff)',
      x: 10,
      y: 20,
    });
    const raster = await session.renderer.renderLayerIsolated(session.doc, layer);
    let reddish = 0;
    let bluish = 0;
    for (let i = 0; i < raster.data.length; i += 4) {
      if (raster.data[i + 3] < 200) continue;
      if (raster.data[i] > 180 && raster.data[i + 2] < 80) reddish++;
      if (raster.data[i + 2] > 180 && raster.data[i] < 80) bluish++;
    }
    assert.ok(reddish > 20, `expected red glyph pixels, got ${reddish}`);
    assert.ok(bluish > 20, `expected blue glyph pixels, got ${bluish}`);
  });

  it('keeps a text stroke when only the text content is edited', async () => {
    const dir = path.join(tempDir('ashop-appearance-'), 'p.ashop');
    const session = await Session.createProject(dir, { width: 120, height: 80 });
    const layer = session.addTextLayer({
      text: 'A',
      font: 'Arial',
      size: 48,
      color: '#ffffff',
      stroke: { color: '#ff0000', width: 6 },
      x: 10,
      y: 10,
    });
    session.setText(layer.id, { text: 'AB' });
    assert.ok(layer.content.stroke, 'legacy stroke survives a content edit');
    const raster = await session.renderer.renderLayerIsolated(session.doc, layer);
    let red = 0;
    for (let i = 0; i < raster.data.length; i += 4) {
      if (raster.data[i] > 200 && raster.data[i + 1] < 60 && raster.data[i + 3] > 200) red++;
    }
    assert.ok(red > 10, `expected the red stroke to still render, got ${red}`);
  });
});

describe('svg export', () => {
  it('exports the same SVG the rasteriser uses', async () => {
    const dir = path.join(tempDir('ashop-appearance-'), 'p.ashop');
    const session = await Session.createProject(dir, { width: 100, height: 100 });
    const layer = session.addShapeLayer({
      shapes: [{ kind: 'rect', x: 5, y: 5, width: 90, height: 90, radius: 6 }],
      width: 100,
      height: 100,
      fills: ['linear-gradient(45deg,#ff0055,#0000ff)'],
      strokes: [{ color: '#ffffff', width: 3, dash: [6, 3] }],
      name: 'logo',
    });
    const out = path.join(dir, 'logo.svg');
    const info = await session.exportShapeSvg('logo', out);
    const svgText = await readFile(out, 'utf8');
    assert.match(svgText, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svgText, /<linearGradient id="f0_0"/);
    assert.ok(info.bytes > 200);

    // Re-rasterising the exported document must produce the layer raster.
    const fromFile = await rasterizeSvg(svgText);
    const { raster } = await renderShapeLayer(layer.content, 1);
    assert.equal(fromFile.width, raster.width);
    assert.equal(fromFile.height, raster.height);
    assert.deepEqual(Array.from(fromFile.data), Array.from(raster.data));
  });

  it('refuses to export non-vector layers', async () => {
    const dir = path.join(tempDir('ashop-appearance-'), 'p.ashop');
    const session = await Session.createProject(dir, { width: 20, height: 20 });
    const layer = session.addTextLayer({ text: 'x', size: 12 });
    await assert.rejects(
      session.exportShapeSvg(layer.id, path.join(dir, 'text.svg')),
      (err) => err.code === 'E_UNSUPPORTED',
    );
  });
});

describe('shape CLI surface', () => {
  it('adds, restyles and inspects a gradient shape', () => {
    const dir = tempDir('ashop-cli-');
    const project = path.join(dir, 'shapes.ashop');
    ok(['init', '200', '120', '--project', project]);
    const added = ok([
      'shape', 'add', 'rect', '--rect', '10,10,180,100',
      '--fill', 'linear-gradient(90deg,#ff0055,#0000ff)',
      '--stroke', '#ffffff', '--stroke-width', '2', '--stroke-dash', '8,4',
      '--name', 'card', '--project', project,
    ]);
    assert.equal(added.appearance.fills.length, 1);
    assert.match(added.appearance.fills[0], /linear-gradient/);

    const styled = ok(['shape', 'set', 'card', '--fill', '#00ffaa', '--stroke-linecap', 'round', '--project', project]);
    assert.match(styled.appearance.fills[0], /#00ffaa/);
    assert.match(styled.appearance.strokes[0], /round-cap|round\/butt|round/);

    const info = ok(['shape', 'info', 'card', '--project', project]);
    assert.equal(info.appearance.version, 2);
    assert.equal(info.appearance.shapes.length, 1);

    const failed = cli(['shape', 'add', 'rect', '--rect', '0,0,10,10', '--fill', 'linear-gradient(90deg)', '--project', project]);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.json.error.code, 'E_USAGE');
  });

  it('clears a stroke with --stroke none', () => {
    const dir = tempDir('ashop-cli-');
    const project = path.join(dir, 'clear.ashop');
    ok(['init', '80', '60', '--project', project]);
    const created = ok([
      'shape', 'add', 'rect', '--rect', '5,5,70,50',
      '--fill', '#ff0000', '--stroke', '#0000ff', '--stroke-width', '4',
      '--name', 'frame', '--project', project,
    ]);
    assert.equal(created.appearance.strokes.length, 1);
    const cleared = ok(['shape', 'set', 'frame', '--stroke', 'none', '--project', project]);
    assert.equal(cleared.appearance.strokes.length, 0);
  });
});

