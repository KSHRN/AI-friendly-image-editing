import { Raster, parseColor } from '../raster.js';
import { alphaPlane, colorizeAlpha, dilateAlpha, gaussianBlurAlpha } from '../effects.js';

/**
 * Drop shadow.
 *
 * Effects are returned as a *padded* raster: `pad` is how many pixels of
 * margin the raster adds on each side, so an offset shadow never gets clipped.
 */
export default {
  name: 'drop-shadow',
  label: 'Drop Shadow',
  lengthParams: ['offsetX', 'offsetY', 'blur', 'spread'],
  params: {
    color: { type: 'color', default: '#00000080' },
    offsetX: { type: 'number', default: 0 },
    offsetY: { type: 'number', default: 12 },
    blur: { type: 'number', default: 24, desc: 'blur radius in px' },
    spread: { type: 'number', default: 0, desc: 'dilation in px before blur' },
    opacity: { type: 'number', default: 1, desc: '0..1' },
  },
  apply(content, { color = '#00000080', offsetX = 0, offsetY = 12, blur = 24, spread = 0, opacity = 1 } = {}) {
    const pad = Math.ceil(Math.max(0, spread) + Math.max(0, blur) + Math.max(Math.abs(offsetX), Math.abs(offsetY))) + 2;
    const cw = content.width, ch = content.height;
    let alpha = alphaPlane(content);
    if (spread > 0) alpha = dilateAlpha(alpha, cw, ch, spread);
    if (blur > 0) alpha = gaussianBlurAlpha(alpha, cw, ch, blur / 2);
    const rgba = parseColor(color);
    const shadow = colorizeAlpha(alpha, cw, ch, rgba);
    const op = Math.max(0, Math.min(1, opacity));
    const raster = new Raster(cw + pad * 2, ch + pad * 2);
    const shiftX = pad + Math.round(offsetX);
    const shiftY = pad + Math.round(offsetY);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = (y * cw + x) * 4;
        const sa = shadow.data[si + 3] * op;
        if (sa <= 0) continue;
        const di = ((y + shiftY) * raster.width + (x + shiftX)) * 4;
        raster.data[di] = shadow.data[si];
        raster.data[di + 1] = shadow.data[si + 1];
        raster.data[di + 2] = shadow.data[si + 2];
        raster.data[di + 3] = sa;
      }
    }
    return { under: { raster, pad } };
  },
};
