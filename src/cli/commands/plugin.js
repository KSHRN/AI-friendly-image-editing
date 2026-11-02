/** Plugin registry commands. */

import { listPlugins, addPlugin, removePlugin, runPlugin } from '../../core/plugin.js';
import { parseJson } from '../../core/units.js';

export default [
  {
    name: 'plugin.list',
    summary: 'List external plugins registered on this project',
    mutates: false,
    params: {},
    async run(ctx) {
      return { plugins: listPlugins(ctx.session.doc) };
    },
  },
  {
    name: 'plugin.add',
    summary: 'Register an external plugin executable',
    params: {
      name: { type: 'string', required: true },
      command: { type: 'string', required: true, desc: 'executable, e.g. node or python' },
      args: { type: 'json', default: [], desc: 'JSON array of arguments' },
      description: { type: 'string', default: '' },
      cwd: { type: 'path' },
    },
    examples: ['ashop plugin.add --name sepia --command node --args "[\'examples/plugins/sepia.mjs\']"'],
    async run(ctx, args) {
      const entry = addPlugin(ctx.session.doc, {
        name: args.name,
        command: args.command,
        args: args.args ?? [],
        description: args.description,
        cwd: args.cwd,
      });
      ctx.session.markDirty();
      return entry;
    },
  },
  {
    name: 'plugin.remove',
    summary: 'Unregister a plugin',
    params: { name: { type: 'string', required: true } },
    async run(ctx, args) {
      const out = removePlugin(ctx.session.doc, args.name);
      ctx.session.markDirty();
      return out;
    },
  },
  {
    name: 'plugin.run',
    summary: 'Run a plugin on a layer (exchanges raw RGBA over stdin/stdout files)',
    params: {
      name: { type: 'string', required: true },
      layer: { type: 'string', positional: true, required: true, desc: 'layer id or name (positional; --layer also accepted)' },
      params: { type: 'json', default: {}, desc: 'plugin-specific parameters' },
    },
    examples: ['ashop plugin.run --name sepia base --params "{\\"amount\\":0.8}"'],
    async run(ctx, args) {
      const result = await runPlugin(ctx.session, args.name, { layer: args.layer, params: args.params });
      return {
        layer: result.layer.id,
        convertedFrom: result.convertedFrom,
        meta: result.meta,
      };
    },
  },
];
