/** Layer mask commands. */

export default [
  {
    name: 'mask.from-selection',
    summary: 'Turn the current selection into a layer mask',
    params: {
      layer: { type: 'string', positional: true, required: true, desc: 'layer id or name (positional; --layer also accepted)' },
      feather: { type: 'number', default: 0 },
      invert: { type: 'bool', default: false },
    },
    examples: ['ashop mask from-selection base --feather 1'],
    async run(ctx, args) {
      const { layer, mask } = await ctx.session.maskFromSelection(args.layer, { feather: args.feather, invert: args.invert });
      return { layer: layer.id, mask: { width: mask.width, height: mask.height, inverted: layer.mask.inverted } };
    },
  },
  {
    name: 'mask.modify',
    summary: 'Feather, grow, shrink, border or invert a layer mask',
    params: {
      layer: { type: 'string', positional: true, required: true, desc: 'layer id or name (positional; --layer also accepted)' },
      feather: { type: 'number', default: 0 },
      grow: { type: 'number', default: 0 },
      shrink: { type: 'number', default: 0 },
      border: { type: 'number', default: 0 },
      invert: { type: 'bool', default: false },
    },
    async run(ctx, args) {
      const { layer, mask } = await ctx.session.maskModify(args.layer, args);
      return { layer: layer.id, mask: { width: mask.width, height: mask.height } };
    },
  },
  {
    name: 'mask.apply',
    summary: 'Bake a raster layer mask into its pixels and remove the mask',
    params: { layer: { type: 'string', positional: true, required: true, desc: 'layer id or name (positional; --layer also accepted)' } },
    async run(ctx, args) {
      const layer = await ctx.session.maskApply(args.layer);
      return { layer: layer.id, maskRemoved: true };
    },
  },
  {
    name: 'mask.remove',
    summary: 'Remove a layer mask',
    params: { layer: { type: 'string', positional: true, required: true, desc: 'layer id or name (positional; --layer also accepted)' } },
    async run(ctx, args) {
      const layer = await ctx.session.maskRemove(args.layer);
      return { layer: layer.id, mask: null };
    },
  },
  {
    name: 'mask.export',
    summary: 'Export a layer mask as a grayscale PNG',
    mutates: false,
    params: {
      layer: { type: 'string', positional: true, required: true, desc: 'layer id or name (positional; --layer also accepted)' },
      out: { type: 'path', required: true, desc: 'output PNG path' },
    },
    async run(ctx, args) {
      return ctx.session.maskExport(args.layer, args.out);
    },
  },
];
