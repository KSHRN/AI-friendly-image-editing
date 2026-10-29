/** Selection commands. */

const MODES = ['replace', 'add', 'subtract', 'intersect'];

export default [
  {
    name: 'select.rect',
    summary: 'Select a rectangle (canvas space)',
    params: {
      rect: { type: 'rect', required: true, desc: '"x,y,w,h"' },
      mode: { type: 'enum', values: MODES, default: 'replace' },
      feather: { type: 'number', default: 0 },
    },
    async run(ctx, args) {
      const mask = await ctx.session.selectShape('rect', args.rect, { mode: args.mode, feather: args.feather });
      return { selection: await ctx.session.selectionStats(), size: { width: mask.width, height: mask.height } };
    },
  },
  {
    name: 'select.ellipse',
    summary: 'Select an ellipse',
    params: {
      ellipse: { type: 'numberList', required: true, desc: '"cx,cy,rx,ry[,rotation]"' },
      mode: { type: 'enum', values: MODES, default: 'replace' },
      feather: { type: 'number', default: 0 },
    },
    async run(ctx, args) {
      const [cx, cy, rx, ry, rotation = 0] = args.ellipse;
      await ctx.session.selectShape('ellipse', { cx, cy, rx, ry, rotation }, { mode: args.mode, feather: args.feather });
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.polygon',
    summary: 'Select a polygon',
    params: {
      polygon: { type: 'polygon', required: true, desc: '"x1,y1 x2,y2 ..."' },
      mode: { type: 'enum', values: MODES, default: 'replace' },
      feather: { type: 'number', default: 0 },
      'fill-rule': { type: 'enum', values: ['nonzero', 'evenodd'], default: 'nonzero' },
    },
    async run(ctx, args) {
      await ctx.session.selectShape('polygon', { points: args.polygon, fillRule: args['fill-rule'] }, { mode: args.mode, feather: args.feather });
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.path',
    summary: 'Select a region from SVG path data',
    params: {
      'svg-path': { type: 'string', required: true, desc: 'SVG path d, e.g. "M10 10 H90 V90 Z"' },
      mode: { type: 'enum', values: MODES, default: 'replace' },
      feather: { type: 'number', default: 0 },
      'fill-rule': { type: 'enum', values: ['nonzero', 'evenodd'], default: 'nonzero' },
    },
    async run(ctx, args) {
      await ctx.session.selectShape('path', { d: args['svg-path'], fillRule: args['fill-rule'] }, { mode: args.mode, feather: args.feather });
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.color',
    summary: 'Select by colour similarity (like Photoshop’s colour range)',
    params: {
      color: { type: 'color', required: true },
      tolerance: { type: 'number', default: 20, desc: '0..255 euclidean RGB distance' },
      metric: { type: 'enum', values: ['rgb', 'luma'], default: 'rgb' },
      layer: { type: 'string', desc: 'sample this layer instead of the composited canvas' },
      contiguous: { type: 'bool', default: false, desc: 'only the connected region around --at' },
      at: { type: 'point', desc: 'seed point for contiguous mode' },
      mode: { type: 'enum', values: MODES, default: 'replace' },
      feather: { type: 'number', default: 0 },
    },
    examples: ['ashop select color --color "#f2f2f2" --tolerance 12', 'ashop select color --color "#ffffff" --at "600,40" --contiguous --tolerance 24'],
    async run(ctx, args) {
      await ctx.session.selectColor({
        color: args.color,
        tolerance: args.tolerance,
        metric: args.metric,
        layer: args.layer,
        contiguous: args.contiguous,
        at: args.at,
        mode: args.mode,
        feather: args.feather,
      });
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.luminance',
    summary: 'Select by luminance threshold',
    params: {
      threshold: { type: 'number', default: 128 },
      softness: { type: 'number', default: 0 },
      layer: { type: 'string' },
      mode: { type: 'enum', values: MODES, default: 'replace' },
      feather: { type: 'number', default: 0 },
    },
    async run(ctx, args) {
      await ctx.session.selectLuminance(args);
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.alpha',
    summary: 'Select by the alpha channel of a layer or of the composite',
    params: {
      threshold: { type: 'number', default: 1 },
      softness: { type: 'number', default: 0 },
      layer: { type: 'string' },
      mode: { type: 'enum', values: MODES, default: 'replace' },
      feather: { type: 'number', default: 0 },
    },
    async run(ctx, args) {
      await ctx.session.selectAlpha(args);
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.all',
    summary: 'Select the whole canvas',
    params: {},
    async run(ctx) {
      await ctx.session.selectAll();
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.none',
    summary: 'Clear the selection',
    params: {},
    async run(ctx) {
      await ctx.session.clearSelection();
      return { selection: null };
    },
  },
  {
    name: 'select.invert',
    summary: 'Invert the current selection',
    params: {},
    async run(ctx) {
      await ctx.session.invertSelection();
      return { selection: await ctx.session.selectionStats() };
    },
  },
  {
    name: 'select.modify',
    summary: 'Grow / shrink / feather / border the current selection',
    params: {
      grow: { type: 'number', default: 0 },
      shrink: { type: 'number', default: 0 },
      feather: { type: 'number', default: 0 },
      border: { type: 'number', default: 0 },
    },
    async run(ctx, args) {
      await ctx.session.modifySelection(args);
      return { selection: await ctx.session.selectionStats() };
    },
  },
];
