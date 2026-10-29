import { Raster, parseColor } from '../raster.js';
import { alphaPlane, colorizeAlpha, gaussianBlurAlpha } from '../effects.js';

/** Inner glow: glow only inside the layer silhouette. */
export default {
  name: 'inner-glow',
  label: 'Inner Glow',
  lengthParams: ['blur'],
  params: {
    color: { type: 'color', default: '#ffff80' },
    blur: { type: 'number', default: 12 },
    opacity: { type: 'number', default: 0.75 },
  },
  apply(content, { color = '#ffff80', blur = 12, opacity = 0.75 } = {}) {
    const cw = content.width, ch = content.height;
    const pad = Math.ceil(Math.max(0, blur) * 1.5) + 2;
    const alpha = alphaPlane(content);
    const inv = new Uint8ClampedArray(alpha.length);
    for (let i = 0; i < alpha.length; i++) inv[i] = 255 - alpha[i];
    const blurred = gaussianBlurAlpha(inv, cw, ch, Math.max(0.1, blur / 2));
    const band = new Uint8ClampedArray(alpha.length);
    for (let i = 0; i < alpha.length; i++) band[i] = (blurred[i] * alpha[i]) / 255;
    const glow = colorizeAlpha(band, cw, ch, parseColor(color));
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
    return { over: { raster, pad } };
  },
};
