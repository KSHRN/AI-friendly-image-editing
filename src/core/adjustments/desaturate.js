export default {
  name: 'desaturate',
  label: 'Desaturate',
  params: { amount: { type: 'number', default: 1, desc: '0..1, 1 = fully grey' } },
  create({ amount = 1 } = {}) {
    const a = Math.max(0, Math.min(1, amount));
    return {
      map(r, g, b, out) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        out[0] = r + (l - r) * a;
        out[1] = g + (l - g) * a;
        out[2] = b + (l - b) * a;
      },
    };
  },
};
