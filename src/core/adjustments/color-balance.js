/**
 * Colour balance: independent RGB shifts for shadows / midtones / highlights.
 * Weights are smooth functions of luminance so tonal bands blend without a
 * hard seam.
 */

function weights(l) {
  // l in 0..1
  const shadows = Math.pow(1 - l, 2);
  const highlights = Math.pow(l, 2);
  const midtones = 1 - shadows - highlights;
  return [shadows, midtones, highlights];
}

export default {
  name: 'color-balance',
  label: 'Color Balance',
  params: {
    shadows: { type: 'vec3', default: [0, 0, 0], desc: 'RGB deltas -100..100 for shadows' },
    midtones: { type: 'vec3', default: [0, 0, 0], desc: 'RGB deltas -100..100 for midtones' },
    highlights: { type: 'vec3', default: [0, 0, 0], desc: 'RGB deltas -100..100 for highlights' },
    preserveLuminosity: { type: 'boolean', default: true },
  },
  create({ shadows = [0, 0, 0], midtones = [0, 0, 0], highlights = [0, 0, 0], preserveLuminosity = true } = {}) {
    const s = shadows.map((v) => v / 100);
    const m = midtones.map((v) => v / 100);
    const h = highlights.map((v) => v / 100);
    return {
      map(r, g, b, out) {
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const [ws, wm, wh] = weights(lum);
        let nr = r + (s[0] * ws + m[0] * wm + h[0] * wh) * 255;
        let ng = g + (s[1] * ws + m[1] * wm + h[1] * wh) * 255;
        let nb = b + (s[2] * ws + m[2] * wm + h[2] * wh) * 255;
        if (preserveLuminosity) {
          const oldLum = 0.299 * r + 0.587 * g + 0.114 * b;
          const newLum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
          const d = oldLum - newLum;
          nr += d; ng += d; nb += d;
        }
        out[0] = Math.max(0, Math.min(255, nr));
        out[1] = Math.max(0, Math.min(255, ng));
        out[2] = Math.max(0, Math.min(255, nb));
      },
    };
  },
};
