/** Layer tree commands. */

import { findLayer, listLayers } from '../../core/document.js';
import { BLEND_MODE_NAMES } from '../../core/blend.js';
import { AshopError } from '../../core/errors.js';

function view(layer) {
  return layer;
}

export default [
  {
    name: 'layer.list',
    summary: 'List layers bottom-to-top',
    mutates: false,
    params: {},
    async run(ctx) {
      return { layers: listLayers(ctx.session.doc) };
    },
  },
  {
    name: 'layer.import',
    aliases: ['import'],
    summary: 'Import an image file as a raster layer',
    params: {
      file: { type: 'path', positional: true, required: true, desc: 'image file (PNG/JPEG/WebP/GIF/TIFF/BMP)' },
      name: { type: 'string', desc: 'layer name (defaults to the file name)' },
      at: { type: 'point', desc: 'top-left position, e.g. "100,50"' },
      fit: { type: 'enum', values: ['none', 'contain', 'cover', 'stretch'], default: 'none' },
      align: { type: 'enum', values: ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'], default: 'center' },
      scale: { type: 'number', default: 1 },
      rotation: { type: 'number', default: 0 },
      'z-index': { type: 'int', desc: 'stacking order: higher sits above lower, equal z keeps insertion order (later on top)' },
      parent: { type: 'string', desc: 'group layer id' },
      opacity: { type: 'number', default: 1 },
      blend: { type: 'string', default: 'normal' },
    },
    examples: ['ashop layer import bg.png --name bg --z-index 0 --fit cover'],
    async run(ctx, args) {
      const layer = await ctx.session.importImage({
        file: args.file,
        name: args.name,
        at: args.at,
        fit: args.fit,
        align: args.align,
        scale: args.scale,
        rotation: args.rotation,
        zIndex: args['z-index'],
        parentId: args.parent,
        opacity: args.opacity,
        blend: args.blend,
      });
      return { layer: view(layer) };
    },
  },
  {
    name: 'layer.fill',
    summary: 'Add a fill layer covering the canvas (solid colour or gradient)',
    params: {
      color: { type: 'color', desc: 'fill colour' },
      fill: { type: 'paint', desc: 'fill colour or gradient (overrides --color)' },
      name: { type: 'string', default: 'Fill' },
      'z-index': { type: 'int' },
      opacity: { type: 'number', default: 1 },
      blend: { type: 'string', default: 'normal' },
    },
    examples: [
      'ashop layer.fill --color "#102030"',
      'ashop layer.fill --fill "linear-gradient(180deg,#ff0055,#0000ff)" --name backdrop',
    ],
    async run(ctx, args) {
      if (args.color === undefined && args.fill === undefined) {
        throw new AshopError('E_USAGE', 'layer.fill needs --color or --fill', {
          hint: 'e.g. --color "#102030" or --fill "linear-gradient(90deg,#f05,#05f)"',
        });
      }
      const layer = ctx.session.addFillLayer({
        color: args.color ?? '#ffffff',
        fill: args.fill,
        name: args.name,
        zIndex: args['z-index'],
        opacity: args.opacity,
        blend: args.blend,
      });
      return { layer: view(layer) };
    },
  },
  {
    name: 'layer.duplicate',
    summary: 'Duplicate a layer (and its group children)',
    params: {
      layer: { type: 'string', positional: true, required: true },
      name: { type: 'string' },
    },
    async run(ctx, args) {
      return { layer: view(ctx.session.duplicate(args.layer, { name: args.name })) };
    },
  },
  {
    name: 'layer.remove',
    aliases: ['layer.delete'],
    summary: 'Delete a layer',
    params: { layer: { type: 'string', positional: true, required: true } },
    async run(ctx, args) {
      return { removed: view(ctx.session.remove(args.layer)) };
    },
  },
  {
    name: 'layer.set',
    summary: 'Set visibility, opacity, blend mode, name, clipping or lock state',
    params: {
      layer: { type: 'string', positional: true, required: true },
      visible: { type: 'bool', desc: 'true/false' },
      opacity: { type: 'number', desc: '0..1' },
      'fill-opacity': { type: 'number', desc: '0..1, affects pixels but not styles' },
      blend: { type: 'enum', values: BLEND_MODE_NAMES, desc: 'blend mode' },
      name: { type: 'string' },
      'clip-to': { type: 'string', desc: 'clip this layer to the alpha of a layer below' },
      locked: { type: 'bool' },
    },
    examples: ['ashop layer set base --blend multiply --opacity 0.8'],
    async run(ctx, args) {
      const props = {};
      if (args.visible !== undefined) props.visible = args.visible;
      if (args.opacity !== undefined) props.opacity = args.opacity;
      if (args['fill-opacity'] !== undefined) props.fillOpacity = args['fill-opacity'];
      if (args.blend !== undefined) props.blend = args.blend;
      if (args.name !== undefined) props.name = args.name;
      if (args['clip-to'] !== undefined) props.clipTo = args['clip-to'];
      if (args.locked !== undefined) props.locked = args.locked;
      return { layer: view(ctx.session.setLayer(args.layer, props)) };
    },
  },
  {
    name: 'layer.move',
    summary: 'Move a layer to another index or parent group',
    params: {
      layer: { type: 'string', positional: true, required: true },
      'to-index': { type: 'int', desc: 'target index in its sibling list (0 = bottom)' },
      'to-parent': { type: 'string', desc: 'target group id; omit to keep the current parent' },
    },
    async run(ctx, args) {
      const layer = ctx.session.move(args.layer, {
        toIndex: args['to-index'],
        toParent: args['to-parent'],
      });
      return { layer: view(layer) };
    },
  },
  {
    name: 'layer.group',
    summary: 'Group several layers into a new group',
    params: {
      layers: { type: 'string', positional: true, variadic: true, required: true, desc: 'layer ids/names' },
      name: { type: 'string', default: 'Group' },
    },
    async run(ctx, args) {
      return { group: view(ctx.session.group(args.layers, { name: args.name })) };
    },
  },
  {
    name: 'layer.ungroup',
    summary: 'Dissolve a group, keeping its children',
    params: { layer: { type: 'string', positional: true, required: true } },
    async run(ctx, args) {
      const children = ctx.session.ungroup(args.layer);
      return { children: children.map(view) };
    },
  },
  {
    name: 'layer.merge-down',
    summary: 'Merge a layer into the one below (produces a raster layer)',
    params: { layer: { type: 'string', positional: true, required: true } },
    async run(ctx, args) {
      return { layer: view(await ctx.session.mergeDown(args.layer)) };
    },
  },
  {
    name: 'layer.transform',
    aliases: ['transform'],
    summary: 'Move / scale / rotate a layer',
    params: {
      layer: { type: 'string', positional: true, required: true },
      x: { type: 'number', desc: 'absolute x of the anchor' },
      y: { type: 'number' },
      dx: { type: 'number', desc: 'relative x shift' },
      dy: { type: 'number' },
      scale: { type: 'number', desc: 'uniform scale' },
      'scale-x': { type: 'number' },
      'scale-y': { type: 'number' },
      rotation: { type: 'number', desc: 'degrees clockwise' },
      'anchor-x': { type: 'number', desc: '0..1 of content width' },
      'anchor-y': { type: 'number', desc: '0..1 of content height' },
    },
    examples: ['ashop layer transform base --dx 20 --dy -10', 'ashop layer transform logo --scale 0.5 --rotation 15'],
    async run(ctx, args) {
      const layer = ctx.session.transform(args.layer, {
        x: args.x, y: args.y, dx: args.dx, dy: args.dy,
        scale: args.scale, scaleX: args['scale-x'], scaleY: args['scale-y'],
        rotation: args.rotation, anchorX: args['anchor-x'], anchorY: args['anchor-y'],
      });
      return { layer: view(layer) };
    },
  },
  {
    name: 'layer.info',
    summary: 'Show one layer in full',
    mutates: false,
    params: { layer: { type: 'string', positional: true, required: true } },
    async run(ctx, args) {
      const node = findLayer(ctx.session.doc, args.layer);
      return { layer: node.layer, parentId: node.parent?.id ?? null, index: node.index };
    },
  },
];
