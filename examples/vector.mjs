#!/usr/bin/env node
/**
 * Appearance-layer demo: gradients, multi-fill objects, dashed gradient
 * strokes, gradient text and an imported SVG mark — all scripted.
 *
 * Run: node examples/vector.mjs   (outputs land in examples/out/)
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'examples', 'out');
const BIN = path.join(ROOT, 'bin', 'ashop.js');
const PROJECT = path.join(OUT, 'vector_demo.ashop');

mkdirSync(OUT, { recursive: true });

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args, '--project', PROJECT, '--no-daemon'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ASHOP_NO_DAEMON: '1' },
  });
  if (res.status !== 0) {
    process.stderr.write(res.stderr || res.stdout);
    throw new Error(`failed: ashop ${args.join(' ')}`);
  }
  return JSON.parse(res.stdout);
}

function makeMark() {
  const file = path.join(OUT, 'mark.svg');
  writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">
  <defs>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff0055"/>
      <stop offset="1" stop-color="#00e5ff"/>
    </linearGradient>
  </defs>
  <circle cx="60" cy="60" r="48" fill="none" stroke="url(#ring)" stroke-width="8"/>
  <path d="M38 62 L54 78 L84 42" fill="none" stroke="#ffffff" stroke-width="9"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);
  return file;
}

function main() {
  if (existsSync(PROJECT)) rmSync(PROJECT, { recursive: true, force: true });
  const mark = makeMark();

  console.log('· canvas');
  run(['init', '800', '500', '--name', 'Vector Demo']);

  console.log('· gradient backdrop');
  run(['layer.fill', '--fill', 'linear-gradient(160deg,#0f172a 0%,#1e293b 60%,#0b1220 100%)', '--name', 'backdrop']);

  console.log('· soft radial glow');
  run(['shape.add', 'ellipse', '--ellipse', '620,120,220,160',
    '--fill', 'radial-gradient(circle at 50% 50%,#00e5ffcc 0%,#00e5ff00 100%)',
    '--name', 'glow']);

  console.log('· card with gradient + dashed stroke + shadow');
  run(['shape.add', 'rect', '--rect', '60,60,680,380', '--radius', '28',
    '--fill', 'radial-gradient(circle at 20% 10%,#ffffff 0%,#e8eef7 45%,#cfd8e6 100%)',
    '--stroke', 'linear-gradient(90deg,#ff0055,#00e5ff)', '--stroke-width', '3',
    '--name', 'card']);
  run(['style.add', 'drop-shadow', '--layer', 'card', '--color', '#000000aa', '--offset-y', '18', '--blur', '36']);

  console.log('· badge with a cut-out (pathfinder)');
  run(['shape.add', 'rect', '--rect', '100,320,300,80', '--radius', '40',
    '--fills', '[{"type":"solid","color":"#0f172a"},{"type":"linear-gradient","angle":90,"stops":["#ffffff00","#ffffff22"]}]',
    '--name', 'pill']);
  run(['shape.add', 'ellipse', '--ellipse', '372,360,34,34', '--fill', '#ffffff', '--name', 'cut']);
  run(['path.boolean', 'pill', 'cut', '--op', 'subtract', '--name', 'badge']);

  console.log('· gradient text');
  run(['text.add', '--content', 'ASHOP', '--font', 'Arial', '--size', '96', '--weight', '700',
    '--fill', 'linear-gradient(90deg,#ff0055,#00e5ff)', '--pos', '100,120', '--name', 'title']);
  run(['text.add', '--content', '矢量外观 · 渐变 / 描边 / SVG', '--font', 'Microsoft YaHei', '--size', '28',
    '--color', '#64748b', '--pos', '104,230', '--name', 'subtitle']);

  console.log('· dashed gradient ring + imported mark');
  run(['shape.add', 'ellipse', '--ellipse', '640,400,70,70',
    '--fill', 'none', '--stroke', 'linear-gradient(90deg,#ff0055,#00e5ff)',
    '--stroke-width', '10', '--stroke-dash', '22,14', '--stroke-linecap', 'round',
    '--name', 'ring']);
  run(['shape.import', mark, '--name', 'mark', '--at', '620,90', '--scale', '0.75']);
  run(['shape.export', 'card', path.join(OUT, 'card.svg')]);

  console.log('· render');
  const full = run(['render', path.join(OUT, 'vector_demo.png')]).data;
  run(['export', path.join(OUT, 'vector_demo_400.png'), '--resize', '400']);
  run(['commit', '-m', 'demo: appearance layer']);

  console.log('');
  console.log(`project : ${PROJECT}`);
  console.log(`output  : ${full.file}  ${full.width}x${full.height}  ${full.bytes} bytes`);
  console.log(`pixel   : ${full.pixelHash}`);
}

main();
