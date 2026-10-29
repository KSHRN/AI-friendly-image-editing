/** Adjustment layer commands (non-destructive). */

import { adjustmentCatalog } from '../../core/adjustments/index.js';
import { collectOperatorParams } from '../operator-params.js';

export default [
  {
    name: 'adjust.list',
    summary: 'List available adjustments and their parameters',
    needsSession: false,
    mutates: false,
    params: {},
    async run() {
      return { adjustments: adjustmentCatalog() };
    },
  },
  {
    name: 'adjust.add',
    aliases: ['adjust'],
    summary: 'Add a non-destructive adjustment layer (optionally clipped to a layer)',
    collectUnknown: true,
    params: {
      adjustment: { type: 'string', positional: true, required: true, desc: 'adjustment name, e.g. curves' },
      layer: { type: 'string', desc: 'alias for --clip-to' },
      'clip-to': { type: 'string', desc: 'restrict the adjustment to this layer' },
      target: { type: 'string', desc: 'alias for --clip-to' },
      name: { type: 'string' },
      'z-index': { type: 'int' },
      opacity: { type: 'number', default: 1 },
    },
    examples: [
      'ashop adjust.add curves --layer base --rgb "[[0,0],[128,150],[255,255]]"',
      'ashop adjust.add brightness-contrast --brightness 10 --contrast 15',
    ],
    async run(ctx, args) {
      const { getAdjustment } = await import('../../core/adjustments/index.js');
      const def = getAdjustment(args.adjustment);
      const params = collectOperatorParams(def, args.extra ?? {});
      const clipTo = args['clip-to'] ?? args.layer ?? args.target ?? null;
      const layer = ctx.session.addAdjustmentLayer({
        adjustment: args.adjustment,
        params,
        clipTo,
        name: args.name,
        zIndex: args['z-index'],
        opacity: args.opacity,
      });
      return { layer };
    },
  },
  {
    name: 'adjust.set',
    summary: 'Update an existing adjustment layer’s parameters',
    collectUnknown: true,
    params: {
      layer: { type: 'string', positional: true, required: true },
    },
    async run(ctx, args) {
      const { getAdjustment } = await import('../../core/adjustments/index.js');
      const { findLayer } = await import('../../core/document.js');
      const target = findLayer(ctx.session.doc, args.layer).layer;
      if (target.type !== 'adjustment') throw new (await import('../../core/errors.js')).AshopError('E_USAGE', 'layer is not an adjustment layer');
      const def = getAdjustment(target.content.adjustment);
      const params = collectOperatorParams(def, args.extra ?? {});
      const layer = ctx.session.setAdjustment(args.layer, params);
      return { layer: layer.id, params: layer.content.params };
    },
  },
];
