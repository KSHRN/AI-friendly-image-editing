/** Pixel-level regression diff. */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { decodeFile, encodeRaster } from '../../core/codec.js';
import { computeDiff } from '../../core/diff.js';

export default {
  name: 'diff',
  summary: 'Compare two images pixel by pixel (threshold, MAE, SSIM, diff image)',
  needsSession: false,
  mutates: false,
  params: {
    a: { type: 'path', positional: true, required: true, desc: 'baseline image' },
    b: { type: 'path', positional: true, required: true, desc: 'candidate image' },
    threshold: { type: 'number', default: 0.001, desc: 'max allowed mismatchRatio' },
    tolerance: { type: 'int', default: 16, desc: 'per-channel delta counted as a mismatch' },
    ssim: { type: 'bool', default: true },
    'diff-out': { type: 'path', desc: 'write an amplified diff image here' },
    amplify: { type: 'number', default: 4 },
  },
  examples: ['ashop diff baseline/a.png out/a.png --threshold 0.001 --diff-out out/diff.png'],
  async run(ctx, args) {
    const a = await decodeFile(args.a);
    const b = await decodeFile(args.b);
    const result = computeDiff(a, b, {
      threshold: args.threshold,
      tolerance: args.tolerance,
      ssim: args.ssim,
      diffImage: Boolean(args['diff-out']),
    });
    let diffFile = null;
    if (args['diff-out'] && result.diffRaster) {
      const target = path.resolve(args['diff-out']);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await encodeRaster(result.diffRaster, { format: 'png' }));
      diffFile = target;
    }
    const { diffRaster, ...rest } = result;
    return { ...rest, pass: result.metrics.mismatchRatio <= args.threshold, diffFile };
  },
};
