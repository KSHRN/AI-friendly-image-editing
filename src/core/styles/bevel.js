import { Raster, parseColor } from '../raster.js';
import { alphaPlane, gaussianBlurAlpha } from '../effects.js';

/**
 * Bevel & Emboss (simple).
 *
 * A blurred silhouette is treated as a height field; its screen-space
 * gradient is lit from `angle`, producing highlight and shadow bands inside
 * the layer.
 */
export default {
  name: 'bevel',
  label: 'Bevel & Emboss',
  lengthParams: ['size'],
  params: {
    size: { type: 'number', default: 8 },
    depth: { type: 'number', default: 1 },
    angle: { type: 'number', default: 120 },
    highlight: { type: 'color', default: '#ffffff' },
    shadow: { type: 'color', default: '#000000' },
    opacity: { type: 'number', default: 0.7 },
  },
  apply(content, { size = 8, depth = 1, angle = 120, highlight = '#ffffff', shadow = '#000000', opacity = 0.7 } = {}) {
    const cw = content.width, ch = content.height;
    const blur = Math.max(0.5, size / 2);
    const pad = Math.ceil(size * 1.5) + 2;
    const alpha = alphaPlane(content);
    const height = gaussianBlurAlpha(alpha, cw, ch, blur);
    const light = (angle * Math.PI) / 180;
    const lx = Math.cos(light), ly = -Math.sin(light);
    const hi = parseColor(highlight);
    const sh = parseColor(shadow);
    const raster = new Raster(cw + pad * 2, ch + pad * 2);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        const a = alpha[i];
        if (a === 0) continue;
        const hL = height[y * cw + Math.max(0, x - 1)];
        const hR = height[y * cw + Math.min(cw - 1, x + 1)];
        const hU = height[Math.max(0, y - 1) * cw + x];
        const hD = height[Math.min(ch - 1, y + 1) * cw + x];
        const gx = (hR - hL) / 255;
        const gy = (hD - hU) / 255;
        const lit = gx * lx + gy * ly;
        const strength = Math.abs(lit) * depth * opacity;
        if (strength < 0.002) continue;
        const color = lit > 0 ? hi : sh;
        const di = ((y + pad) * raster.width + (x + pad)) * 4;
        raster.data[di] = color[0];
        raster.data[di + 1] = color[1];
        raster.data[di + 2] = color[2];
        raster.data[di + 3] = Math.min(255, strength * 255) * (a / 255);
      }
    }
    return { over: { raster, pad } };
  },
};
