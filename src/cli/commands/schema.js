/** Machine-readable command and operator catalogue. */

import { loadCommands, commandCatalog } from '../registry.js';
import { adjustmentCatalog } from '../../core/adjustments/index.js';
import { filterCatalog } from '../../core/filters/index.js';
import { styleCatalog } from '../../core/styles/index.js';
import { BLEND_MODE_NAMES } from '../../core/blend.js';
import { AshopError } from '../../core/errors.js';

const DOC_SHAPE = {
  format: 'ashop/1',
  document: {
    canvas: { width: 'int', height: 'int', background: 'colour | "transparent"' },
    colorSpace: 'srgb',
    layers: 'bottom -> top; groups nest children',
    selection: '{assetId,width,height} | null',
  },
  layer: {
    common: ['id', 'type', 'name', 'visible', 'opacity', 'fillOpacity', 'blend', 'clipTo', 'locked', 'transform', 'mask', 'styles'],
    transform: ['x', 'y', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY', 'skewX', 'skewY'],
    types: {
      raster: 'content {assetId,width,height,filters[]}',
      text: 'content {text,font,fontFile,size,color,align,lineHeight,letterSpacing,width,height,stroke,weight,italic,filters[]}',
      shape: 'content {width,height,shapes[],fill,stroke,filters[]}',
      adjustment: 'content {adjustment,params}',
      group: 'children[] (no transform)',
    },
  },
};

export default {
  name: 'schema',
  summary: 'Dump the full machine-readable command/operator schema',
  needsSession: false,
  mutates: false,
  params: {},
  async run() {
    const { list } = await loadCommands();
    return {
      tool: 'ashop',
      version: '0.1.0',
      document: DOC_SHAPE,
      commands: commandCatalog(list),
      blendModes: BLEND_MODE_NAMES,
      adjustments: adjustmentCatalog(),
      filters: filterCatalog(),
      styles: styleCatalog(),
    };
  },
};
