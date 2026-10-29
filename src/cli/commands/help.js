/** `ashop help` as a proper command (the flag form is handled in args.js). */

import { loadCommands } from '../registry.js';
import { helpForAll, helpForCommand } from '../args.js';
import { AshopError } from '../../core/errors.js';

export default {
  name: 'help',
  summary: 'List commands or show help for one command',
  needsSession: false,
  mutates: false,
  outputText: true,
  params: {
    command: { type: 'string', positional: true, desc: 'command name' },
  },
  async run(ctx, args) {
    const { map, list } = await loadCommands();
    if (!args.command) return helpForAll(list);
    const cmd = map.get(args.command);
    if (!cmd) throw new AshopError('E_COMMAND_NOT_FOUND', `unknown command: ${args.command}`, { hint: 'run `ashop help`' });
    return helpForCommand(cmd);
  },
};
