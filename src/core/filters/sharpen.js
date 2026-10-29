import { gaussianBlurRaster } from '../effects.js';

/** Unsharp mask: out = src + amount * (src - blur), thresholded. */
export default {
  name: 'sharpen',
  label: 'Sharpen (Unsharp Mask)',
  params: {
    amount: { type: 'number', default: 1, desc: 'strength, 0..5' },
    radius: { type: 'number', default: 2, desc: 'detail radius in pixels' },
    threshold: { type: 'number', default: 0, desc: 'ignore differences below this (0..255)' },
  },
  lengthParams: ['radius'],
  apply(raster, { amount = 1, radius = 2, threshold = 0 } = {}) {
    const amt = Math.max(0, Number(amount));
    if (amt === 0) return raster.clone();
    const sigma = Math.max(0.1, Number(radius)) / 2;
    const blurred = gaussianBlurRaster(raster, sigma);
    const out = raster.clone();
    const { data } = out;
    const bd = blurred.data;
    const thr = Math.max(0, Number(threshold));
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        const d = data[i + c] - bd[i + c];
        if (Math.abs(d) <= thr) continue;
        data[i + c] = data[i + c] + amt * d;
      }
    }
    return out;
  },
};
