/**
 * Raster: an 8-bit-per-channel RGBA image with *straight* (non-premultiplied)
 * alpha. All pixel math in AShop uses this representation so that colour
 * values are stable and easy to reason about; premultiplication only happens
 * transiently while resampling.
 */

import { createHash } from 'node:crypto';

export class Raster {
  /**
   * @param {number} width
   * @param {number} height
   * @param {Uint8ClampedArray} [data] RGBA, length = width*height*4
   */
  constructor(width, height, data) {
    if (!Number.isInteger(width) || width <= 0) throw new Error(`invalid raster width: ${width}`);
    if (!Number.isInteger(height) || height <= 0) throw new Error(`invalid raster height: ${height}`);
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8ClampedArray(width * height * 4);
    if (this.data.length !== width * height * 4) {
      throw new Error(`raster data length ${this.data.length} != ${width * height * 4}`);
    }
  }

  /** @returns {Raster} a fully transparent raster, or one filled with `color`. */
  static create(width, height, color = null) {
    const r = new Raster(width, height);
    if (color) r.fill(color);
    return r;
  }

  static fromBuffer(buffer, width, height) {
    if (!(buffer instanceof Uint8ClampedArray)) buffer = new Uint8ClampedArray(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return new Raster(width, height, buffer);
  }

  clone() {
    return new Raster(this.width, this.height, new Uint8ClampedArray(this.data));
  }

  index(x, y) {
    return (y * this.width + x) * 4;
  }

  /** @returns {[number,number,number,number]} straight RGBA 0..255 */
  get(x, y) {
    const i = this.index(x, y);
    const d = this.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  set(x, y, rgba) {
    const i = this.index(x, y);
    const d = this.data;
    d[i] = rgba[0];
    d[i + 1] = rgba[1];
    d[i + 2] = rgba[2];
    d[i + 3] = rgba[3] ?? 255;
  }

  fill(rgba) {
    const [r, g, b, a = 255] = rgba;
    const d = this.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = a;
    }
    return this;
  }

  /** True when every pixel is fully transparent. */
  isEmpty() {
    const d = this.data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
    return true;
  }

  /** Bounding box of non-zero alpha pixels, or null when fully transparent. */
  alphaBounds() {
    const { width: w, height: h, data } = this;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (data[row + x * 4 + 3] !== 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  /** Bounding box of pixels that differ from `color` (useful after a fill). */
  colorBounds(color) {
    const { width: w, height: h, data } = this;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (data[i] !== color[0] || data[i + 1] !== color[1] || data[i + 2] !== color[2] || data[i + 3] !== (color[3] ?? 255)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  toBuffer() {
    return Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
  }

  /** sha256 over raw pixel bytes; the canonical "did pixels change" check. */
  pixelHash() {
    return createHash('sha256').update(this.toBuffer()).digest('hex');
  }

  /** Crop to a canvas-space rectangle, zero-padding out-of-bounds areas. */
  crop(x, y, width, height) {
    const out = new Raster(width, height);
    for (let dy = 0; dy < height; dy++) {
      const sy = y + dy;
      if (sy < 0 || sy >= this.height) continue;
      for (let dx = 0; dx < width; dx++) {
        const sx = x + dx;
        if (sx < 0 || sx >= this.width) continue;
        const si = (sy * this.width + sx) * 4;
        const di = (dy * width + dx) * 4;
        out.data[di] = this.data[si];
        out.data[di + 1] = this.data[si + 1];
        out.data[di + 2] = this.data[si + 2];
        out.data[di + 3] = this.data[si + 3];
      }
    }
    return out;
  }

  /**
   * Bilinear sample in *premultiplied* space to avoid colour bleeding from
   * transparent neighbours. Returns straight RGBA 0..255.
   */
  sampleBilinear(x, y) {
    const { width: w, height: h, data } = this;
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) {
      // Clamp for edge pixels but treat far outside as transparent.
      if (x < -1 || y < -1 || x > w || y > h) return [0, 0, 0, 0];
    }
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
    const cx0 = Math.max(0, Math.min(w - 1, x0)), cy0 = Math.max(0, Math.min(h - 1, y0));
    const i00 = (cy0 * w + cx0) * 4, i10 = (cy0 * w + x1) * 4;
    const i01 = (y1 * w + cx0) * 4, i11 = (y1 * w + x1) * 4;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    const a00 = data[i00 + 3] / 255, a10 = data[i10 + 3] / 255;
    const a01 = data[i01 + 3] / 255, a11 = data[i11 + 3] / 255;
    const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
    if (a <= 0) return [0, 0, 0, 0];
    const out = [0, 0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = data[i00 + c] * a00 * w00 + data[i10 + c] * a10 * w10
        + data[i01 + c] * a01 * w01 + data[i11 + c] * a11 * w11;
      out[c] = v / a;
    }
    out[3] = a * 255;
    return out;
  }

  /** Resize with nearest neighbour; used for quick previews of index masks. */
  resizeNearest(width, height) {
    const out = new Raster(width, height);
    for (let y = 0; y < height; y++) {
      const sy = Math.min(this.height - 1, Math.floor((y + 0.5) * this.height / height));
      for (let x = 0; x < width; x++) {
        const sx = Math.min(this.width - 1, Math.floor((x + 0.5) * this.width / width));
        const si = (sy * this.width + sx) * 4, di = (y * width + x) * 4;
        out.data[di] = this.data[si];
        out.data[di + 1] = this.data[si + 1];
        out.data[di + 2] = this.data[si + 2];
        out.data[di + 3] = this.data[si + 3];
      }
    }
    return out;
  }
}

/** Parse "#rgb" / "#rrggbb" / "#rrggbbaa" / "r,g,b[,a]" into [r,g,b,a]. */
export function parseColor(input, alphaDefault = 255) {
  if (Array.isArray(input)) {
    const [r, g, b, a = alphaDefault] = input;
    return [r, g, b, a].map((v) => clamp255(v));
  }
  if (typeof input !== 'string') throw new Error(`not a colour: ${input}`);
  const s = input.trim();
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : alphaDefault;
    return [r, g, b, a];
  }
  // CSS functional notation: rgb(255, 0, 0), rgb(255 0 0 / 50%), rgba(..., 0.5).
  const fn = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (fn) {
    const body = fn[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
    if (body.length >= 3) {
      const channel = (v) => (/^-?[\d.]+%$/.test(v) ? (parseFloat(v) / 100) * 255 : Number(v));
      const rgb = body.slice(0, 3).map(channel);
      const alphaToken = body[3];
      const alpha = alphaToken == null
        ? alphaDefault
        : clamp255(/^-?[\d.]+%$/.test(alphaToken) ? (parseFloat(alphaToken) / 100) * 255 : Number(alphaToken) * 255);
      if (rgb.every((v) => Number.isFinite(v))) {
        return [clamp255(rgb[0]), clamp255(rgb[1]), clamp255(rgb[2]), alpha];
      }
    }
  }
  const parts = s.split(',').map((v) => Number(v.trim()));
  if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
    return [clamp255(parts[0]), clamp255(parts[1]), clamp255(parts[2]), clamp255(parts[3] ?? alphaDefault)];
  }
  const lower = s.toLowerCase();
  if (lower === 'transparent') return [0, 0, 0, 0];
  const named = NAMED_COLORS[lower];
  if (named) return [named[0], named[1], named[2], alphaDefault];
  throw new Error(`cannot parse colour: ${input}`);
}

export function colorToHex([r, g, b, a = 255]) {
  const h = (v) => Math.round(v).toString(16).padStart(2, '0');
  return a === 255 ? `#${h(r)}${h(g)}${h(b)}` : `#${h(r)}${h(g)}${h(b)}${h(a)}`;
}

function clamp255(v) {
  v = Number(v);
  if (!Number.isFinite(v)) throw new Error(`invalid colour component: ${v}`);
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * CSS colour names (the standard 148). Kept as hex so the table stays readable
 * and parsing is a single lookup on the slow path.
 */
const NAMED_COLORS = (() => {
  const table = {
    aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
    beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
    blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
    chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
    cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
    darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b', darkolivegreen: '556b2f',
    darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000', darksalmon: 'e9967a', darkseagreen: '8fbc8f',
    darkslateblue: '483d8b', darkslategray: '2f4f4f', darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3',
    deeppink: 'ff1493', deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff',
    firebrick: 'b22222', floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc',
    ghostwhite: 'f8f8ff', gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000',
    greenyellow: 'adff2f', grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c',
    indigo: '4b0082', ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5',
    lawngreen: '7cfc00', lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff',
    lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3', lightpink: 'ffb6c1',
    lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa', lightslategray: '778899', lightslategrey: '778899',
    lightsteelblue: 'b0c4de', lightyellow: 'ffffe0', lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6',
    magenta: 'ff00ff', maroon: '800000', mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3',
    mediumpurple: '9370db', mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a', mediumturquoise: '48d1cc',
    mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa', mistyrose: 'ffe4e1', moccasin: 'ffe4b5',
    navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6', olive: '808000', olivedrab: '6b8e23',
    orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6', palegoldenrod: 'eee8aa', palegreen: '98fb98',
    paleturquoise: 'afeeee', palevioletred: 'db7093', papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f',
    pink: 'ffc0cb', plum: 'dda0dd', powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399',
    red: 'ff0000', rosybrown: 'bc8f8f', royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072',
    sandybrown: 'f4a460', seagreen: '2e8b57', seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0',
    skyblue: '87ceeb', slateblue: '6a5acd', slategray: '708090', slategrey: '708090', snow: 'fffafa',
    springgreen: '00ff7f', steelblue: '4682b4', tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8',
    tomato: 'ff6347', turquoise: '40e0d0', violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff',
    whitesmoke: 'f5f5f5', yellow: 'ffff00', yellowgreen: '9acd32',
  };
  const out = {};
  for (const [name, hex] of Object.entries(table)) {
    out[name] = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  return out;
})();
