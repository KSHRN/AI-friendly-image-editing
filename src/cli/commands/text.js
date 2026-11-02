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
      fill: { type: 'paint', desc: 'fill colour or gradient (overrides --color)' },
      pos: { type: 'point', default: { x: 0, y: 0 }, desc: 'top-left position' },
      width: { type: 'number', default: 0, desc: 'wrap width in px (0 = no wrap)' },
      align: { type: 'enum', values: ['left', 'center', 'right'], default: 'left' },
      'line-height': { type: 'number', default: 1.2 },
      'letter-spacing': { type: 'number', default: 0 },
      weight: { type: 'int', default: 400 },
      italic: { type: 'bool', default: false },
      'stroke-color': { type: 'paint' },
      'stroke-width': { type: 'number', default: 0 },
      'stroke-linecap': { type: 'enum', values: ['butt', 'round', 'square'], default: 'round' },
      'stroke-linejoin': { type: 'enum', values: ['miter', 'round', 'bevel'], default: 'round' },
      'stroke-dash': { type: 'numberList' },
      name: { type: 'string' },
      'z-index': { type: 'int' },
      opacity: { type: 'number', default: 1 },
    },
    examples: [
      'ashop text.add --content "SUMMER" --font "Arial" --size 72 --color "#ff0055" --pos "600,100"',
      'ashop text.add --content "GRADIENT" --size 96 --fill "linear-gradient(90deg,#ff0055,#0000ff)" --pos "120,120"',
    ],
    async run(ctx, args) {
      const stroke = args['stroke-width'] > 0
        ? {
          color: args['stroke-color'] ?? '#000000',
          width: args['stroke-width'],
          lineCap: args['stroke-linecap'],
          lineJoin: args['stroke-linejoin'],
          dash: args['stroke-dash'],
        }
        : null;
      const layer = ctx.session.addTextLayer({
        text: args.content,
        font: args.font,
        fontFile: args['font-file'],
        size: args.size,
        color: args.color,
        fill: args.fill,
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
      fill: { type: 'paint', desc: 'fill colour or gradient (overrides --color)' },
      width: { type: 'number' },
      align: { type: 'enum', values: ['left', 'center', 'right'] },
      'line-height': { type: 'number' },
      'letter-spacing': { type: 'number' },
      weight: { type: 'int' },
      'stroke-color': { type: 'paint' },
      'stroke-width': { type: 'number' },
      'stroke-linecap': { type: 'enum', values: ['butt', 'round', 'square'] },
      'stroke-linejoin': { type: 'enum', values: ['miter', 'round', 'bevel'] },
      'stroke-dash': { type: 'numberList' },
    },
    async run(ctx, args) {
      const patch = {};
      if (args.content !== undefined) patch.text = args.content;
      if (args.font !== undefined) patch.font = args.font;
      if (args.size !== undefined) patch.size = args.size;
      if (args.color !== undefined) patch.color = args.color;
      if (args.fill !== undefined) patch.fill = args.fill;
      if (args.width !== undefined) patch.width = args.width;
      if (args.align !== undefined) patch.align = args.align;
      if (args['line-height'] !== undefined) patch.lineHeight = args['line-height'];
      if (args['letter-spacing'] !== undefined) patch.letterSpacing = args['letter-spacing'];
      if (args.weight !== undefined) patch.weight = args.weight;
      if (args['stroke-color'] !== undefined || args['stroke-width'] !== undefined || args['stroke-dash'] !== undefined) {
        patch.stroke = {
          color: args['stroke-color'] ?? '#000000',
          width: args['stroke-width'] ?? 2,
          lineCap: args['stroke-linecap'] ?? 'round',
          lineJoin: args['stroke-linejoin'] ?? 'round',
          dash: args['stroke-dash'],
        };
      }
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
