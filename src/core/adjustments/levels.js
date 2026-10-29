/**
 * Levels: input black/white, gamma, output black/white.
 * Gamma is applied in the linear-ish domain: ((v-black)/(white-black))^(1/gamma).
 */

export default {
  name: 'levels',
  label: 'Levels',
  params: {
    black: { type: 'number', default: 0, desc: 'input black point 0..255' },
    white: { type: 'number', default: 255, desc: 'input white point 0..255' },
    gamma: { type: 'number', default: 1, desc: 'midpoint gamma' },
    outBlack: { type: 'number', default: 0, desc: 'output black 0..255' },
    outWhite: { type: 'number', default: 255, desc: 'output white 0..255' },
    channel: { type: 'string', default: 'rgb', desc: 'rgb | r | g | b' },
  },
  create({ black = 0, white = 255, gamma = 1, outBlack = 0, outWhite = 255, channel = 'rgb' } = {}) {
    const span = Math.max(1e-6, white - black);
    const g = Math.max(0.01, Math.min(10, gamma));
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      let t = (i - black) / span;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      t = Math.pow(t, 1 / g);
      lut[i] = outBlack + t * (outWhite - outBlack);
    }
    const all = channel === 'rgb';
    return {
      map(r, gg, b, out) {
        out[0] = all || channel === 'r' ? lut[Math.round(r)] : r;
        out[1] = all || channel === 'g' ? lut[Math.round(gg)] : gg;
        out[2] = all || channel === 'b' ? lut[Math.round(b)] : b;
      },
    };
  },
};
