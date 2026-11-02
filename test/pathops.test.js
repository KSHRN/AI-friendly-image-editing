/**
 * Path booleans (pathfinder) tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir, ok, cli } from './helpers.js';
import { Session } from '../src/core/session.js';
import {
  shapeToPolygons, ringsToMultiPolygon, booleanShapeLayers, multiPolygonToPath,
} from '../src/core/pathops.js';

function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return [raster.data[i], raster.data[i + 1], raster.data[i + 2], raster.data[i + 3]];
}

async function project(width = 240, height = 160) {
  return Session.createProject(path.join(tempDir('ashop-path-'), 'p.ashop'), { width, height });
}

function addRect(session, { x, y, w = 80, h = 80, fill = '#ff0000', name = 'a', rotation = 0 }) {
  return session.addShapeLayer({
    shapes: [{ kind: 'rect', x: 0, y: 0, width: w, height: h }],
    width: w,
    height: h,
    x,
    y,
    rotation,
    fills: [fill],
    strokes: [],
    name,
  });
}

async function twoRects() {
  const session = await project();
  addRect(session, { x: 20, y: 20, fill: '#ff0000', name: 'a' });
  addRect(session, { x: 80, y: 20, fill: '#0000ff', name: 'b' });
  return session;
}

function bboxOf(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

describe('path flattening', () => {
  it('flattens rects/ellipses/paths to canvas-space rings', async () => {
    const session = await project();
    const layer = addRect(session, { x: 100, y: 40, w: 30, h: 20 });
    const rings = shapeToPolygons(layer);
    assert.equal(rings.length, 1);
    const box = bboxOf(rings);
    assert.deepEqual(
      [Math.round(box.minX), Math.round(box.minY), Math.round(box.maxX), Math.round(box.maxY)],
      [100, 40, 130, 60],
    );
  });

  it('nests inner rings as holes (even-odd)', () => {
    const outer = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
    const inner = [[25, 25], [75, 25], [75, 75], [25, 75], [25, 25]];
    const multi = ringsToMultiPolygon([outer, inner]);
    assert.equal(multi.length, 1, 'one outer polygon');
    assert.equal(multi[0].length, 2, 'outer ring plus one hole');
  });

  it('localises boolean output and reports its bounding box', () => {
    const multi = [[[[100, 50], [160, 50], [160, 110], [100, 110], [100, 50]]]];
    const result = multiPolygonToPath(multi);
    assert.equal(result.x, 100);
    assert.equal(result.y, 50);
    assert.equal(result.width, 60);
    assert.equal(result.height, 60);
    assert.match(result.d, /^M0 0 L60 0 L60 60 L0 60 Z$/);
  });
});

describe('path booleans', () => {
  it('unites two overlapping rects, keeping the first layer paint', async () => {
    const session = await twoRects();
    const layer = session.booleanPaths('a', 'b', 'unite');
    assert.equal(session.doc.layers.length, 1, 'operands are removed by default');
    assert.equal(layer.name, 'a unite b');
    const canvas = await session.render();
    for (const x of [40, 90, 120]) assert.equal(pixel(canvas, x, 60)[3], 255, `x=${x} filled`);
    assert.deepEqual(pixel(canvas, 40, 60).slice(0, 3), [255, 0, 0]);
    assert.deepEqual(pixel(canvas, 120, 60).slice(0, 3), [255, 0, 0]);
  });

  it('subtracts the second shape from the first', async () => {
    const session = await twoRects();
    session.booleanPaths('a', 'b', 'subtract');
    const canvas = await session.render();
    assert.equal(pixel(canvas, 40, 60)[3], 255, 'A-only region stays');
    assert.equal(pixel(canvas, 90, 60)[3], 0, 'overlap is removed');
    assert.equal(pixel(canvas, 120, 60)[3], 0, 'B-only region is removed');
  });

  it('intersects to the shared region', async () => {
    const session = await twoRects();
    session.booleanPaths('a', 'b', 'intersect');
    const canvas = await session.render();
    assert.equal(pixel(canvas, 40, 60)[3], 0);
    assert.equal(pixel(canvas, 90, 60)[3], 255);
    assert.equal(pixel(canvas, 120, 60)[3], 0);
  });

  it('excludes the shared region', async () => {
    const session = await twoRects();
    session.booleanPaths('a', 'b', 'exclude');
    const canvas = await session.render();
    assert.equal(pixel(canvas, 40, 60)[3], 255);
    assert.equal(pixel(canvas, 90, 60)[3], 0);
    assert.equal(pixel(canvas, 120, 60)[3], 255);
  });

  it('keeps both operands with --keep-originals', async () => {
    const session = await twoRects();
    session.booleanPaths('a', 'b', 'unite', { keepOriginals: true });
    assert.equal(session.doc.layers.length, 3);
    const canvas = await session.render();
    assert.equal(pixel(canvas, 90, 60)[3], 255);
  });

  it('handles transformed operands (rotation)', async () => {
    const session = await project();
    addRect(session, { x: 20, y: 20, name: 'a' });
    addRect(session, { x: 60, y: 20, name: 'b', rotation: 45 });
    const layer = session.booleanPaths('a', 'b', 'unite');
    assert.ok(layer.content.height > 80, 'rotated operand extends the result box');
    const canvas = await session.render();
    let ink = 0;
    for (let i = 3; i < canvas.data.length; i += 4) if (canvas.data[i] > 0) ink++;
    assert.ok(ink > 1000, `expected a visible result, got ${ink} ink pixels`);
  });

  it('preserves holes in compound paths', async () => {
    const session = await project(300, 200);
    session.addShapeLayer({
      shapes: [{ kind: 'path', d: 'M0 0H100V100H0Z M25 25H75V75H25Z', fillRule: 'evenodd' }],
      width: 100,
      height: 100,
      fills: ['#00ff00'],
      strokes: [],
      name: 'donut',
    });
    addRect(session, { x: 150, y: 0, w: 80, h: 80, fill: '#0000ff', name: 'chip' });
    session.booleanPaths('donut', 'chip', 'unite');
    const canvas = await session.render();
    assert.equal(pixel(canvas, 50, 50)[3], 0, 'hole survives the boolean');
    assert.equal(pixel(canvas, 10, 50)[3], 255, 'ring is still filled');
    assert.equal(pixel(canvas, 170, 10)[3], 255, 'second operand is included');
  });

  it('is deterministic across identical runs', async () => {
    const one = await twoRects();
    one.booleanPaths('a', 'b', 'unite');
    const two = await twoRects();
    two.booleanPaths('a', 'b', 'unite');
    const a = await one.render();
    const b = await two.render();
    assert.equal(a.pixelHash(), b.pixelHash());
  });

  it('rejects non-shape layers and empty results with stable codes', async () => {
    const session = await project();
    addRect(session, { x: 20, y: 20, name: 'a' });
    session.addTextLayer({ text: 'x', size: 20, name: 'txt' });
    assert.throws(() => session.booleanPaths('a', 'txt', 'unite'), (err) => err.code === 'E_UNSUPPORTED');

    const disjoint = await project(400, 200);
    addRect(disjoint, { x: 0, y: 0, name: 'left' });
    addRect(disjoint, { x: 300, y: 0, name: 'right' });
    assert.throws(() => disjoint.booleanPaths('left', 'right', 'intersect'), (err) => err.code === 'E_PATH_EMPTY');

    assert.throws(() => session.booleanPaths('a', 'a', 'unite'), (err) => err.code === 'E_USAGE');
    assert.throws(() => session.booleanPaths('a', 'a', 'blend'), (err) => err.code === 'E_USAGE');
  });

  it('requires both operands in the same group', async () => {
    const session = await project();
    addRect(session, { x: 20, y: 20, name: 'a' });
    addRect(session, { x: 80, y: 20, name: 'b' });
    session.group(['a'], { name: 'g' });
    assert.throws(() => session.booleanPaths('a', 'b', 'unite'), (err) => err.code === 'E_USAGE');
  });
});

describe('path CLI surface', () => {
  it('runs a boolean and reports path info', () => {
    const dir = tempDir('ashop-path-cli-');
    const projectPath = path.join(dir, 'p.ashop');
    ok(['init', '200', '120', '--project', projectPath]);
    ok(['shape', 'add', 'rect', '--rect', '20,20,80,80', '--fill', '#ff0000', '--name', 'a', '--project', projectPath]);
    ok(['shape', 'add', 'rect', '--rect', '80,20,80,80', '--fill', '#0000ff', '--name', 'b', '--project', projectPath]);
    const result = ok(['path.boolean', 'a', 'b', '--op', 'subtract', '--project', projectPath]);
    assert.match(result.layer.name, /subtract/);
    const list = ok(['layer', 'list', '--project', projectPath]);
    assert.equal(list.layers.length, 1);
    const info = ok(['path.info', result.layer.id, '--project', projectPath]);
    assert.ok(info.subpaths >= 1);
    assert.ok(info.points >= 4);
    const bad = cli(['path.boolean', 'x', 'y', '--op', 'unite', '--project', projectPath]);
    assert.notEqual(bad.code, 0);
  });
});
