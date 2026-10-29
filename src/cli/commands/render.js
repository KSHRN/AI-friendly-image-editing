/** Render and export commands. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AshopError } from '../../core/errors.js';

export default [
  {
    name: 'render',
    summary: 'Render the current canvas to an image file',
    mutates: false,
    params: {
      out: { type: 'path', positional: true, required: true, desc: 'output file (.png/.jpg/.webp)' },
      scale: { type: 'number', default: 1 },
      format: { type: 'enum', values: ['png', 'jpeg', 'webp', 'avif', 'tiff'], desc: 'defaults from the extension' },
      quality: { type: 'int', default: 90 },
    },
    examples: ['ashop render out/preview.png', 'ashop render out/half.png --scale 0.5'],
    async run(ctx, args) {
      return ctx.session.exportTo(args.out, {
        scale: args.scale,
        format: args.format,
        quality: args.quality,
      });
    },
  },
  {
    name: 'export',
    summary: 'Export the canvas at specific sizes, or run a preset list',
    mutates: false,
    params: {
      out: { type: 'path', positional: true, desc: 'output file' },
      width: { type: 'int', desc: 'target width' },
      resize: { type: 'int', desc: 'alias for --width' },
      height: { type: 'int', desc: 'target height' },
      scale: { type: 'number', default: 1 },
      format: { type: 'enum', values: ['png', 'jpeg', 'webp', 'avif', 'tiff'] },
      quality: { type: 'int', default: 90 },
      presets: { type: 'string', desc: 'JSON file with [{out,width,height,format,quality}]' },
    },
    examples: [
      'ashop export out/final_1200.png --width 1200',
      'ashop export --presets presets.json',
    ],
    async run(ctx, args) {
      if (args.presets) {
        let presets;
        try {
          presets = JSON.parse(await readFile(path.resolve(args.presets), 'utf8'));
        } catch (err) {
          throw new AshopError('E_USAGE', `cannot read presets file: ${args.presets}`, { cause: err });
        }
        if (!Array.isArray(presets)) throw new AshopError('E_USAGE', 'presets file must contain a JSON array');
        const results = [];
        for (const preset of presets) {
          if (!preset.out) throw new AshopError('E_USAGE', 'each preset needs an "out" path');
          results.push(await ctx.session.exportTo(preset.out, {
            width: preset.width,
            height: preset.height,
            scale: preset.scale ?? 1,
            format: preset.format,
            quality: preset.quality ?? 90,
          }));
        }
        return { exported: results };
      }
      if (!args.out) throw new AshopError('E_USAGE', 'export needs an output path or --presets');
      return ctx.session.exportTo(args.out, {
        width: args.width ?? args.resize,
        height: args.height,
        scale: args.scale,
        format: args.format,
        quality: args.quality,
      });
    },
  },
];
