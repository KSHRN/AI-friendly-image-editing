export default {
  name: 'posterize',
  label: 'Posterize',
  params: { levels: { type: 'integer', default: 4, desc: 'number of tonal steps (2..255)' } },
  create({ levels = 4 } = {}) {
    const n = Math.max(2, Math.min(255, Math.round(levels)));
    const step = 255 / (n - 1);
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.round(Math.round(i / step) * step);
    return {
      map(r, g, b, out) {
        out[0] = lut[Math.round(r)];
        out[1] = lut[Math.round(g)];
        out[2] = lut[Math.round(b)];
      },
    };
  },
};
