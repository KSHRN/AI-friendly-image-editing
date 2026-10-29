/**
 * Effect primitives shared by filters, layer styles and mask operations:
 * separable gaussian blur, exact Euclidean distance transform, alpha
 * colorisation and straight-alpha compositing.
 *
 * All functions are deterministic and allocation-conscious.
 */

import { Raster } from './raster.js';

/** Gaussian blur a single-channel coverage buffer. sigma in pixels. */
export function gaussianBlurAlpha(alpha, width, height, sigma) {
  if (sigma <= 0) return Uint8ClampedArray.from(alpha);
  const kernel = gaussianKernel(sigma);
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);

  // horizontal; weights are renormalised at the borders so a uniform input
  // stays uniform (no dark edge vignette).
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      let wsum = 0;
      for (let k = -kernel.radius; k <= kernel.radius; k++) {
        const sx = x + k;
        if (sx < 0 || sx >= width) continue;
        const w = kernel.weights[k + kernel.radius];
        acc += alpha[row + sx] * w;
        wsum += w;
      }
      tmp[row + x] = wsum > 0 ? acc / wsum : alpha[row + x];
    }
  }
  // vertical
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      let wsum = 0;
      for (let k = -kernel.radius; k <= kernel.radius; k++) {
        const sy = y + k;
        if (sy < 0 || sy >= height) continue;
        const w = kernel.weights[k + kernel.radius];
        acc += tmp[sy * width + x] * w;
        wsum += w;
      }
      out[y * width + x] = wsum > 0 ? acc / wsum : tmp[y * width + x];
    }
  }
  const res = new Uint8ClampedArray(width * height);
  for (let i = 0; i < res.length; i++) res[i] = out[i];
  return res;
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const weights = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights[i + radius] = w;
    sum += w;
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  return { radius, weights };
}

/** Gaussian blur an RGBA raster (straight alpha, blurred as-is). */
export function gaussianBlurRaster(raster, sigma) {
  const { width: w, height: h } = raster;
  const out = new Raster(w, h);
  const ch = [0, 1, 2, 3].map((c) => {
    const plane = new Uint8ClampedArray(w * h);
    for (let i = 0, j = 0; i < raster.data.length; i += 4, j++) plane[j] = raster.data[i + c];
    return gaussianBlurAlpha(plane, w, h, sigma);
  });
  for (let j = 0; j < w * h; j++) {
    const i = j * 4;
    out.data[i] = ch[0][j];
    out.data[i + 1] = ch[1][j];
    out.data[i + 2] = ch[2][j];
    out.data[i + 3] = ch[3][j];
  }
  return out;
}

/**
 * Exact Euclidean distance (in pixels) from every pixel to the nearest
 * "inside" pixel (alpha > threshold). Inside pixels are 0.
 * Felzenszwalb & Huttenlocher, two-pass 1D transform.
 */
export function distanceTransform(alpha, width, height, threshold = 0) {
  const INF = 1e20;
  const f = new Float64Array(Math.max(width, height));
  const d = new Float64Array(Math.max(width, height));
  const v = new Int32Array(Math.max(width, height));
  const z = new Float64Array(Math.max(width, height) + 1);
  const grid = new Float64Array(width * height);
  for (let i = 0; i < grid.length; i++) grid[i] = alpha[i] > threshold ? 0 : INF;

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    dt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) f[x] = grid[y * width + x];
    dt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[y * width + x] = d[x];
  }
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

function dt1d(f, d, v, z, n) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Anti-aliased dilation of a coverage buffer by `radius` pixels. */
export function dilateAlpha(alpha, width, height, radius) {
  if (radius <= 0) return Uint8ClampedArray.from(alpha);
  const dist = distanceTransform(alpha, width, height, 0);
  const out = new Uint8ClampedArray(alpha.length);
  for (let i = 0; i < out.length; i++) {
    const cover = Math.max(0, Math.min(1, radius + 0.5 - dist[i])) * 255;
    out[i] = Math.max(alpha[i], cover);
  }
  return out;
}

/** Anti-aliased erosion of a coverage buffer by `radius` pixels. */
export function erodeAlpha(alpha, width, height, radius) {
  if (radius <= 0) return Uint8ClampedArray.from(alpha);
  // Pad with 255 (i.e. "outside coverage") so erosion also eats inwards from
  // the canvas border instead of treating the border as infinitely solid.
  const pad = Math.ceil(radius) + 2;
  const pw = width + pad * 2;
  const ph = height + pad * 2;
  const inv = new Uint8ClampedArray(pw * ph).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      inv[(y + pad) * pw + (x + pad)] = 255 - alpha[y * width + x];
    }
  }
  const grown = dilateAlpha(inv, pw, ph, radius);
  const out = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = 255 - grown[(y + pad) * pw + (x + pad)];
    }
  }
  return out;
}

/** Build an RGBA raster tinted `color` where coverage > 0. */
export function colorizeAlpha(alpha, width, height, color) {
  const [r, g, b, a = 255] = color;
  const out = new Raster(width, height);
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    out.data[j] = r;
    out.data[j + 1] = g;
    out.data[j + 2] = b;
    out.data[j + 3] = (alpha[i] * a) / 255;
  }
  return out;
}

/** Extract the alpha plane of a raster. */
export function alphaPlane(raster) {
  const out = new Uint8ClampedArray(raster.width * raster.height);
  for (let i = 0, j = 0; i < raster.data.length; i += 4, j++) out[j] = raster.data[i + 3];
  return out;
}

/** Source-over: draw `src` onto `dst` in place (straight alpha). */
export function compositeOver(dst, src) {
  const { data: d } = dst;
  const { data: s } = src;
  const n = Math.min(d.length, s.length);
  for (let i = 0; i < n; i += 4) {
    const sa = s[i + 3] / 255;
    if (sa === 0) continue;
    if (sa === 1) {
      d[i] = s[i];
      d[i + 1] = s[i + 1];
      d[i + 2] = s[i + 2];
      d[i + 3] = 255;
      continue;
    }
    const da = d[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    d[i] = (s[i] * sa + d[i] * da * (1 - sa)) / oa;
    d[i + 1] = (s[i + 1] * sa + d[i + 1] * da * (1 - sa)) / oa;
    d[i + 2] = (s[i + 2] * sa + d[i + 2] * da * (1 - sa)) / oa;
    d[i + 3] = oa * 255;
  }
  return dst;
}

/** Draw `dst` over a copy of `src` (i.e. push dst below src). */
export function compositeUnder(dst, src) {
  const out = src.clone();
  return compositeOver(out, dst);
}

/** Multiply every alpha value by a 0..1 factor (in place). */
export function scaleAlpha(raster, factor) {
  if (factor === 1) return raster;
  for (let i = 3; i < raster.data.length; i += 4) raster.data[i] = raster.data[i] * factor;
  return raster;
}

/** Simple 3x3 emboss/edge helper used by some styles. */
export function laplacianAlpha(alpha, width, height) {
  const out = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const c = alpha[i];
      let acc = 0;
      if (x > 0) acc -= alpha[i - 1];
      if (x < width - 1) acc -= alpha[i + 1];
      if (y > 0) acc -= alpha[i - width];
      if (y < height - 1) acc -= alpha[i + width];
      out[i] = Math.abs(c * 4 + acc) / 4;
    }
  }
  return out;
}
