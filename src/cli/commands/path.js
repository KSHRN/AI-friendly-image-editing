/** Path operations: boolean combination of shape layers (the pathfinder). */

import { PATH_BOOLEAN_OPS } from '../../core/pathops.js';

export default [
  {
    name: 'path.boolean',
    aliases: ['pathfinder'],
    summary: 'Combine two shape layers with a pathfinder boolean (unite/subtract/intersect/exclude)',
    params: {
      layer: { type: 'string', positional: true, required: true, desc: 'first shape layer (paint source)' },
      other: { type: 'string', positional: true, required: true, desc: 'second shape layer' },
      op: { type: 'enum', values: PATH_BOOLEAN_OPS, default: 'unite' },
      'keep-originals': { type: 'bool', default: false, desc: 'keep both input layers instead of replacing them' },
      tolerance: { type: 'number', default: 0.2, desc: 'curve flattening tolerance in px (smaller = smoother, more points)' },
      name: { type: 'string', desc: 'result layer name' },
    },
    examples: [
      'ashop path.boolean badge hole --op subtract',
      'ashop path.boolean logo circle --op intersect --tolerance 0.1',
    ],
    async run(ctx, args) {
      const layer = ctx.session.booleanPaths(args.layer, args.other, args.op, {
        keepOriginals: args['keep-originals'],
        name: args.name,
        tolerance: args.tolerance,
      });
      return { layer };
    },
  },
  {
    name: 'path.info',
    summary: 'Show a shape layer’s path geometry (bounding box and subpath count)',
    mutates: false,
    params: {
      layer: { type: 'string', positional: true, required: true },
      tolerance: { type: 'number', default: 0.2 },
    },
    async run(ctx, args) {
      const { findLayer } = await import('../../core/document.js');
      const { normalizeShapeContent } = await import('../../core/shapes.js');
      const { shapeToPolygons } = await import('../../core/pathops.js');
      const { layer } = findLayer(ctx.session.doc, args.layer);
      if (layer.type !== 'shape') {
        return { layer: { id: layer.id, type: layer.type }, paths: [] };
      }
      const content = normalizeShapeContent(layer.content);
      const rings = shapeToPolygons(layer, { tolerance: args.tolerance });
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const ring of rings) {
        for (const [x, y] of ring) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      const bbox = rings.length
        ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
        : null;
      return {
        layer: { id: layer.id, name: layer.name, type: layer.type },
        objects: content.shapes.length,
        subpaths: rings.length,
        points: rings.reduce((sum, ring) => sum + ring.length, 0),
        canvasBounds: bbox,
        tolerance: args.tolerance,
      };
    },
  },
];
