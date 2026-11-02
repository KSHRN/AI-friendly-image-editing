import { parseColor } from '../raster.js';
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
    const pw = cw + pad * 2;
    const ph = ch + pad * 2;
    // Blur a padded plane: the halo has to be able to live outside the box.
    const src = alphaPlane(content);
    const alpha = new Uint8ClampedArray(pw * ph);
    for (let y = 0; y < ch; y++) alpha.set(src.subarray(y * cw, (y + 1) * cw), (y + pad) * pw + pad);

    const blurred = gaussianBlurAlpha(alpha, pw, ph, Math.max(0.1, blur / 2));
    const halo = new Uint8ClampedArray(alpha.length);
    for (let i = 0; i < alpha.length; i++) halo[i] = Math.max(0, blurred[i] - alpha[i]);
    const raster = colorizeAlpha(halo, pw, ph, parseColor(color));
    const op = Math.max(0, Math.min(1, opacity));
    if (op < 1) {
      for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = raster.data[i] * op;
    }
    return { under: { raster, pad } };
  },
};

