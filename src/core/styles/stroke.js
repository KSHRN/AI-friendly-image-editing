import { Raster, parseColor } from '../raster.js';
import { alphaPlane, colorizeAlpha, dilateAlpha, erodeAlpha } from '../effects.js';

/** Stroke around the layer's alpha, inside / outside / centred. */
export default {
  name: 'stroke',
  label: 'Stroke',
  lengthParams: ['width'],
  params: {
    color: { type: 'color', default: '#ffffff' },
    width: { type: 'number', default: 4 },
    position: { type: 'string', default: 'outside', desc: 'outside | inside | center' },
    opacity: { type: 'number', default: 1 },
  },
  apply(content, { color = '#ffffff', width = 4, position = 'outside', opacity = 1 } = {}) {
    const w = Math.max(0, Number(width));
    if (w <= 0) return {};
    const pad = Math.ceil(w) + 2;
    const cw = content.width, ch = content.height;
    const alpha = alphaPlane(content);
    let band;
    if (position === 'inside') {
      const eroded = erodeAlpha(alpha, cw, ch, w);
      band = new Uint8ClampedArray(alpha.length);
      for (let i = 0; i < alpha.length; i++) band[i] = Math.max(0, alpha[i] - eroded[i]);
    } else if (position === 'center') {
      const grown = dilateAlpha(alpha, cw, ch, w / 2);
      const eroded = erodeAlpha(alpha, cw, ch, w / 2);
      band = new Uint8ClampedArray(alpha.length);
      for (let i = 0; i < alpha.length; i++) band[i] = Math.max(0, grown[i] - eroded[i]);
    } else {
      const grown = dilateAlpha(alpha, cw, ch, w);
      band = new Uint8ClampedArray(alpha.length);
      for (let i = 0; i < alpha.length; i++) band[i] = Math.max(0, grown[i] - alpha[i]);
    }
    const stroke = colorizeAlpha(band, cw, ch, parseColor(color));
    const op = Math.max(0, Math.min(1, opacity));
    const raster = new Raster(cw + pad * 2, ch + pad * 2);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = (y * cw + x) * 4;
        const sa = stroke.data[si + 3] * op;
        if (sa <= 0) continue;
        const di = ((y + pad) * raster.width + (x + pad)) * 4;
        raster.data[di] = stroke.data[si];
        raster.data[di + 1] = stroke.data[si + 1];
        raster.data[di + 2] = stroke.data[si + 2];
        raster.data[di + 3] = sa;
      }
    }
    return { over: { raster, pad } };
  },
};
