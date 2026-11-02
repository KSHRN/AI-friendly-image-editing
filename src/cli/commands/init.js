/** Create a new project bundle. */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { Session } from '../../core/session.js';
import { decodeFile } from '../../core/codec.js';
import { createHistory } from '../../core/history.js';
import { setCurrentProject, sessionPath } from '../session-loader.js';
import { AshopError, fail } from '../../core/errors.js';
import { parseColor } from '../../core/raster.js';

/**
 * Canvas background accepts a colour or the literal "transparent".
 *
 * The default is already transparent, but the generic `color` parameter type
 * rejects the word "transparent", so `init --background transparent` failed
 * even though help and `schema` documented it (F-006). Keep both forms valid
 * and store "transparent" canonically so the compositor skips the fill.
 */
function normalizeBackground(value) {
  if (value === undefined || value === null || value === '') return 'transparent';
  const raw = String(value).trim();
  if (raw.toLowerCase() === 'transparent') return 'transparent';
  try {
    parseColor(raw);
  } catch {
    fail('E_USAGE', 'background must be a colour like "#ff0000", "#ff000080", "255,0,0" or "transparent"', {
      hint: `got "${value}"`,
    });
  }
  return raw;
}

export default {
  name: 'init',
  aliases: ['create', 'new'],
  summary: 'Create a new project (canvas size, or dimensions from an image)',
  needsSession: false,
  outputText: false,
  params: {
    width: { type: 'int', positional: true, desc: 'canvas width in pixels' },
    height: { type: 'int', positional: true, desc: 'canvas height in pixels' },
    'from-image': { type: 'path', desc: 'use the dimensions of this image as the canvas' },
    background: { type: 'string', default: 'transparent', desc: 'canvas background colour or "transparent" (= #00000000)' },
    name: { type: 'string', desc: 'project name' },
  },
  examples: [
    'ashop init 1200 1200',
    'ashop init --from-image shoot.jpg --session sku_1024',
  ],
  async run(ctx, args) {
    const target = ctx.projectArg
      ? path.resolve(ctx.cwd, ctx.projectArg)
      : ctx.sessionArg
        ? sessionPath(ctx.cwd, ctx.sessionArg)
        : path.join(ctx.cwd, 'untitled.ashop');
    if (existsSync(target)) {
      throw new AshopError('E_PROJECT_EXISTS', `project already exists: ${target}`, {
        hint: 'use `ashop open` to attach to it, or choose another --project path',
      });
    }
    let width = args.width;
    let height = args.height;
    let imageRaster = null;
    if (args['from-image']) {
      imageRaster = await decodeFile(args['from-image']);
      width = imageRaster.width;
      height = imageRaster.height;
    }
    if (!width || !height) {
      fail('E_USAGE', 'init needs a canvas size', { hint: 'ashop init 1200 1200   (or --from-image photo.jpg)' });
    }
    const session = await Session.createProject(target, {
      width,
      height,
      background: normalizeBackground(args.background),
      name: args.name ?? path.basename(target, '.ashop'),
    });
    if (imageRaster) {
      const { readFile } = await import('node:fs/promises');
      await session.importImage({
        buffer: await readFile(path.resolve(args['from-image'])),
        name: path.basename(args['from-image']),
        fit: 'stretch',
        at: { x: 0, y: 0 },
      });
      // Make the imported image part of the *initial* commit so HEAD always
      // reflects what the user sees right after `init --from-image`.
      session.project.history = createHistory(session.doc, `init from ${path.basename(args['from-image'])}`);
      await session.save();
    }
    await setCurrentProject(target);
    return {
      project: target,
      canvas: { width, height },
      layers: imageRaster ? 1 : 0,
      next: imageRaster ? 'ashop status' : 'ashop layer import <file> --name base',
    };
  },
};
