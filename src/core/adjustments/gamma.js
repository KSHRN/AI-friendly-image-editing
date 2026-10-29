export default {
  name: 'gamma',
  label: 'Gamma',
  params: { gamma: { type: 'number', default: 1, desc: 'gamma exponent, 1 = unchanged' } },
  create({ gamma = 1 } = {}) {
    const g = Math.max(0.01, Math.min(10, gamma));
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = 255 * Math.pow(i / 255, g);
    return {
      map(r, gg, b, out) {
        out[0] = lut[Math.round(r)];
        out[1] = lut[Math.round(gg)];
        out[2] = lut[Math.round(b)];
      },
    };
  },
};
