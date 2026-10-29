/** Pixel / region / layer probes — the "eyes" for an agent without vision. */

import { pixelAt, regionStats, histogram, topColors, imageSummary } from '../../core/stats.js';
import { findLayer, contentSize } from '../../core/document.js';

async function sample(ctx, layerRef) {
  if (layerRef) {
    const { layer } = findLayer(ctx.session.doc, layerRef);
    return ctx.session.renderer.renderLayerIsolated(ctx.session.doc, layer, { scale: 1 });
  }
  return ctx.session.render({ scale: 1 });
}

export default [
  {
    name: 'inspect.pixel',
    summary: 'Read the RGBA value at one canvas coordinate',
    mutates: false,
    params: {
      at: { type: 'point', required: true, desc: '"x,y"' },
      layer: { type: 'string', desc: 'probe one layer instead of the composite' },
    },
    async run(ctx, args) {
      const raster = await sample(ctx, args.layer);
      return pixelAt(raster, Math.floor(args.at.x), Math.floor(args.at.y));
    },
  },
  {
    name: 'inspect.region',
    summary: 'Statistics for a canvas rectangle (mean/min/max/alpha coverage)',
    mutates: false,
    params: {
      rect: { type: 'rect', required: true, desc: '"x,y,w,h"' },
      layer: { type: 'string' },
      'alpha-threshold': { type: 'int', default: 0 },
    },
    async run(ctx, args) {
      const raster = await sample(ctx, args.layer);
      return regionStats(raster, args.rect, { alphaThreshold: args['alpha-threshold'] });
    },
  },
  {
    name: 'inspect.layer',
    summary: 'Render one layer in isolation and report bounds, coverage and hash',
    mutates: false,
    params: { layer: { type: 'string', positional: true, required: true } },
    async run(ctx, args) {
      const node = findLayer(ctx.session.doc, args.layer);
      const layer = node.layer;
      if (layer.type === 'group' || layer.type === 'adjustment') {
        return { layer: layer.id, type: layer.type, note: 'no standalone raster for this layer type' };
      }
      const raster = await ctx.session.renderer.renderLayerIsolated(ctx.session.doc, layer, { scale: 1 });
      const summary = imageSummary(raster);
      const size = contentSize(layer);
      return {
        layer: layer.id,
        name: layer.name,
        type: layer.type,
        contentSize: size,
        transform: layer.transform,
        isolated: summary,
        opaqueBounds: raster.alphaBounds(),
      };
    },
  },
  {
    name: 'inspect.histogram',
    summary: 'Channel histograms of the composite or of one layer',
    mutates: false,
    params: {
      layer: { type: 'string' },
      bins: { type: 'int', default: 256 },
    },
    async run(ctx, args) {
      const raster = await sample(ctx, args.layer);
      return histogram(raster, { bins: args.bins });
    },
  },
  {
    name: 'inspect.colors',
    summary: 'Most common colours in the composite or in one layer',
    mutates: false,
    params: {
      layer: { type: 'string' },
      limit: { type: 'int', default: 8 },
      quantize: { type: 'int', default: 16 },
    },
    async run(ctx, args) {
      const raster = await sample(ctx, args.layer);
      return { colors: topColors(raster, { limit: args.limit, quantize: args.quantize }) };
    },
  },
  {
    name: 'inspect.image',
    summary: 'Overall summary of the composite or of one layer',
    mutates: false,
    params: { layer: { type: 'string' } },
    async run(ctx, args) {
      const raster = await sample(ctx, args.layer);
      return imageSummary(raster);
    },
  },
  {
    name: 'inspect.selection',
    summary: 'Bounds and coverage of the active selection',
    mutates: false,
    params: {},
    async run(ctx) {
      const stats = await ctx.session.selectionStats();
      return { selection: stats };
    },
  },
];
