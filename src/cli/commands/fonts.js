/** Font discovery. */

import { listFonts, buildFontIndex, fontDirs } from '../../core/fonts.js';

export default [
  {
    name: 'fonts.list',
    summary: 'List installed font families usable by text layers',
    needsSession: false,
    mutates: false,
    params: {
      filter: { type: 'string', desc: 'substring match on the family name' },
      limit: { type: 'int', default: 200 },
    },
    async run(ctx, args) {
      const fonts = listFonts({ filter: args.filter, limit: args.limit });
      return { count: fonts.length, fonts };
    },
  },
  {
    name: 'fonts.info',
    summary: 'Show how many font files were indexed and where they live',
    needsSession: false,
    mutates: false,
    params: {},
    async run() {
      const index = buildFontIndex();
      return {
        dirs: fontDirs(),
        faces: index.faces.length,
        families: new Set(index.faces.map((f) => f.family)).size,
        builtAt: index.builtAt,
        cache: `${index.signature}`,
      };
    },
  },
];
