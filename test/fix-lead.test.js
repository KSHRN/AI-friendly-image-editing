import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { tempDir, ok, fails } from './helpers.js';

// F-003: `run` must parse a step's arguments through the same layer the CLI
// uses. F-007: a bad argument shape must come back as a structured E_USAGE
// with a hint, not as a raw JS exception. F-010: a script that builds the
// image from scratch must be re-runnable with --fresh.

const dir = tempDir('ashop-fix-lead-');
const project = path.join(dir, 'p.ashop');

function writeOps(name, steps) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({ steps }));
  return file;
}

before(() => {
  ok(['init', '900', '700', '--project', project]);
});

describe('run parses step arguments like the CLI', () => {
  it('reads "cx,cy,rx,ry" for an ellipse the same way', () => {
    const ops = writeOps('ellipse.json', [{
      op: 'shape.add',
      args: { kind: 'ellipse', ellipse: '450,350,200,120', fill: '#ff0055', name: 'disc' },
    }]);
    ok(['run', ops, '--project', project, '--fresh']);
    const info = ok(['layer.info', '--layer', 'disc', '--project', project]);
    const shape = info.layer.content.shapes[0];
    assert.equal(shape.kind, 'ellipse');
    assert.equal(shape.rx, 200);
    assert.equal(shape.ry, 120);
    // The layer transform is the canvas-space bounding box: 250 + rx = 450.
    assert.equal(info.layer.transform.x + shape.cx, 450);
    assert.equal(info.layer.transform.y + shape.cy, 350);
    assert.equal(info.layer.content.width, 400);
  });

  it('accepts a polygon as JSON points', () => {
    const ops = writeOps('polygon.json', [{
      op: 'shape.add',
      args: { kind: 'polygon', polygon: [[0, 0], [200, 0], [100, 160]], fill: '#00ff88', name: 'tri' },
    }]);
    ok(['run', ops, '--project', project, '--fresh']);
    const info = ok(['layer.info', '--layer', 'tri', '--project', project]);
    const shape = info.layer.content.shapes[0];
    assert.equal(shape.kind, 'polygon');
    assert.deepEqual(shape.points, [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 100, y: 160 }]);
  });

  it('applies the same defaults as a direct call', () => {
    const ops = writeOps('defaults.json', [{
      op: 'shape.add',
      args: { kind: 'ellipse', ellipse: [1, 2, 3, 4] },
    }]);
    const dry = ok(['run', ops, '--dry-run', '--project', project]);
    assert.equal(dry.steps[0].args.opacity, 1);
    assert.equal(dry.steps[0].args.blend, 'normal');
    assert.deepEqual(dry.steps[0].args.ellipse, [1, 2, 3, 4]);
  });
});

describe('bad arguments stay structured', () => {
  it('reports a malformed step argument as E_USAGE with a hint', () => {
    const ops = writeOps('bad.json', [{
      op: 'shape.add',
      args: { kind: 'polygon', polygon: 'oops', fill: '#000000' },
    }]);
    const err = fails(['run', ops, '--project', project, '--fresh']);
    assert.equal(err.code, 'E_USAGE');
    assert.ok(err.hint, 'expected a hint');
    assert.equal(err.details.failedAtStep, 1);
  });

  it('never leaks a raw JS exception for a bad type', () => {
    const err = fails(['shape.add', 'ellipse', '--ellipse', 'nope', '--project', project]);
    assert.equal(err.code, 'E_USAGE');
    assert.match(err.message, /list of numbers/);
    assert.ok(err.hint, 'expected a hint');
  });
});

describe('run --fresh makes a script re-runnable', () => {
  const steps = [
    { op: 'shape.add', args: { kind: 'ellipse', ellipse: '450,350,200,120', fill: '#ff0055', name: 'disc' } },
    { op: 'layer.info', args: { layer: 'disc' } },
  ];

  it('fails on a second run without --fresh (duplicate layer names)', () => {
    const ops = writeOps('named.json', steps);
    ok(['run', ops, '--project', project, '--fresh']);
    const err = fails(['run', ops, '--project', project]);
    assert.equal(err.code, 'E_LAYER_AMBIGUOUS');
  });

  it('starts from an empty canvas with --fresh', () => {
    const ops = writeOps('named2.json', steps);
    ok(['run', ops, '--project', project, '--fresh']);
    ok(['run', ops, '--project', project, '--fresh']);
    const list = ok(['layer.list', '--project', project]);
    assert.deepEqual(list.layers.map((l) => l.name), ['disc']);
    const status = ok(['status', '--project', project]);
    assert.equal(status.layerCount, 1);
  });

  it('does not reset the canvas for a dry run', () => {
    const ops = writeOps('named3.json', steps);
    ok(['run', ops, '--project', project, '--fresh']);
    const dry = ok(['run', ops, '--project', project, '--dry-run', '--fresh']);
    assert.equal(dry.dryRun, true);
    const status = ok(['status', '--project', project]);
    assert.equal(status.layerCount, 1);
  });
});
