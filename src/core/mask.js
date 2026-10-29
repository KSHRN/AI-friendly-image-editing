/**
 * Mask: a single-channel 8-bit coverage map. Masks are the common currency of
 * selections, layer masks and effect clipping.
 */

export class Mask {
  /** @param {Uint8ClampedArray} [data] length = width*height */
  constructor(width, height, data) {
    if (!Number.isInteger(width) || width <= 0) throw new Error(`invalid mask width: ${width}`);
    if (!Number.isInteger(height) || height <= 0) throw new Error(`invalid mask height: ${height}`);
    this.width = width;
    this.height = height;
    this.data = data ?? new Uint8ClampedArray(width * height);
    if (this.data.length !== width * height) {
      throw new Error(`mask data length ${this.data.length} != ${width * height}`);
    }
  }

  static create(width, height, value = 0) {
    const m = new Mask(width, height);
    if (value) m.data.fill(value);
    return m;
  }

  /** Coverage is the alpha channel of the raster, scaled by 0..1. */
  static fromRasterAlpha(raster) {
    const m = new Mask(raster.width, raster.height);
    for (let i = 0, j = 0; i < raster.data.length; i += 4, j++) m.data[j] = raster.data[i + 3];
    return m;
  }

  clone() {
    return new Mask(this.width, this.height, new Uint8ClampedArray(this.data));
  }

  index(x, y) {
    return y * this.width + x;
  }

  get(x, y) {
    return this.data[y * this.width + x];
  }

  set(x, y, v) {
    this.data[y * this.width + x] = v;
  }

  invert() {
    const d = this.data;
    for (let i = 0; i < d.length; i++) d[i] = 255 - d[i];
    return this;
  }

  isEmpty() {
    const d = this.data;
    for (let i = 0; i < d.length; i++) if (d[i] !== 0) return false;
    return true;
  }

  /** Fraction of pixels with coverage > 128. */
  coverage() {
    let on = 0;
    for (let i = 0; i < this.data.length; i++) if (this.data[i] > 128) on++;
    return on / this.data.length;
  }

  alphaBounds() {
    const { width: w, height: h, data } = this;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (data[y * w + x] !== 0) {
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

  /** Render as an RGBA raster of white pixels with coverage in alpha. */
  toRaster() {
    const r = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0, j = 0; i < this.data.length; i++, j += 4) {
      r[j] = 255;
      r[j + 1] = 255;
      r[j + 2] = 255;
      r[j + 3] = this.data[i];
    }
    return { width: this.width, height: this.height, data: r };
  }
}

/**
 * Interpolate a mask; used when a canvas-space selection has to be read in
 * layer-local coordinates.
 */
export function sampleMaskBilinear(mask, x, y) {
  const { width: w, height: h, data } = mask;
  if (x < -1 || y < -1 || x > w || y > h) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1);
  const cx0 = Math.max(0, Math.min(w - 1, x0)), cy0 = Math.max(0, Math.min(h - 1, y0));
  const v00 = data[cy0 * w + cx0], v10 = data[cy0 * w + x1];
  const v01 = data[y1 * w + cx0], v11 = data[y1 * w + x1];
  return v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
}
