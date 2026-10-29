/** Explain a command, or an operator family, in machine-readable form. */

import { loadCommands, commandCatalog } from '../registry.js';
import { adjustmentCatalog } from '../../core/adjustments/index.js';
import { filterCatalog } from '../../core/filters/index.js';
import { styleCatalog } from '../../core/styles/index.js';
import { BLEND_MODE_NAMES } from '../../core/blend.js';
import { AshopError } from '../../core/errors.js';

export default {
  name: 'describe',
  aliases: ['info'],
  summary: 'Describe a command or operator family (adjustments, filters, styles, blends)',
  needsSession: false,
  mutates: false,
  params: {
    name: { type: 'string', positional: true, desc: 'command name or family' },
  },
  examples: ['ashop describe layer.import', 'ashop describe filters'],
  async run(ctx, args) {
    const { map, list } = await loadCommands();
    const name = args.name;
    if (!name) {
      return {
        commands: commandCatalog(list).map((c) => ({ name: c.name, summary: c.summary })),
        families: ['adjustments', 'filters', 'styles', 'blends', 'commands', 'document'],
      };
    }
    if (name === 'adjustments') return { adjustments: adjustmentCatalog() };
    if (name === 'filters') return { filters: filterCatalog() };
    if (name === 'styles') return { styles: styleCatalog() };
    if (name === 'blends') return { blendModes: BLEND_MODE_NAMES };
    if (name === 'commands') return { commands: commandCatalog(list) };
    if (name === 'document') {
      return {
        document: 'bottom-to-top layer array; content units are mapped to the canvas by each layer transform',
        layerTypes: ['raster', 'text', 'shape', 'adjustment', 'group'],
      };
    }
    const command = map.get(name);
    if (!command) {
      throw new AshopError('E_COMMAND_NOT_FOUND', `no command or family named "${name}"`, {
        hint: 'try `ashop describe commands` or `ashop help <command>`',
      });
    }
    return {
      name: command.name,
      summary: command.summary,
      params: command.params ?? {},
      examples: command.examples ?? [],
      mutates: command.mutates !== false,
      needsSession: command.needsSession !== false,
    };
  },
};
