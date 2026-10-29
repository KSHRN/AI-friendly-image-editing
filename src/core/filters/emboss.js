import { Raster } from '../raster.js';

/** Emboss convolution with a light direction. */
export default {
  name: 'emboss',
  label: 'Emboss',
  params: {
    strength: { type: 'number', default: 1, desc: 'edge amplification' },
    angle: { type: 'number', default: 45, desc: 'light direction in degrees' },
  },
  apply(raster, { strength = 1, angle = 45 } = {}) {
    const a = (angle * Math.PI) / 180;
    const lx = Math.cos(a), ly = Math.sin(a);
    // Directional derivative kernel.
    const k = [0, 0, 0, -lx, 0, lx, -ly, ly, 0];
    const w = raster.width, h = raster.height;
    const out = new Raster(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let rr = 0, gg = 0, bb = 0, aa = 0, n = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            const weight = k[(ky + 1) * 3 + (kx + 1)];
            if (weight === 0) continue;
            const sx = Math.max(0, Math.min(w - 1, x + kx));
            const sy = Math.max(0, Math.min(h - 1, y + ky));
            const i = (sy * w + sx) * 4;
            rr += raster.data[i] * weight;
            gg += raster.data[i + 1] * weight;
            bb += raster.data[i + 2] * weight;
            aa += raster.data[i + 3] * weight;
            n += Math.abs(weight);
          }
        }
        const di = (y * w + x) * 4;
        const base = 128;
        out.data[di] = base + (rr / Math.max(1e-6, n)) * strength * 2;
        out.data[di + 1] = base + (gg / Math.max(1e-6, n)) * strength * 2;
        out.data[di + 2] = base + (bb / Math.max(1e-6, n)) * strength * 2;
        out.data[di + 3] = raster.data[di + 3] === 0 ? 0 : Math.abs(aa / Math.max(1e-6, n)) || 128;
      }
    }
    return out;
  },
};
