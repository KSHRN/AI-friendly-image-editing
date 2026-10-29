/** Vector shape commands. */

import { AshopError } from '../../core/errors.js';

export default [
  {
    name: 'shape.add',
    aliases: ['shape'],
    summary: 'Add a vector shape layer (rect / ellipse / polygon / path)',
    params: {
      kind: { type: 'enum', values: ['rect', 'ellipse', 'polygon', 'path'], positional: true, required: true },
      rect: { type: 'rect', desc: 'rect geometry "x,y,w,h"' },
      ellipse: { type: 'numberList', desc: 'ellipse geometry "cx,cy,rx,ry"' },
      polygon: { type: 'polygon', desc: 'polygon points' },
      'svg-path': { type: 'string', desc: 'path data' },
      box: { type: 'rect', desc: 'content box for path shapes (defaults to canvas)' },
      radius: { type: 'number', default: 0, desc: 'corner radius for rect' },
      fill: { type: 'color', desc: 'fill colour (omit for none)' },
      stroke: { type: 'color', desc: 'stroke colour' },
      'stroke-width': { type: 'number', default: 0 },
      name: { type: 'string', default: 'Shape' },
      'z-index': { type: 'int' },
      opacity: { type: 'number', default: 1 },
      blend: { type: 'string', default: 'normal' },
      rotation: { type: 'number', default: 0 },
    },
    examples: ['ashop shape.add rect --rect "100,80,400,120" --radius 16 --fill "#ff0055"'],
    async run(ctx, args) {
      const stroke = args['stroke-width'] > 0
        ? { color: args.stroke ?? '#000000', width: args['stroke-width'], lineJoin: 'round' }
        : null;
      const base = { fill: args.fill ?? null, stroke, name: args.name, zIndex: args['z-index'], opacity: args.opacity, blend: args.blend, rotation: args.rotation };
      let layer;
      if (args.kind === 'rect') {
        if (!args.rect) throw new AshopError('E_USAGE', 'rect needs --rect "x,y,w,h"');
        const { x, y, width, height } = args.rect;
        layer = ctx.session.addShapeLayer({
          ...base,
          width,
          height,
          x,
          y,
          shapes: [{ kind: 'rect', x: 0, y: 0, width, height, radius: args.radius }],
        });
      } else if (args.kind === 'ellipse') {
        if (!args.ellipse || args.ellipse.length < 4) throw new AshopError('E_USAGE', 'ellipse needs --ellipse "cx,cy,rx,ry"');
        const [cx, cy, rx, ry] = args.ellipse;
        layer = ctx.session.addShapeLayer({
          ...base,
          width: rx * 2,
          height: ry * 2,
          x: cx - rx,
          y: cy - ry,
          shapes: [{ kind: 'ellipse', cx: rx, cy: ry, rx, ry }],
        });
      } else if (args.kind === 'polygon') {
        if (!args.polygon) throw new AshopError('E_USAGE', 'polygon needs --polygon "x1,y1 x2,y2 ..."');
        const xs = args.polygon.map((p) => p.x);
        const ys = args.polygon.map((p) => p.y);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const width = Math.max(...xs) - minX;
        const height = Math.max(...ys) - minY;
        layer = ctx.session.addShapeLayer({
          ...base,
          width,
          height,
          x: minX,
          y: minY,
          shapes: [{ kind: 'polygon', points: args.polygon.map((p) => ({ x: p.x - minX, y: p.y - minY })) }],
        });
      } else {
        if (!args['svg-path']) throw new AshopError('E_USAGE', 'path needs --svg-path');
        const box = args.box ?? { x: 0, y: 0, width: ctx.session.doc.canvas.width, height: ctx.session.doc.canvas.height };
        layer = ctx.session.addShapeLayer({
          ...base,
          width: box.width,
          height: box.height,
          x: box.x,
          y: box.y,
          shapes: [{ kind: 'path', d: args['svg-path'] }],
        });
      }
      return { layer };
    },
  },
  {
    name: 'shape.info',
    summary: 'Show a shape layer’s vector content',
    mutates: false,
    params: { layer: { type: 'string', positional: true, required: true } },
    async run(ctx, args) {
      const { findLayer } = await import('../../core/document.js');
      return { layer: findLayer(ctx.session.doc, args.layer).layer };
    },
  },
];
