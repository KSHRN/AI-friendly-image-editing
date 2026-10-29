import { Raster } from '../raster.js';

export default {
  name: 'pixelate',
  label: 'Pixelate',
  params: { size: { type: 'integer', default: 8, desc: 'block size in pixels' } },
  lengthParams: ['size'],
  apply(raster, { size = 8 } = {}) {
    const n = Math.max(1, Math.round(Number(size)));
    if (n === 1) return raster.clone();
    const out = raster.clone();
    const w = raster.width, h = raster.height;
    for (let by = 0; by < h; by += n) {
      for (let bx = 0; bx < w; bx += n) {
        let r = 0, g = 0, b = 0, a = 0, count = 0;
        for (let y = by; y < Math.min(h, by + n); y++) {
          for (let x = bx; x < Math.min(w, bx + n); x++) {
            const i = (y * w + x) * 4;
            r += raster.data[i]; g += raster.data[i + 1]; b += raster.data[i + 2]; a += raster.data[i + 3];
            count++;
          }
        }
        r /= count; g /= count; b /= count; a /= count;
        for (let y = by; y < Math.min(h, by + n); y++) {
          for (let x = bx; x < Math.min(w, bx + n); x++) {
            const i = (y * w + x) * 4;
            out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; out.data[i + 3] = a;
          }
        }
      }
    }
    return out;
  },
};
