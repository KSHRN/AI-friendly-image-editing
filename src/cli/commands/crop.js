/** Content-space layer crop. */

import { cropLayer } from '../../core/crop.js';
import { AshopError } from '../../core/errors.js';

export default {
  name: 'layer.crop',
  summary: 'Crop a raster layer to a rect in content space (reversible with --reset)',
  usage: 'ashop layer.crop <layer> --rect <x,y,w,h> [--keep-position] | ashop layer.crop <layer> --reset',
  params: {
    layer: { type: 'string', positional: true, required: true, desc: 'raster layer id or name' },
    rect: { type: 'rect', desc: 'crop box in content units, e.g. "0,0,400,300"' },
    'keep-position': {
      type: 'bool',
      default: false,
      desc: 'keep the cropped pixels at their current canvas position instead of putting the crop box at the layer origin',
    },
    reset: { type: 'bool', default: false, desc: 'restore the pre-crop image, size and mask' },
  },
  examples: [
    'ashop layer.crop base --rect "100,60,800,600"',
    'ashop layer.crop base --rect "0,0,512,512" --keep-position',
    'ashop layer.crop base --reset',
  ],
  async run(ctx, args) {
    if (args.reset && args.rect) {
      throw new AshopError('E_USAGE', 'pass either --rect or --reset, not both', {
        hint: '--reset restores the pre-crop image; drop --rect',
      });
    }
    return cropLayer(ctx.session, args.layer, args.rect, {
      reset: args.reset,
      keepPosition: args['keep-position'],
    });
  },
};
