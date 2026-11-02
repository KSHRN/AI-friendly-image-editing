/** Batch script runner. */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runOps } from '../../core/ops.js';
import { AshopError } from '../../core/errors.js';

export default {
  name: 'run',
  summary: 'Run a declarative ops JSON script (atomic, dry-run, variables)',
  params: {
    file: { type: 'path', positional: true, required: true, desc: 'ops JSON file' },
    atomic: { type: 'bool', default: false, desc: 'roll back everything if any step fails' },
    'dry-run': { type: 'bool', default: false, desc: 'validate the plan without changing the document' },
    fresh: { type: 'bool', default: false, desc: 'reset the session to an empty canvas first, so the script can be re-run' },
    commit: { type: 'bool', default: false, desc: 'create one commit after a successful run' },
    message: { type: 'string', short: 'm', desc: 'commit message for --commit' },
    vars: { type: 'json', desc: 'extra variables as JSON object, e.g. {"bg":"#ffffff"}' },
  },
  examples: [
    'ashop run ops/sku_batch.json --atomic --commit -m "sku batch"',
    'ashop run ops/sku_batch.json --dry-run',
    'ashop run ops/sticker.json --fresh --atomic',
  ],
  async run(ctx, args) {
    let plan;
    try {
      plan = JSON.parse(await readFile(path.resolve(args.file), 'utf8'));
    } catch (err) {
      throw new AshopError('E_USAGE', `cannot read ops file: ${args.file}`, { cause: err });
    }
    const result = await runOps(ctx.session, plan, {
      atomic: args.atomic,
      dryRun: args['dry-run'],
      fresh: args.fresh,
      commitMessage: args.commit ? (args.message ?? `run ${path.basename(args.file)}`) : null,
      extraVars: args.vars ?? {},
    });
    return { file: path.resolve(args.file), ...result };
  },
};
