/** Brightness / contrast — the classic 128-centred contrast curve. */

export default {
  name: 'brightness-contrast',
  label: 'Brightness / Contrast',
  params: {
    brightness: { type: 'number', default: 0, desc: 'additive brightness in -255..255' },
    contrast: { type: 'number', default: 0, desc: 'contrast multiplier delta, -100..100' },
  },
  create({ brightness = 0, contrast = 0 } = {}) {
    const c = Math.max(-100, Math.min(100, contrast));
    const factor = (259 * (c + 255)) / (255 * (259 - c));
    const lut = new Uint8ClampedArray(256);
    for (let i = 0; i < 256; i++) {
      lut[i] = Math.max(0, Math.min(255, factor * (i - 128) + 128 + brightness));
    }
    return {
      map(r, g, b, out) {
        out[0] = lut[Math.round(r)];
        out[1] = lut[Math.round(g)];
        out[2] = lut[Math.round(b)];
      },
    };
  },
};
