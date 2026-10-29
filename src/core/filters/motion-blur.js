import { Raster } from '../raster.js';

/** Directional (motion) blur: average samples along a line. */
export default {
  name: 'motion-blur',
  label: 'Motion Blur',
  params: {
    length: { type: 'number', default: 24, desc: 'streak length in pixels' },
    angle: { type: 'number', default: 0, desc: 'direction in degrees (0 = horizontal)' },
    samples: { type: 'integer', default: 24, desc: 'sampling density' },
  },
  lengthParams: ['length'],
  apply(raster, { length = 24, angle = 0, samples = 24 } = {}) {
    const len = Math.max(0, Number(length));
    if (len < 1) return raster.clone();
    const rad = (angle * Math.PI) / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad);
    const n = Math.max(2, Math.min(256, Math.round(samples)));
    const out = new Raster(raster.width, raster.height);
    const w = raster.width, h = raster.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let i = 0; i < n; i++) {
          const t = (i / (n - 1) - 0.5) * len;
          const s = raster.sampleBilinear(x + t * dx, y + t * dy);
          r += s[0]; g += s[1]; b += s[2]; a += s[3];
        }
        const di = (y * w + x) * 4;
        out.data[di] = r / n;
        out.data[di + 1] = g / n;
        out.data[di + 2] = b / n;
        out.data[di + 3] = a / n;
      }
    }
    return out;
  },
};
