/**
 * Vibrance: boost saturation most on already-muted colours, leave saturated
 * ones alone. Much softer than a global saturation change.
 */

export default {
  name: 'vibrance',
  label: 'Vibrance',
  params: { amount: { type: 'number', default: 0.5, desc: '-1..1' } },
  create({ amount = 0.5 } = {}) {
    const a = Math.max(-1, Math.min(1, amount));
    return {
      map(r, g, b, out) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const boost = 1 + a * (1 - sat) * 0.9;
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        out[0] = l + (r - l) * boost;
        out[1] = l + (g - l) * boost;
        out[2] = l + (b - l) * boost;
      },
    };
  },
};
