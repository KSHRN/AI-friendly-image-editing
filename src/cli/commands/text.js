/** Text layer commands. */

export default [
  {
    name: 'text.add',
    aliases: ['text'],
    summary: 'Add a text layer (vector outlines, deterministic layout)',
    params: {
      content: { type: 'string', required: true, desc: 'text contents; use \\n for newlines' },
      font: { type: 'string', default: 'Segoe UI', desc: 'font family or path' },
      'font-file': { type: 'path', desc: 'explicit font file' },
      size: { type: 'number', default: 72 },
      color: { type: 'color', default: '#000000' },
      pos: { type: 'point', default: { x: 0, y: 0 }, desc: 'top-left position' },
      width: { type: 'number', default: 0, desc: 'wrap width in px (0 = no wrap)' },
      align: { type: 'enum', values: ['left', 'center', 'right'], default: 'left' },
      'line-height': { type: 'number', default: 1.2 },
      'letter-spacing': { type: 'number', default: 0 },
      weight: { type: 'int', default: 400 },
      italic: { type: 'bool', default: false },
      'stroke-color': { type: 'color' },
      'stroke-width': { type: 'number', default: 0 },
      name: { type: 'string' },
      'z-index': { type: 'int' },
      opacity: { type: 'number', default: 1 },
    },
    examples: ['ashop text.add --content "SUMMER" --font "Arial" --size 72 --color "#ff0055" --pos "600,100"'],
    async run(ctx, args) {
      const stroke = args['stroke-width'] > 0
        ? { color: args['stroke-color'] ?? '#000000', width: args['stroke-width'] }
        : null;
      const layer = ctx.session.addTextLayer({
        text: args.content,
        font: args.font,
        fontFile: args['font-file'],
        size: args.size,
        color: args.color,
        x: args.pos.x,
        y: args.pos.y,
        width: args.width,
        align: args.align,
        lineHeight: args['line-height'],
        letterSpacing: args['letter-spacing'],
        weight: args.weight,
        italic: args.italic,
        stroke,
        name: args.name,
        zIndex: args['z-index'],
        opacity: args.opacity,
      });
      return { layer };
    },
  },
  {
    name: 'text.set',
    summary: 'Edit a text layer (re-measures automatically)',
    params: {
      layer: { type: 'string', positional: true, required: true },
      content: { type: 'string' },
      font: { type: 'string' },
      size: { type: 'number' },
      color: { type: 'color' },
      width: { type: 'number' },
      align: { type: 'enum', values: ['left', 'center', 'right'] },
      'line-height': { type: 'number' },
      'letter-spacing': { type: 'number' },
      weight: { type: 'int' },
    },
    async run(ctx, args) {
      const patch = {};
      if (args.content !== undefined) patch.text = args.content;
      if (args.font !== undefined) patch.font = args.font;
      if (args.size !== undefined) patch.size = args.size;
      if (args.color !== undefined) patch.color = args.color;
      if (args.width !== undefined) patch.width = args.width;
      if (args.align !== undefined) patch.align = args.align;
      if (args['line-height'] !== undefined) patch.lineHeight = args['line-height'];
      if (args['letter-spacing'] !== undefined) patch.letterSpacing = args['letter-spacing'];
      if (args.weight !== undefined) patch.weight = args.weight;
      return { layer: ctx.session.setText(args.layer, patch) };
    },
  },
  {
    name: 'text.measure',
    summary: 'Measure text without creating a layer',
    needsSession: false,
    mutates: false,
    params: {
      content: { type: 'string', required: true },
      font: { type: 'string', default: 'Segoe UI' },
      'font-file': { type: 'path' },
      size: { type: 'number', default: 72 },
      width: { type: 'number', default: 0 },
      'line-height': { type: 'number', default: 1.2 },
      'letter-spacing': { type: 'number', default: 0 },
      weight: { type: 'int', default: 400 },
    },
    async run(ctx, args) {
      const { measureText } = await import('../../core/text.js');
      return measureText({
        text: args.content,
        font: args.font,
        fontFile: args['font-file'],
        size: args.size,
        width: args.width,
        lineHeight: args['line-height'],
        letterSpacing: args['letter-spacing'],
        weight: args.weight,
      });
    },
  },
];
