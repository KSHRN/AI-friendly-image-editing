/** Layer style commands. */

import { styleCatalog } from '../../core/styles/index.js';
import { collectOperatorParams } from '../operator-params.js';
import { findLayer } from '../../core/document.js';
import { AshopError } from '../../core/errors.js';

export default [
  {
    name: 'style.list',
    summary: 'List available layer styles',
    needsSession: false,
    mutates: false,
    params: {},
    async run() {
      return { styles: styleCatalog() };
    },
  },
  {
    name: 'style.add',
    aliases: ['style'],
    summary: 'Add a layer style (drop shadow, stroke, glow, bevel)',
    collectUnknown: true,
    params: {
      style: { type: 'string', positional: true, required: true, desc: 'style name, e.g. drop-shadow' },
      layer: { type: 'string', desc: 'layer id or name' },
      target: { type: 'string', desc: 'alias for --layer' },
    },
    examples: [
      'ashop style.add drop-shadow --layer base --color "#00000055" --offset-y 12 --blur 24',
      'ashop style.add stroke --layer logo --width 3 --color "#ffffff"',
    ],
    async run(ctx, args) {
      const { getStyle } = await import('../../core/styles/index.js');
      const def = getStyle(args.style);
      const params = collectOperatorParams(def, args.extra ?? {});
      const layerRef = args.layer ?? args.target;
      return { layer: ctx.session.addStyle(layerRef, args.style, params).id, style: args.style, params };
    },
  },
  {
    name: 'style.remove',
    summary: 'Remove a layer style by type or index',
    params: {
      layer: { type: 'string', required: true },
      type: { type: 'string' },
      index: { type: 'int' },
    },
    async run(ctx, args) {
      const layer = ctx.session.removeStyle(args.layer, { type: args.type, index: args.index });
      return { layer: layer.id, styles: layer.styles };
    },
  },
  {
    name: 'style.info',
    summary: 'List the styles on one layer',
    mutates: false,
    params: { layer: { type: 'string', required: true } },
    async run(ctx, args) {
      const node = findLayer(ctx.session.doc, args.layer);
      return { layer: node.layer.id, styles: node.layer.styles ?? [] };
    },
  },
];
