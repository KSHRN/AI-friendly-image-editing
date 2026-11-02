import { Raster, parseColor } from '../raster.js';
import { alphaPlane, colorizeAlpha, dilateAlpha, gaussianBlurAlpha } from '../effects.js';

/**
 * Drop shadow.
 *
 * The alpha plane is padded *before* dilating/blurring, otherwise the soft
 * edge would be clipped by the content box and the shadow would lose its
 * outside half. `pad` tells the compositor where the content box sits inside
 * the returned raster.
 */
export default {
  name: 'drop-shadow',
  label: 'Drop Shadow',
  lengthParams: ['offsetX', 'offsetY', 'blur', 'spread'],
  params: {
    color: { type: 'color', default: '#00000080' },
    offsetX: { type: 'number', default: 0 },
    offsetY: { type: 'number', default: 12 },
    blur: { type: 'number', default: 24, desc: 'blur radius in px' },
    spread: { type: 'number', default: 0, desc: 'dilation in px before blur' },
    opacity: { type: 'number', default: 1, desc: '0..1' },
  },
  apply(content, { color = '#00000080', offsetX = 0, offsetY = 12, blur = 24, spread = 0, opacity = 1 } = {}) {
    const soft = Math.ceil(Math.max(0, spread) + Math.max(0, blur));
    const offset = Math.ceil(Math.max(Math.abs(offsetX), Math.abs(offsetY)));
    const pad = soft + offset + 2;
    const cw = content.width, ch = content.height;
    const pw = cw + pad * 2;
    const ph = ch + pad * 2;

    const src = alphaPlane(content);
    let alpha = new Uint8ClampedArray(pw * ph);
    for (let y = 0; y < ch; y++) alpha.set(src.subarray(y * cw, (y + 1) * cw), (y + pad) * pw + pad);
    if (spread > 0) alpha = dilateAlpha(alpha, pw, ph, spread);
    if (blur > 0) alpha = gaussianBlurAlpha(alpha, pw, ph, blur / 2);

    const rgba = parseColor(color);
    const shadow = colorizeAlpha(alpha, pw, ph, rgba);
    const op = Math.max(0, Math.min(1, opacity));
    const raster = new Raster(pw, ph);
    const shiftX = Math.round(offsetX);
    const shiftY = Math.round(offsetY);
    for (let y = 0; y < ph; y++) {
      const ty = y + shiftY;
      if (ty < 0 || ty >= ph) continue;
      for (let x = 0; x < pw; x++) {
        const tx = x + shiftX;
        if (tx < 0 || tx >= pw) continue;
        const si = (y * pw + x) * 4;
        const sa = shadow.data[si + 3] * op;
        if (sa <= 0) continue;
        const di = (ty * pw + tx) * 4;
        raster.data[di] = shadow.data[si];
        raster.data[di + 1] = shadow.data[si + 1];
        raster.data[di + 2] = shadow.data[si + 2];
        raster.data[di + 3] = sa;
      }
    }
    return { under: { raster, pad } };
  },
};

