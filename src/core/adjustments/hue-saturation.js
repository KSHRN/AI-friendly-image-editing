/** Hue / saturation / lightness in HSL space. */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
  if (s === 0) {
    const v = l * 255;
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

export default {
  name: 'hue-saturation',
  label: 'Hue / Saturation',
  params: {
    hue: { type: 'number', default: 0, desc: 'hue rotation in degrees' },
    saturation: { type: 'number', default: 1, desc: 'saturation multiplier, 1 = unchanged, 0 = grey' },
    lightness: { type: 'number', default: 0, desc: 'lightness delta -1..1' },
  },
  create({ hue = 0, saturation = 1, lightness = 0 } = {}) {
    const dh = hue / 360;
    return {
      map(r, g, b, out) {
        let [h, s, l] = rgbToHsl(r, g, b);
        h = (h + dh) % 1;
        if (h < 0) h += 1;
        s = Math.max(0, Math.min(1, s * saturation));
        l = Math.max(0, Math.min(1, l + lightness));
        const rgb = hslToRgb(h, s, l);
        out[0] = rgb[0];
        out[1] = rgb[1];
        out[2] = rgb[2];
      },
    };
  },
};
