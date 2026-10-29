import { gaussianBlurRaster } from '../effects.js';

export default {
  name: 'gaussian-blur',
  label: 'Gaussian Blur',
  params: { radius: { type: 'number', default: 8, desc: 'blur radius in pixels (sigma = radius / 2)' } },
  lengthParams: ['radius'],
  apply(raster, { radius = 8 } = {}) {
    const sigma = Math.max(0, Number(radius)) / 2;
    if (sigma <= 0) return raster.clone();
    return gaussianBlurRaster(raster, sigma);
  },
};
