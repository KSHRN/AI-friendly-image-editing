#!/usr/bin/env node
/**
 * End-to-end demo: builds the PDR e-commerce composite from scratch.
 *
 * Run: npm run demo
 * Outputs land in examples/out/.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'examples', 'out');
const BIN = path.join(ROOT, 'bin', 'ashop.js');
const PROJECT = path.join(OUT, 'sku_demo.ashop');

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

async function makeAssets() {
  const shoot = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200">
    <rect width="100%" height="100%" fill="#f2f2f2"/>
    <circle cx="600" cy="560" r="300" fill="#c8203f"/>
    <circle cx="600" cy="560" r="300" fill="none" stroke="#a81631" stroke-width="6"/>
    <rect x="250" y="900" width="700" height="120" rx="12" fill="#e8e8ee"/>
  </svg>`;
  await sharp(Buffer.from(shoot)).jpeg({ quality: 94 }).toFile(path.join(OUT, 'shoot.jpg'));
  await sharp({ create: { width: 1200, height: 1200, channels: 4, background: { r: 20, g: 118, b: 130, alpha: 1 } } })
    .png().toFile(path.join(OUT, 'bg_teal.png'));
}

async function main() {
  console.log('· generating assets');
  await makeAssets();
  if (existsSync(PROJECT)) {
    rmSync(PROJECT, { recursive: true, force: true });
  }

  console.log('· init');
  run(['init', '1200', '1200', '--name', 'SKU Demo']);

  console.log('· import base photo + background');
  run(['layer', 'import', path.join(OUT, 'shoot.jpg'), '--name', 'base', '--fit', 'stretch', '--at', '0,0']);
  run(['layer', 'import', path.join(OUT, 'bg_teal.png'), '--name', 'bg', '--z-index', '0', '--fit', 'stretch']);

  console.log('· select background by colour → invert → mask');
  run(['select', 'color', '--color', '#f2f2f2', '--tolerance', '12']);
  run(['select', 'invert']);
  run(['mask', 'from-selection', '--layer', 'base', '--feather', '1']);
  // Colour-range selection keeps a sliver of anti-aliased background at the
  // subject edge; contracting by 1px removes that halo.
  run(['mask', 'modify', '--layer', 'base', '--shrink', '1', '--feather', '0.5']);

  console.log('· styles and colour');
  run(['style', 'add', 'drop-shadow', '--layer', 'base', '--color', '#00000066', '--offset-y', '16', '--blur', '30']);
  run(['adjust', 'add', 'curves', '--layer', 'base', '--rgb', '[[0,0],[128,154],[255,255]]']);

  console.log('· title');
  run(['text', 'add', '--content', 'SUMMER SALE', '--font', 'Arial', '--size', '96', '--color', '#ffffff', '--pos', '90,140']);
  run(['text', 'add', '--content', '确定性生成 · 1200×1200', '--font', 'Microsoft YaHei', '--size', '36', '--color', '#cdeff2', '--pos', '92,270']);

  console.log('· render + export');
  const full = run(['render', path.join(OUT, 'final_1200.png')]).data;
  run(['export', path.join(OUT, 'final_600.png'), '--resize', '600']);
  run(['export', path.join(OUT, 'final_300.jpg'), '--resize', '300', '--format', 'jpeg', '--quality', '88']);

  console.log('· determinism check');
  run(['render', path.join(OUT, 'final_1200_again.png')]);
  const diff = run(['diff', path.join(OUT, 'final_1200.png'), path.join(OUT, 'final_1200_again.png')]).data;

  console.log('· commit');
  run(['commit', '-m', 'demo: SKU 1200 composite']);
  const log = run(['history.log']).data;

  console.log('');
  console.log(`project : ${PROJECT}`);
  console.log(`output  : ${full.file}  ${full.width}x${full.height}  ${full.bytes} bytes`);
  console.log(`pixel   : ${full.pixelHash}`);
  console.log(`stable  : ${diff.identical} (mismatchRatio=${diff.metrics.mismatchRatio})`);
  console.log(`commits : ${log.commits.length} (HEAD ${log.head})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
