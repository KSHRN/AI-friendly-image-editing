/**
 * Regression tests for the fixes in task-1 (F-001, F-002, F-004).
 *
 * F-001 is a non-termination bug, so every test that puts coincident rings
 * through the pathfinder runs in a child process with a timeout: a regression
 * fails the test instead of hanging the whole suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, BIN, tempDir, ok, cli } from './helpers.js';
import { Session } from '../src/core/session.js';

const SESSION_URL = new URL('../src/core/session.js', import.meta.url).href;
const PATHOPS_URL = new URL('../src/core/pathops.js', import.meta.url).href;
const SVGIMPORT_URL = new URL('../src/core/svgimport.js', import.meta.url).href;

/** Run a module snippet in a child process; a hang fails at `timeout`. */
function runNode(source, args = [], timeout = 30000) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', source, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
  });
}

function parseLastJson(res) {
  const lines = String(res.stdout ?? '').trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

/** Spawn the CLI with a timeout short enough to fail a hang quickly. */
function runCli(args, { timeout = 60000 } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ASHOP_NO_DAEMON: '1' },
    timeout,
  });
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { /* text output */ }
  return { ...res, json };
}

const FILL_STROKE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <path d="M20 20 H100 V100 H20 Z" fill="#ff0000"/>
  <path d="M20 20 H100 V100 H20 Z" fill="none" stroke="#000000" stroke-width="4"/>
</svg>`;

const COINCIDENT_RINGS_REPRO = `
  import { ringsToMultiPolygon } from '${PATHOPS_URL}';
  const ring = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
  const multi = ringsToMultiPolygon([ring, ring]);
  console.log(JSON.stringify({ polygons: multi.length }));
`;

const FILL_STROKE_BOOLEAN_REPRO = `
  import { Session } from '${SESSION_URL}';
  import { importSvg } from '${SVGIMPORT_URL}';
  import { shapeToPolygons } from '${PATHOPS_URL}';
  const project = process.argv[1];
  const svg = ${JSON.stringify(FILL_STROKE_SVG)};
  const session = await Session.createProject(project, { width: 200, height: 160 });
  const { content } = await importSvg(svg);
  const logo = session.addShapeLayer({
    shapes: content.shapes, width: content.width, height: content.height,
    fills: content.fills, strokes: content.strokes, name: 'logo',
  });
  const all = shapeToPolygons(logo).length;
  const filled = shapeToPolygons(logo, { fillOnly: true }).length;
  session.addShapeLayer({
    shapes: [{ kind: 'rect', x: 0, y: 0, width: 40, height: 40 }],
    width: 40, height: 40, x: 140, y: 20, fills: ['#0000ff'], strokes: [], name: 'chip',
  });
  const result = session.booleanPaths('logo', 'chip', 'unite');
  const raster = await session.render();
  let ink = 0;
  for (let i = 3; i < raster.data.length; i += 4) if (raster.data[i] > 0) ink++;
  console.log(JSON.stringify({
    allRings: all,
    filledRings: filled,
    subpaths: (result.content.shapes[0].d.match(/M/g) ?? []).length,
    ink,
  }));
`;

describe('F-001 — path.boolean must not hang on fill+stroke outlines', () => {
  it('terminates on two exactly coincident rings', () => {
    const res = runNode(COINCIDENT_RINGS_REPRO, [], 15000);
    assert.equal(res.error, undefined, `ringsToMultiPolygon did not terminate: ${res.stderr}`);
    // Both rings are equal in area, so neither can be the other's hole.
    assert.deepEqual(parseLastJson(res), { polygons: 2 });
  });

  it('skips the stroke-only twin and unites the filled outline', () => {
    const project = path.join(tempDir('ashop-fix-a-svg-'), 'logo.ashop');
    const res = runNode(FILL_STROKE_BOOLEAN_REPRO, [project], 30000);
    assert.equal(res.error, undefined, `path boolean did not terminate: ${res.stderr}`);
    const result = parseLastJson(res);
    assert.equal(result.allRings, 2, 'the SVG really has a filled path and a stroke twin');
    assert.equal(result.filledRings, 1, 'only the filled object is boolean geometry');
    assert.equal(result.subpaths, 2, 'union keeps both operands');
    assert.ok(result.ink > 1000, `expected visible output, got ${result.ink} ink pixels`);
  });

  it('rejects a stroke-only operand as having no fillable geometry', async () => {
    const session = await Session.createProject(path.join(tempDir('ashop-fix-a-stroke-'), 's.ashop'), {
      width: 64, height: 64,
    });
    session.addShapeLayer({
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 20, height: 20 }],
      width: 20, height: 20,
      fills: [],
      strokes: [{ paint: '#000000', width: 2 }],
      name: 'outline',
    });
    session.addShapeLayer({
      shapes: [{ kind: 'rect', x: 0, y: 0, width: 20, height: 20 }],
      width: 20, height: 20, x: 10, y: 10, fills: ['#ff0000'], name: 'solid',
    });
    assert.throws(
      () => session.booleanPaths('outline', 'solid', 'unite'),
      (err) => err.code === 'E_PATH_EMPTY',
    );
  });

  it('finishes through the CLI on an imported fill+stroke SVG', () => {
    const dir = tempDir('ashop-fix-a-cli-');
    const project = path.join(dir, 'logo.ashop');
    const svg = path.join(dir, 'logo.svg');
    writeFileSync(svg, FILL_STROKE_SVG);

    const init = runCli(['init', '200', '160', '--project', project]);
    assert.equal(init.status, 0, init.stderr);
    const imported = runCli(['shape', 'import', svg, '--name', 'logo', '--project', project]);
    assert.equal(imported.status, 0, imported.stderr);
    const chip = runCli(['shape', 'add', 'rect', '--rect', '140,20,40,40', '--fill', '#0000ff', '--name', 'chip', '--project', project]);
    assert.equal(chip.status, 0, chip.stderr);

    const bool = runCli(['path.boolean', 'logo', 'chip', '--op', 'unite', '--project', project], { timeout: 30000 });
    assert.equal(bool.error, undefined, 'path.boolean hung on a fill+stroke SVG');
    assert.equal(bool.status, 0, bool.stderr);
    const list = runCli(['layer', 'list', '--project', project]);
    assert.equal(list.json.data.layers.length, 1, 'operands are replaced by one result layer');
  });
});

describe('F-002 — z-index is a stacking order, not an insertion slot', () => {
  it('stacks different z values ascending and equal z by insertion order', () => {
    const project = path.join(tempDir('ashop-fix-a-z-'), 'z.ashop');
    ok(['init', '32', '32', '--project', project]);
    ok(['layer', 'fill', '--color', '#000000', '--name', 'bg', '--z-index', '0', '--project', project]);
    ok(['layer', 'fill', '--color', '#ffffff', '--name', 'white', '--z-index', '1', '--project', project]);
    ok(['layer', 'fill', '--color', '#222222', '--name', 'dark', '--z-index', '1', '--project', project]);
    ok(['layer', 'fill', '--color', '#ff0000', '--name', 'red', '--z-index', '2', '--project', project]);

    const list = ok(['layer', 'list', '--project', project]);
    assert.deepEqual(list.layers.map((layer) => layer.name), ['bg', 'white', 'dark', 'red']);

    // The reported symptom: red used to end up *below* white.
    const pixel = ok(['inspect', 'pixel', '--at', '8,8', '--project', project]);
    assert.deepEqual(pixel.rgba.slice(0, 3), [255, 0, 0], 'the highest z is the visible top layer');
  });

  it('puts a later layer with the same z above, still under the next z', () => {
    const project = path.join(tempDir('ashop-fix-a-z2-'), 'z.ashop');
    ok(['init', '32', '32', '--project', project]);
    ok(['layer', 'fill', '--color', '#000000', '--name', 'bg', '--z-index', '0', '--project', project]);
    ok(['layer', 'fill', '--color', '#ffffff', '--name', 'white', '--z-index', '1', '--project', project]);
    ok(['layer', 'fill', '--color', '#222222', '--name', 'dark', '--z-index', '1', '--project', project]);
    ok(['layer', 'fill', '--color', '#ff0000', '--name', 'red', '--z-index', '2', '--project', project]);
    ok(['layer', 'fill', '--color', '#00ff00', '--name', 'green', '--z-index', '1', '--project', project]);
    ok(['layer', 'fill', '--color', '#0000ff', '--name', 'top', '--project', project]);

    const list = ok(['layer', 'list', '--project', project]);
    assert.deepEqual(
      list.layers.map((layer) => layer.name),
      ['bg', 'white', 'dark', 'green', 'red', 'top'],
      'equal z keeps insertion order (green above dark), red keeps z=2, no z means on top',
    );
  });

  it('keeps z-index 0 at the bottom of imported content (the documented background use)', () => {
    const dir = tempDir('ashop-fix-a-bg-');
    const project = path.join(dir, 'bg.ashop');
    // Smallest valid PNG; any raster works, the import path is what matters.
    writeFileSync(path.join(dir, 'img.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ));

    ok(['init', '32', '32', '--project', project]);
    ok(['layer', 'import', path.join(dir, 'img.png'), '--name', 'img', '--fit', 'stretch', '--project', project]);
    ok(['layer', 'fill', '--color', '#203040', '--name', 'bg', '--z-index', '0', '--project', project]);

    const list = ok(['layer', 'list', '--project', project]);
    assert.deepEqual(list.layers.map((layer) => layer.name), ['bg', 'img'], 'the background must land under imported content');
  });

  it('stacks layers added without z-index on top in insertion order', () => {
    const project = path.join(tempDir('ashop-fix-a-auto-'), 'auto.ashop');
    ok(['init', '32', '32', '--project', project]);
    ok(['layer', 'fill', '--color', '#111111', '--name', 'first', '--project', project]);
    ok(['layer', 'fill', '--color', '#eeeeee', '--name', 'second', '--project', project]);
    const list = ok(['layer', 'list', '--project', project]);
    assert.deepEqual(list.layers.map((layer) => layer.name), ['first', 'second']);
    const pixel = ok(['inspect', 'pixel', '--at', '8,8', '--project', project]);
    assert.deepEqual(pixel.rgba.slice(0, 3), [238, 238, 238], 'the later untagged layer paints last');
  });

  it('places z-index 0 normally on an empty canvas', () => {
    const project = path.join(tempDir('ashop-fix-a-empty-'), 'empty.ashop');
    ok(['init', '16', '16', '--project', project]);
    ok(['layer', 'fill', '--color', '#123456', '--name', 'bg', '--z-index', '0', '--project', project]);
    const list = ok(['layer', 'list', '--project', project]);
    assert.deepEqual(list.layers.map((layer) => layer.name), ['bg']);
  });
});

describe('F-004 — the daemon must not serve a document replaced on disk', () => {
  const DAEMON_ENV = { ASHOP_NO_DAEMON: '0' };

  it('reloads the bundle after it is deleted and re-initialised externally', () => {
    const dir = tempDir('ashop-fix-a-daemon-');
    const project = path.join(dir, 'sess.ashop');
    try {
      ok(['init', '40', '30', '--project', project], { env: DAEMON_ENV });
      ok(['layer', 'fill', '--color', '#112233', '--name', 'old', '--project', project], { env: DAEMON_ENV });
      const warm = ok(['layer', 'list', '--project', project], { env: DAEMON_ENV });
      assert.equal(warm.layers.length, 1, 'the daemon is serving one layer');
      const status = ok(['daemon', 'status', '--project', project], { env: DAEMON_ENV });
      assert.equal(status.running, true, 'the cache under test lives in a running daemon');

      // Another process replaces the whole bundle with a fresh project.
      rmSync(project, { recursive: true, force: true });
      const init = ok(['init', '40', '30', '--project', project], { env: DAEMON_ENV });
      assert.equal(init.layers, 0, 'the bundle on disk is empty again');

      const list = ok(['layer', 'list', '--project', project], { env: DAEMON_ENV });
      assert.equal(list.layers.length, 0, 'the daemon must reload instead of serving the old document');
    } finally {
      cli(['daemon', 'stop', '--project', project], { env: DAEMON_ENV });
    }
  });
});
