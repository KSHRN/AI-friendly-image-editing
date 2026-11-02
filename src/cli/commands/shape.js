/** Vector shape commands: create, restyle and export shape layers. */

import { AshopError } from '../../core/errors.js';
import { shapeContentSummary } from '../../core/shapes.js';

const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];

/** Shared paint/stroke flags for `shape.add` and `shape.set`. */
const paintParams = {
  fill: { type: 'paint', desc: 'fill colour or CSS gradient, e.g. "#ff0055" or "linear-gradient(90deg,#f05,#05f)"' },
  fills: { type: 'json', desc: 'JSON array of fills, bottom first (overrides --fill)' },
  stroke: { type: 'paint', desc: 'stroke colour or gradient' },
  strokes: { type: 'json', desc: 'JSON array of strokes, bottom first (overrides --stroke)' },
  'stroke-width': { type: 'number', desc: 'stroke width in px (default 2 when --stroke is given)' },
  'stroke-linecap': { type: 'enum', values: CAPS, desc: 'stroke line cap' },
  'stroke-linejoin': { type: 'enum', values: JOINS, desc: 'stroke line join' },
  'stroke-miterlimit': { type: 'number', desc: 'miter limit for miter joins' },
  'stroke-dash': { type: 'numberList', desc: 'dash pattern in px, e.g. "8,4"' },
  'stroke-dash-offset': { type: 'number', desc: 'dash phase offset in px' },
};

/** Build the v2 paint stacks from CLI flags (undefined = let the engine default). */
function paintStacks(args) {
  const fills = args.fills !== undefined
    ? args.fills
    : (args.fill !== undefined ? args.fill : undefined);

  const hasStrokeFlag = args.stroke !== undefined || args.strokes !== undefined;
  if (args.strokes !== undefined) return { fills, strokes: args.strokes };
  if (!hasStrokeFlag) return { fills, strokes: undefined };
  // `--stroke none` clears the stroke instead of falling back to black.
  if (args.stroke === null) return { fills, strokes: [] };
  const width = args['stroke-width'] ?? 2;
  if (!(width > 0)) return { fills, strokes: [] };
  return {
    fills,
    strokes: [{
      paint: args.stroke ?? '#000000',
      width,
      lineCap: args['stroke-linecap'],
      lineJoin: args['stroke-linejoin'],
      miterLimit: args['stroke-miterlimit'],
      dash: args['stroke-dash'],
      dashOffset: args['stroke-dash-offset'],
    }],
  };
}

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
      ...paintParams,
      name: { type: 'string', default: 'Shape' },
      'z-index': { type: 'int' },
      opacity: { type: 'number', default: 1 },
      blend: { type: 'string', default: 'normal' },
      rotation: { type: 'number', default: 0 },
    },
    examples: [
      'ashop shape.add rect --rect "100,80,400,120" --radius 16 --fill "#ff0055"',
      'ashop shape.add ellipse --ellipse "600,400,200,120" --fill "linear-gradient(90deg,#ff0055,#0000ff)"',
      'ashop shape.add rect --rect "100,80,400,120" --fill "#102030" --stroke "#ffffff" --stroke-width 3 --stroke-dash "8,4"',
    ],
    async run(ctx, args) {
      const { fills, strokes } = paintStacks(args);
      const base = {
        fills,
        strokes,
        name: args.name,
        zIndex: args['z-index'],
        opacity: args.opacity,
        blend: args.blend,
        rotation: args.rotation,
      };
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
      return { layer, appearance: shapeContentSummary(layer.content) };
    },
  },
  {
    name: 'shape.set',
    summary: 'Restyle a shape layer: fills, strokes, stroke details, radius, fill rule',
    params: {
      layer: { type: 'string', positional: true, required: true },
      ...paintParams,
      'fill-rule': { type: 'enum', values: ['nonzero', 'evenodd'] },
      radius: { type: 'number', desc: 'corner radius for rect objects' },
      'shape-index': { type: 'int', desc: 'target one vector object instead of the layer defaults' },
      opacity: { type: 'number', desc: 'per-object opacity (requires --shape-index)' },
    },
    examples: [
      'ashop shape.set logo --fill "linear-gradient(120deg,#ff0055,#0000ff)"',
      'ashop shape.set logo --stroke "#ffffff" --stroke-width 2 --stroke-linecap round',
      'ashop shape.set logo --shape-index 0 --fill "#00ffaa"',
      'ashop shape.set badge --fill none --stroke "#222222" --stroke-width 4',
    ],
    async run(ctx, args) {
      const { fills, strokes } = paintStacks(args);
      const patch = {
        fills,
        strokes,
        radius: args.radius,
        shapeIndex: args['shape-index'],
        fillRule: args['fill-rule'],
        opacity: args.opacity,
        strokeLineCap: args['stroke-linecap'],
        strokeLineJoin: args['stroke-linejoin'],
        strokeMiterLimit: args['stroke-miterlimit'],
        strokeDash: args['stroke-dash'],
        strokeDashOffset: args['stroke-dash-offset'],
        strokeWidth: args['stroke-width'],
      };
      // Only forward what the user actually set; `updateShape` treats
      // undefined as "leave alone".
      for (const key of Object.keys(patch)) if (patch[key] === undefined) delete patch[key];
      const layer = ctx.session.updateShape(args.layer, patch);
      return { layer, appearance: shapeContentSummary(layer.content) };
    },
  },
  {
    name: 'shape.info',
    summary: 'Show a shape layer’s vector content and paint stacks',
    mutates: false,
    params: { layer: { type: 'string', positional: true, required: true } },
    async run(ctx, args) {
      const { findLayer } = await import('../../core/document.js');
      const { layer } = findLayer(ctx.session.doc, args.layer);
      return { layer, appearance: shapeContentSummary(layer.content) };
    },
  },
  {
    name: 'shape.export',
    summary: 'Export a shape layer as a standalone SVG file',
    mutates: false,
    params: {
      layer: { type: 'string', positional: true, required: true },
      out: { type: 'path', positional: true, required: true, desc: 'output .svg path' },
      scale: { type: 'number', default: 1, desc: 'output scale factor' },
    },
    examples: ['ashop shape.export logo out/logo.svg --scale 2'],
    async run(ctx, args) {
      return ctx.session.exportShapeSvg(args.layer, args.out, { scale: args.scale });
    },
  },
];
