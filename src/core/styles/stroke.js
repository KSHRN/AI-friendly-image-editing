import { parseColor } from '../raster.js';
import { alphaPlane, colorizeAlpha, dilateAlpha, erodeAlpha } from '../effects.js';

function padAlpha(content, pad) {
  const cw = content.width, ch = content.height;
  const pw = cw + pad * 2;
  const ph = ch + pad * 2;
  const plane = new Uint8ClampedArray(pw * ph);
  const alpha = alphaPlane(content);
  for (let y = 0; y < ch; y++) {
    plane.set(alpha.subarray(y * cw, (y + 1) * cw), (y + pad) * pw + pad);
  }
  return { plane, width: pw, height: ph, cw, ch, pad };
}

/** Stroke around the layer's alpha, inside / outside / centred. */
export default {
  name: 'stroke',
  label: 'Stroke',
  lengthParams: ['width'],
  params: {
    color: { type: 'color', default: '#ffffff' },
    width: { type: 'number', default: 4 },
    position: { type: 'string', default: 'outside', desc: 'outside | inside | center' },
    opacity: { type: 'number', default: 1 },
  },
  apply(content, { color = '#ffffff', width = 4, position = 'outside', opacity = 1 } = {}) {
    const w = Math.max(0, Number(width));
    if (w <= 0) return {};
    // Dilate/erode on a padded plane so the outside half of the stroke is not
    // clipped by the content box (this is why the pad exists at all).
    const extra = Math.ceil(w) + 2;
    const { plane, width: pw, height: ph } = padAlpha(content, extra);

    let band;
    if (position === 'inside') {
      const eroded = erodeAlpha(plane, pw, ph, w);
      band = new Uint8ClampedArray(plane.length);
      for (let i = 0; i < plane.length; i++) band[i] = Math.max(0, plane[i] - eroded[i]);
    } else if (position === 'center') {
      const grown = dilateAlpha(plane, pw, ph, w / 2);
      const eroded = erodeAlpha(plane, pw, ph, w / 2);
      band = new Uint8ClampedArray(plane.length);
      for (let i = 0; i < plane.length; i++) band[i] = Math.max(0, grown[i] - eroded[i]);
    } else {
      const grown = dilateAlpha(plane, pw, ph, w);
      band = new Uint8ClampedArray(plane.length);
      for (let i = 0; i < plane.length; i++) band[i] = Math.max(0, grown[i] - plane[i]);
    }

    const raster = colorizeAlpha(band, pw, ph, parseColor(color));
    const op = Math.max(0, Math.min(1, opacity));
    if (op < 1) {
      for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = raster.data[i] * op;
    }
    return { over: { raster, pad: extra } };
  },
};

