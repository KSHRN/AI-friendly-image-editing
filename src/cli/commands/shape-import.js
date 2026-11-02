/** Import an SVG file as a vector shape layer. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { importSvg } from '../../core/svgimport.js';
import { AshopError } from '../../core/errors.js';

export default {
  name: 'shape.import',
  summary: 'Import an SVG file as a vector shape layer',
  params: {
    file: { type: 'path', positional: true, required: true, desc: 'SVG file to import' },
    name: { type: 'string', desc: 'layer name (defaults to the file name)' },
    'z-index': { type: 'int', desc: 'stacking order: higher sits above lower, equal z keeps insertion order (later on top)' },
    at: { type: 'point', desc: 'top-left position on canvas' },
    scale: { type: 'number', default: 1 },
    rotation: { type: 'number', default: 0 },
    opacity: { type: 'number', default: 1 },
    blend: { type: 'string', default: 'normal' },
  },
  examples: ['ashop shape.import logo.svg --name logo --at 40,40'],
  async run(ctx, args) {
    const file = path.resolve(ctx.cwd, args.file);
    let source;
    try {
      source = await readFile(file);
    } catch (err) {
      throw new AshopError('E_USAGE', `cannot read SVG file: ${args.file}`, {
        hint: 'check that the path exists and is readable',
        cause: err,
      });
    }

    const { content, warnings } = await importSvg(source);
    if (content.shapes.length === 0) {
      throw new AshopError('E_SVG_EMPTY', 'SVG contains no importable geometry', {
        hint: `the document only used unsupported elements${warnings.length ? ` (${warnings.join('; ')})` : ''}`,
      });
    }

    const layer = ctx.session.addShapeLayer({
      shapes: content.shapes,
      width: content.width,
      height: content.height,
      fills: content.fills,
      strokes: content.strokes,
      name: args.name ?? path.basename(file),
      x: args.at?.x ?? 0,
      y: args.at?.y ?? 0,
      zIndex: args['z-index'],
      opacity: args.opacity,
      blend: args.blend,
      rotation: args.rotation,
    });
    if (args.scale !== 1) ctx.session.transform(layer.id, { scale: args.scale });

    return { layer, shapes: content.shapes.length, warnings };
  },
};
