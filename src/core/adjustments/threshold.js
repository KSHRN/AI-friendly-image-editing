/** Threshold to pure black/white — useful for hard masks and stencil looks. */

export default {
  name: 'threshold',
  label: 'Threshold',
  params: {
    threshold: { type: 'number', default: 128, desc: 'luminance cut point 0..255' },
    softness: { type: 'number', default: 0, desc: 'transition width in levels' },
  },
  create({ threshold = 128, softness = 0 } = {}) {
    return {
      map(r, g, b, out) {
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        let v;
        if (softness <= 0) v = l >= threshold ? 255 : 0;
        else {
          const t = Math.max(0, Math.min(1, (l - (threshold - softness / 2)) / softness));
          v = t * 255;
        }
        out[0] = v;
        out[1] = v;
        out[2] = v;
      },
    };
  },
};
