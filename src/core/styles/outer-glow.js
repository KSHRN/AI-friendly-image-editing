import { Raster, parseColor } from '../raster.js';
import { alphaPlane, colorizeAlpha, gaussianBlurAlpha } from '../effects.js';

/** Outer glow: halo outside the silhouette, drawn underneath. */
export default {
  name: 'outer-glow',
  label: 'Outer Glow',
  lengthParams: ['blur'],
  params: {
    color: { type: 'color', default: '#ffffff' },
    blur: { type: 'number', default: 16 },
    opacity: { type: 'number', default: 0.7 },
  },
  apply(content, { color = '#ffffff', blur = 16, opacity = 0.7 } = {}) {
    const cw = content.width, ch = content.height;
    const pad = Math.ceil(Math.max(0, blur) * 1.5) + 2;
    const alpha = alphaPlane(content);
    const blurred = gaussianBlurAlpha(alpha, cw, ch, Math.max(0.1, blur / 2));
    const halo = new Uint8ClampedArray(alpha.length);
    for (let i = 0; i < alpha.length; i++) halo[i] = Math.max(0, blurred[i] - alpha[i]);
    const glow = colorizeAlpha(halo, cw, ch, parseColor(color));
    const op = Math.max(0, Math.min(1, opacity));
    const raster = new Raster(cw + pad * 2, ch + pad * 2);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = (y * cw + x) * 4;
        const sa = glow.data[si + 3] * op;
        if (sa <= 0) continue;
        const di = ((y + pad) * raster.width + (x + pad)) * 4;
        raster.data[di] = glow.data[si];
        raster.data[di + 1] = glow.data[si + 1];
        raster.data[di + 2] = glow.data[si + 2];
        raster.data[di + 3] = sa;
      }
    }
    return { under: { raster, pad } };
  },
};
