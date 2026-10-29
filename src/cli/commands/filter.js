/** Filter commands. */

import { filterCatalog } from '../../core/filters/index.js';
import { collectOperatorParams } from '../operator-params.js';

export default [
  {
    name: 'filter.list',
    summary: 'List available filters and their parameters',
    needsSession: false,
    mutates: false,
    params: {},
    async run() {
      return { filters: filterCatalog() };
    },
  },
  {
    name: 'filter.add',
    aliases: ['filter'],
    summary: 'Add a filter to a layer (stackable, applied in content space)',
    collectUnknown: true,
    params: {
      filter: { type: 'string', positional: true, required: true, desc: 'filter name, e.g. gaussian-blur' },
      layer: { type: 'string', required: true },
    },
    examples: [
      'ashop filter.add gaussian-blur --layer base --radius 6',
      'ashop filter.add noise --layer base --amount 10 --seed 7',
    ],
    async run(ctx, args) {
      const { getFilter } = await import('../../core/filters/index.js');
      const def = getFilter(args.filter);
      const params = collectOperatorParams(def, args.extra ?? {});
      const layer = ctx.session.useFilter(args.layer, args.filter, params);
      return { layer: layer.id, filter: args.filter, params, stack: layer.content.filters };
    },
  },
  {
    name: 'filter.clear',
    summary: 'Remove all filters from a layer',
    params: { layer: { type: 'string', required: true } },
    async run(ctx, args) {
      const layer = ctx.session.clearFilters(args.layer);
      return { layer: layer.id, filters: [] };
    },
  },
];
