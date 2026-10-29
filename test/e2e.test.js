import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { tempDir, cli, ok, fails } from './helpers.js';

const dir = tempDir('ashop-e2e-');
const project = path.join(dir, 'demo.ashop');
const sample = path.join(dir, 'sample.png');

before(async () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
    <rect width="100%" height="100%" fill="#f2f2f2"/>
    <circle cx="160" cy="120" r="60" fill="#cc2244"/>
    <rect x="230" y="20" width="60" height="40" fill="#2244cc"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(sample);
  ok(['init', '320', '240', '--project', project]);
});

describe('end-to-end workflow', () => {
  it('builds the PDR e-commerce image', () => {
    ok(['layer', 'import', sample, '--name', 'base', '--fit', 'stretch', '--at', '0,0', '--project', project]);
    ok(['select', 'color', '--color', '#f2f2f2', '--tolerance', '12', '--project', project]);
    ok(['select', 'invert', '--project', project]);
    const mask = ok(['mask', 'from-selection', '--layer', 'base', '--feather', '1', '--project', project]);
    assert.equal(mask.layer, 'lyr_1');
    ok(['layer', 'fill', '--color', '#102030', '--name', 'bg', '--z-index', '0', '--project', project]);
    ok(['style', 'add', 'drop-shadow', '--layer', 'base', '--color', '#00000066', '--offset-y', '8', '--blur', '16', '--project', project]);
    ok(['adjust', 'add', 'curves', '--layer', 'base', '--rgb', '[[0,0],[128,150],[255,255]]', '--project', project]);
    ok(['text', 'add', '--content', 'SHOP', '--font', 'Arial', '--size', '32', '--color', '#ffffff', '--pos', '12,12', '--project', project]);
    const status = ok(['status', '--project', project]);
    assert.equal(status.layerCount, 4);
    assert.equal(status.history.dirty, true);
  });

  it('renders deterministically', () => {
    const a = ok(['render', path.join(dir, 'a.png'), '--project', project]);
    const b = ok(['render', path.join(dir, 'b.png'), '--project', project]);
    assert.equal(a.pixelHash, b.pixelHash);
    assert.equal(a.sha256, b.sha256);
    assert.ok(existsSync(a.file));
    const d = ok(['diff', a.file, b.file]);
    assert.equal(d.pass, true);
    assert.equal(d.identical, true);
    assert.equal(d.metrics.mismatchRatio, 0);
  });

  it('probes pixels and regions', () => {
    const p = ok(['inspect', 'pixel', '--at', '160,120', '--project', project]);
    assert.equal(p.inBounds, true);
    assert.ok(Array.isArray(p.rgba) && p.rgba.length === 4);
    const r = ok(['inspect', 'region', '--rect', '0,0,320,240', '--project', project]);
    assert.equal(r.width, 320);
    assert.equal(r.alphaCoverage, 1);
    const s = ok(['inspect', 'selection', '--project', project]);
    assert.ok(s.selection.coverage > 0);
  });

  it('commits, branches, resets and checks out', () => {
    const c = ok(['commit', '-m', 'first', '--project', project]);
    assert.match(c.id, /^c_[0-9a-f]{12}$/);
    const log = ok(['history.log', '--project', project]);
    assert.equal(log.commits[0].message, 'first');
    ok(['history.branch', 'alt', '--project', project]);
    const branches = ok(['history.branches', '--project', project]);
    assert.equal(branches.current, 'alt');
    ok(['history.reset', 'HEAD~1', '--project', project]);
    const afterReset = ok(['status', '--project', project]);
    assert.equal(afterReset.layerCount, 0);
    ok(['history.checkout', 'main', '--project', project]);
    const back = ok(['status', '--project', project]);
    assert.equal(back.layerCount, 4);
  });

  it('exports resized variants and presets', () => {
    const out = ok(['export', path.join(dir, 'w160.png'), '--width', '160', '--project', project]);
    assert.equal(out.width, 160);
    const presets = path.join(dir, 'presets.json');
    writeFileSync(presets, JSON.stringify([
      { out: path.join(dir, 'p1.png'), width: 100 },
      { out: path.join(dir, 'p2.png'), height: 90, format: 'jpeg', quality: 85 },
    ]));
    const res = ok(['export', '--presets', presets, '--project', project]);
    assert.equal(res.exported.length, 2);
    assert.equal(res.exported[0].width, 100);
  });

  it('runs batch ops atomically and rolls back on failure', () => {
    const before = ok(['status', '--project', project]).layerCount;
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ steps: [{ op: 'layer.remove', args: { layer: 'does-not-exist' } }] }));
    const err = fails(['run', bad, '--atomic', '--project', project]);
    assert.equal(err.code, 'E_LAYER_NOT_FOUND');
    assert.equal(err.details.failedAtStep, 1);
    assert.equal(ok(['status', '--project', project]).layerCount, before);

    const good = path.join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({
      vars: { leaf: 'base' },
      steps: [
        { op: 'layer.set', args: { layer: '${leaf}', opacity: 0.9 } },
        { op: 'select.rect', args: { rect: { x: 0, y: 0, width: 40, height: 40 } } },
      ],
    }));
    const run = ok(['run', good, '--atomic', '--commit', '-m', 'scripted', '--project', project]);
    assert.equal(run.steps.length, 2);
    assert.ok(run.committed.id);
  });

  it('supports layer grouping, filters and merge-down', () => {
    const p2 = path.join(dir, 'layers.ashop');
    ok(['init', '200', '160', '--project', p2]);
    ok(['layer', 'import', sample, '--name', 'img', '--fit', 'cover', '--project', p2]);
    ok(['layer', 'fill', '--color', '#203040', '--name', 'bg', '--z-index', '0', '--project', p2]);
    ok(['filter', 'add', 'gaussian-blur', '--layer', 'img', '--radius', '3', '--project', p2]);
    ok(['layer', 'group', 'img', '--name', 'art', '--project', p2]);
    const grouped = ok(['status', '--project', p2]);
    assert.equal(grouped.layerCount, 3);
    assert.ok(grouped.layers.some((l) => l.type === 'group'));
    ok(['layer', 'ungroup', 'art', '--project', p2]);
    const merged = ok(['layer', 'merge-down', 'img', '--project', p2]);
    assert.equal(merged.layer.type, 'raster');
  });

  it('reports structured usage errors', () => {
    const err = fails(['layer', 'set', 'nope', '--opacity', '0.5', '--project', project]);
    assert.equal(err.code, 'E_LAYER_NOT_FOUND');
    assert.ok(err.hint);
    const badFlag = fails(['status', '--nope', '--project', project]);
    assert.equal(badFlag.code, 'E_USAGE');
    assert.match(badFlag.hint, /did you mean|known options/);
  });
});

describe('daemon', () => {
  it('starts on demand and stops cleanly', async () => {
    const p = path.join(dir, 'daemon.ashop');
    ok(['init', '64', '64', '--project', p]);
    const env = { ASHOP_NO_DAEMON: '0' };
    const c = cli(['commit', '-m', 'via daemon', '--project', p], { env });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(c.json.ok, true, JSON.stringify(c.json));
    const st = cli(['daemon.status', '--project', p], { env });
    assert.equal(st.json.data.running, true);
    const log = cli(['history.log', '--project', p], { env });
    assert.equal(log.json.data.commits[0].message, 'via daemon');
    cli(['daemon.stop', '--project', p], { env });
    const st2 = cli(['daemon.status', '--project', p], { env });
    assert.equal(st2.json.data.running, false);
  });
});
