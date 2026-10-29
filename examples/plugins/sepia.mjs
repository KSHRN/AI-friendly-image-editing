#!/usr/bin/env node
/**
 * Reference AShop plugin.
 *
 * A plugin reads one JSON request from stdin, reads the input RGBA buffer from
 * `request.input.path`, writes the same number of pixels to
 * `request.output.path`, and prints one JSON response.
 *
 * Run it:
 *   ashop plugin.add --name sepia --command node --args '["examples/plugins/sepia.mjs"]'
 *   ashop plugin.run --name sepia --layer base --params '{"amount":0.8}'
 */

import { readFileSync, writeFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
let response;
try {
  const request = JSON.parse(input);
  const { input: src, output: dst, params = {} } = request;
  const amount = Math.max(0, Math.min(1, Number(params.amount ?? 0.8)));
  const buf = readFileSync(src.path);
  if (buf.length !== src.width * src.height * 4) {
    throw new Error(`unexpected input size ${buf.length}`);
  }
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const sr = 0.393 * r + 0.769 * g + 0.189 * b;
    const sg = 0.349 * r + 0.686 * g + 0.168 * b;
    const sb = 0.272 * r + 0.534 * g + 0.131 * b;
    out[i] = r + (Math.min(255, sr) - r) * amount;
    out[i + 1] = g + (Math.min(255, sg) - g) * amount;
    out[i + 2] = b + (Math.min(255, sb) - b) * amount;
    out[i + 3] = buf[i + 3];
  }
  writeFileSync(dst.path, out);
  response = { ok: true, meta: { plugin: 'sepia', amount, width: src.width, height: src.height } };
} catch (err) {
  response = { ok: false, error: { code: 'E_PLUGIN_FAILED', message: String(err && err.message ? err.message : err) } };
}
process.stdout.write(JSON.stringify(response) + '\n');
