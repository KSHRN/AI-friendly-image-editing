#!/usr/bin/env node
/**
 * Full command smoke test: exercises nearly every CLI command against one
 * throw-away project. Run with `node scripts/smoke.mjs`.
 *
 * This is a development aid (the node:test suite covers correctness); it is
 * here to catch "command wired up wrong" regressions quickly.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'ashop.js');
const dir = mkdtempSync(path.join(os.tmpdir(), 'ashop-smoke-'));
const project = path.join(dir, 'smoke.ashop');
const sample = path.join(dir, 'sample.png');
let steps = 0;
let failures = 0;

function run(args, { expectFail = false } = {}) {
  steps++;
  const res = spawnSync(process.execPath, [BIN, ...args, '--project', project, '--no-daemon'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ASHOP_NO_DAEMON: '1' },
  });
  let json = null;
  for (const stream of [res.stdout, res.stderr]) {
    try { json = JSON.parse(stream); break; } catch { /* text output */ }
  }
  const ok = res.status === 0 && json?.ok;
  if (expectFail ? ok : !ok) {
    failures++;
    console.error(`\n✖ ashop ${args.join(' ')}`);
    console.error(res.stderr || res.stdout);
  }
  return json?.data;
}

async function main() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300">
    <rect width="100%" height="100%" fill="#f2f2f2"/>
    <circle cx="200" cy="150" r="80" fill="#cc2244"/>
    <rect x="300" y="20" width="70" height="50" fill="#2244cc"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(sample);

  console.log('· project');
  run(['init', '400', '300', '--name', 'smoke']);
  const base = run(['layer', 'import', sample, '--name', 'base', '--fit', 'stretch', '--at', '0,0']).layer;
  const bg = run(['layer', 'fill', '--color', '#203040', '--name', 'bg', '--z-index', '0']).layer;

  console.log('· layer commands');
  run(['layer', 'list']);
  run(['layer', 'info', base.id]);
  run(['status', '--with-selection']);
  run(['layer', 'set', base.id, '--opacity', '0.95', '--blend', 'normal', '--visible', 'true']);
  run(['layer', 'set', base.id, '--clip-to', bg.id]);
  run(['layer', 'set', base.id, '--clip-to', '']);
  run(['layer', 'transform', base.id, '--dx', '4', '--scale', '0.98', '--rotation', '2']);
  const copy = run(['layer', 'duplicate', base.id, '--name', 'copy']).layer;
  run(['layer', 'move', copy.id, '--to-index', '2']);
  run(['layer', 'remove', copy.id]);

  console.log('· selections');
  run(['select', 'rect', '--rect', '40,40,200,160', '--feather', '2px']);
  run(['select', 'ellipse', '--ellipse', '200,150,80,60', '--mode', 'add']);
  run(['select', 'polygon', '--polygon', '10,10 120,10 60,90', '--mode', 'subtract']);
  run(['select', 'path', '--svg-path', 'M 10 10 H 90 V 90 H 10 Z', '--mode', 'add']);
  run(['select', 'invert']);
  run(['select', 'modify', '--grow', '2', '--shrink', '1', '--border', '2', '--feather', '1']);
  run(['select', 'color', '--color', '#f2f2f2', '--tolerance', '16']);
  run(['select', 'color', '--color', '#ffffff', '--at', '10,10', '--contiguous', '--tolerance', '20']);
  run(['select', 'luminance', '--threshold', '100', '--softness', '10']);
  run(['select', 'alpha', '--threshold', '1']);
  run(['select', 'all']);
  run(['inspect', 'selection']);
  run(['select', 'none']);

  console.log('· masks');
  run(['select', 'rect', '--rect', '100,80,220,160']);
  run(['mask', 'from-selection', '--layer', base.id, '--feather', '1']);
  run(['mask', 'export', '--layer', base.id, '--out', path.join(dir, 'mask.png')]);
  run(['mask', 'modify', '--layer', base.id, '--feather', '1']);
  run(['mask', 'apply', '--layer', base.id]);

  console.log('· adjustments');
  run(['adjust', 'list']);
  const bc = run(['adjust', 'add', 'brightness-contrast', '--layer', base.id, '--brightness', '4', '--contrast', '8']).layer;
  run(['adjust', 'add', 'levels', '--black', '0']);
  run(['adjust', 'add', 'hue-saturation', '--hue', '5', '--saturation', '1.05']);
  run(['adjust', 'add', 'color-balance', '--shadows', '[0,0,10]']);
  run(['adjust', 'add', 'threshold', '--threshold', '120']);
  run(['adjust', 'add', 'posterize', '--levels', '6']);
  run(['adjust', 'add', 'gamma', '--gamma', '1.05']);
  run(['adjust', 'add', 'invert']);
  run(['adjust', 'add', 'desaturate', '--amount', '0.2']);
  run(['adjust', 'add', 'vibrance', '--amount', '0.3']);
  run(['adjust', 'set', bc.id, '--brightness', '6']);
  const curves = run(['adjust', 'add', 'curves', '--layer', base.id, '--rgb', '[[0,0],[128,148],[255,255]]']).layer;

  console.log('· filters');
  run(['filter', 'list']);
  for (const [name, args] of [
    ['gaussian-blur', ['--radius', '2']],
    ['motion-blur', ['--length', '8', '--angle', '30']],
    ['sharpen', ['--amount', '0.6', '--radius', '1']],
    ['noise', ['--amount', '4', '--seed', '3']],
    ['pixelate', ['--size', '4']],
    ['emboss', ['--strength', '0.5']],
    ['liquify', ['--ops', '[{"mode":"push","x":200,"y":150,"radius":80,"dx":10,"dy":0}]']],
  ]) {
    run(['filter', 'add', name, '--layer', base.id, ...args]);
  }
  run(['filter', 'clear', '--layer', base.id]);

  console.log('· styles');
  run(['style', 'add', 'drop-shadow', '--layer', base.id, '--offset-y', '6', '--blur', '10']);
  run(['style', 'add', 'stroke', '--layer', base.id, '--width', '2']);
  run(['style', 'add', 'inner-glow', '--layer', base.id, '--blur', '6']);
  run(['style', 'add', 'outer-glow', '--layer', base.id, '--blur', '8']);
  run(['style', 'add', 'bevel', '--layer', base.id, '--size', '4']);
  run(['style', 'info', '--layer', base.id]);
  run(['style', 'remove', '--layer', base.id, '--type', 'bevel']);
  run(['style', 'list']);

  console.log('· text / shapes');
  const text = run(['text', 'add', '--content', 'SMOKE 测试', '--font', 'Microsoft YaHei', '--size', '28', '--color', '#ffffff', '--pos', '24,24', '--width', '300']).layer;
  run(['text', 'set', text.id, '--content', 'SMOKE 测试 2', '--color', '#ffeeaa']);
  run(['text', 'measure', '--content', 'hello', '--font', 'Arial', '--size', '20']);
  run(['shape', 'add', 'rect', '--rect', '20,220,120,50', '--radius', '10', '--fill', '#ffcc00']);
  run(['shape', 'add', 'ellipse', '--ellipse', '300,250,40,20', '--fill', '#00ccaa']);
  run(['shape', 'add', 'polygon', '--polygon', '150,200 200,260 100,260', '--fill', '#aa55ff']);
  run(['shape', 'add', 'path', '--svg-path', 'M20 20 L80 20 L80 60 Z', '--box', '0,0,120,80', '--fill', '#ff8800']);

  console.log('· render / export / diff / inspect');
  const a = run(['render', path.join(dir, 'a.png')]);
  const b = run(['render', path.join(dir, 'b.png')]);
  run(['diff', a.file, b.file]);
  run(['export', path.join(dir, 'small.png'), '--resize', '120']);
  run(['export', path.join(dir, 'small.jpg'), '--width', '120', '--format', 'jpeg']);
  run(['inspect', 'pixel', '--at', '200,150']);
  run(['inspect', 'region', '--rect', '0,0,400,300']);
  run(['inspect', 'histogram', '--bins', '32']);
  run(['inspect', 'colors', '--limit', '3']);
  run(['inspect', 'image']);
  run(['inspect', 'layer', base.id]);

  console.log('· history');
  const c1 = run(['commit', '-m', 'smoke one']);
  run(['commit', '-m', 'smoke two']);
  run(['history', 'log', '--limit', '5']);
  run(['history', 'show', 'HEAD']);
  run(['history', 'diff', 'HEAD~1', 'HEAD']);
  run(['branch', 'smoke-alt']);
  run(['history', 'branches']);
  run(['history', 'reset', '--hard', 'HEAD~1']);
  run(['history', 'checkout', 'main', '--force']);

  console.log('· plugins');
  run(['plugin', 'add', '--name', 'sepia', '--command', 'node', '--args', '["examples/plugins/sepia.mjs"]']);
  run(['plugin', 'list']);
  run(['plugin', 'run', '--name', 'sepia', '--layer', base.id, '--params', '{"amount":0.4}']);
  run(['plugin', 'remove', '--name', 'sepia']);

  console.log('· batch');
  const opsFile = path.join(dir, 'ops.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(opsFile, JSON.stringify({
    vars: { opacity: 0.8 },
    steps: [
      { op: 'layer.set', args: { layer: base.id, opacity: '${opacity}' } },
      { op: 'select.rect', args: { rect: { x: 0, y: 0, width: 30, height: 30 } } },
      { op: 'echo', args: { message: 'smoke batch done' } },
    ],
  }));
  run(['run', opsFile, '--atomic', '--commit', '-m', 'batch']);
  run(['run', opsFile, '--dry-run']);

  console.log('· misc');
  run(['fonts', 'list', '--filter', 'arial', '--limit', '5']);
  run(['fonts', 'info']);
  run(['describe', 'filters']);
  run(['describe', 'styles']);
  run(['describe', 'blends']);
  run(['describe', 'commands']);
  run(['schema']);
  run(['daemon', 'status']);
  run(['save']);

  console.log(`\n${failures === 0 ? '✓' : '✖'} smoke: ${steps} commands, ${failures} failure(s)`);
  console.log(`  project: ${project}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  // Keep the project on failure for inspection; clean up on success.
  if (failures === 0) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
