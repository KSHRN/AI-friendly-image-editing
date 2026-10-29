/**
 * Pixel-level regression diffing and perceptual similarity.
 *
 * Two questions live here, and their semantics differ on purpose:
 *
 *  - `computeDiff` is an exact per-channel byte comparison over all four
 *    channels. Alpha is *not* used as a weight and is not peeled off: a pixel
 *    counts as a difference when any channel moves by more than `tolerance`.
 *    Straight-alpha rasters keep meaningful RGB bytes underneath alpha=0, so
 *    "transparent to transparent, but the hidden colour changed" is still a
 *    difference -- otherwise a bad composite could hide behind transparency.
 *    (This also keeps the metric monotonic: identical bytes => zero error.)
 *
 *  - `ssim` is a perceptual, luminance-only measure (Y = 0.299R + 0.587G +
 *    0.114B on 0..255, alpha ignored). It complements the byte diff instead of
 *    duplicating it: small shifts or resampling show up here, byte noise does
 *    not.
 *
 * Everything is synchronous, deterministic and allocation-light: the hot paths
 * are single passes over the pixel buffer.
 */

import { Raster } from './raster.js';
import { AshopError } from './errors.js';
import { assertSameSize } from './stats.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** SSIM constants: C1 = (K1*L)^2, C2 = (K2*L)^2, L = 255 (8-bit range). */
const SSIM_L = 255;
const SSIM_K1 = 0.01;
const SSIM_K2 = 0.03;
const SSIM_DEFAULT_WINDOW = 11;
const SSIM_DEFAULT_SIGMA = 1.5;

/**
 * sRGB transfer functions, normalised 0..1 in and out.
 * (For 8-bit inputs divide by 255 first; kept scalar so callers can vectorise.)
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * 2-D Gaussian weights for an `size` x `size` window, normalised so the full
 * kernel sums to 1. Window sums are renormalised again when a border window is
 * clipped, which keeps the mean/variance estimators unbiased at the edges.
 */
function gaussianKernel(size, sigma) {
  const kernel = new Float64Array(size * size);
  const centre = (size - 1) / 2;
  const denom = 2 * sigma * sigma;
  let sum = 0;
  for (let y = 0; y < size; y++) {
    const dy = y - centre;
    for (let x = 0; x < size; x++) {
      const dx = x - centre;
      const w = Math.exp(-(dx * dx + dy * dy) / denom);
      kernel[y * size + x] = w;
      sum += w;
    }
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

/** Luminance plane, Y on 0..255 (float; alpha is deliberately ignored). */
function luminancePlane(raster) {
  const { width: w, height: h, data } = raster;
  const n = w * h;
  const out = new Float64Array(n);
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    out[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return out;
}

/**
 * Structural similarity of the luminance planes, averaged over windows.
 *
 * The window is an 11x11 Gaussian (sigma = 1.5) applied at *non-overlapping*
 * positions (stride = window size) rather than per pixel. That is the
 * documented trade-off here: the mean is over disjoint tiles, which is ~100x
 * cheaper than a sliding window while still being a stable, deterministic
 * number for regression thresholds. Border tiles are clipped to the image and
 * renormalised, so every pixel contributes exactly once; images smaller than
 * the window therefore use a single clipped window.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} a
 * @param {{width:number,height:number,data:Uint8ClampedArray}} b
 * @param {{window?:number, sigma?:number}} [opts]
 * @returns {number} mean SSIM, clamped to 0..1
 */
export function ssim(a, b, opts = {}) {
  assertSameSize(a, b, 'ssim');
  const size = opts.window ?? SSIM_DEFAULT_WINDOW;
  const sigma = opts.sigma ?? SSIM_DEFAULT_SIGMA;
  if (!Number.isInteger(size) || size < 1) {
    throw new AshopError('E_USAGE', `ssim window must be a positive integer, got ${size}`, {
      hint: 'the default is 11 (11x11 Gaussian, sigma 1.5)',
    });
  }
  if (typeof sigma !== 'number' || !Number.isFinite(sigma) || sigma <= 0) {
    throw new AshopError('E_USAGE', `ssim sigma must be a positive number, got ${sigma}`);
  }

  const { width: w, height: h } = a;
  const kernel = gaussianKernel(size, sigma);
  const la = luminancePlane(a);
  const lb = luminancePlane(b);
  const c1 = (SSIM_K1 * SSIM_L) ** 2;
  const c2 = (SSIM_K2 * SSIM_L) ** 2;

  let total = 0;
  let tiles = 0;
  for (let oy = 0; oy < h; oy += size) {
    const yEnd = Math.min(oy + size, h);
    for (let ox = 0; ox < w; ox += size) {
      const xEnd = Math.min(ox + size, w);
      let sumW = 0, sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
      for (let y = oy; y < yEnd; y++) {
        const kRow = (y - oy) * size;
        const row = y * w;
        for (let x = ox; x < xEnd; x++) {
          const kw = kernel[kRow + (x - ox)];
          const va = la[row + x];
          const vb = lb[row + x];
          sumW += kw;
          sumA += kw * va;
          sumB += kw * vb;
          sumAA += kw * va * va;
          sumBB += kw * vb * vb;
          sumAB += kw * va * vb;
        }
      }
      const invW = 1 / sumW;
      const meanA = sumA * invW;
      const meanB = sumB * invW;
      const varA = Math.max(0, sumAA * invW - meanA * meanA);
      const varB = Math.max(0, sumBB * invW - meanB * meanB);
      const covAB = sumAB * invW - meanA * meanB;
      const numerator = (2 * meanA * meanB + c1) * (2 * covAB + c2);
      const denominator = (meanA * meanA + meanB * meanB + c1) * (varA + varB + c2);
      total += numerator / denominator;
      tiles++;
    }
  }
  return clamp01(total / tiles);
}

/**
 * Exact regression diff between two same-sized rasters.
 *
 * Per channel, |delta| > `tolerance` marks a pixel as mismatched; a pixel is
 * counted once no matter how many of its channels moved. `changedBounds` is
 * the union of those mismatched pixels, in raster coordinates. `identical`
 * means every byte matches (not merely "within tolerance").
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} a
 * @param {{width:number,height:number,data:Uint8ClampedArray}} b
 * @param {{threshold?:number, tolerance?:number, ssim?:boolean, diffImage?:boolean, amplify?:number}} [opts]
 * @returns {{width:number,height:number,identical:boolean,metrics:object,pass:boolean,diffRaster?:Raster}}
 */
export function computeDiff(a, b, opts = {}) {
  const {
    threshold = 0.001,
    tolerance = 16,
    ssim: wantSsim = true,
    diffImage: wantImage = false,
    amplify = 4,
  } = opts;

  assertSameSize(a, b, 'computeDiff');
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new AshopError('E_USAGE', `threshold must be a number within 0..1, got ${threshold}`, {
      hint: 'threshold is the allowed mismatchRatio, e.g. 0.001 for 0.1% of pixels',
    });
  }
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new AshopError('E_USAGE', `tolerance must be a non-negative number, got ${tolerance}`);
  }
  if (typeof amplify !== 'number' || !Number.isFinite(amplify) || amplify <= 0) {
    throw new AshopError('E_USAGE', `amplify must be a positive number, got ${amplify}`);
  }

  const { width: w, height: h } = a;
  const n = w * h;
  const da = a.data;
  const db = b.data;
  const chAbs = new Float64Array(4);

  let identical = true;
  let totalAbs = 0;
  let totalSq = 0;
  let maxDelta = 0;
  let mismatched = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = (row + x) * 4;
      const dr = da[i] - db[i];
      const dg = da[i + 1] - db[i + 1];
      const dblue = da[i + 2] - db[i + 2];
      const dalpha = da[i + 3] - db[i + 3];
      const ar = dr < 0 ? -dr : dr;
      const ag = dg < 0 ? -dg : dg;
      const ablue = dblue < 0 ? -dblue : dblue;
      const aalpha = dalpha < 0 ? -dalpha : dalpha;

      chAbs[0] += ar;
      chAbs[1] += ag;
      chAbs[2] += ablue;
      chAbs[3] += aalpha;
      totalAbs += ar + ag + ablue + aalpha;
      totalSq += dr * dr + dg * dg + dblue * dblue + dalpha * dalpha;

      const pixelDelta = Math.max(ar, ag, ablue, aalpha);
      if (pixelDelta > maxDelta) maxDelta = pixelDelta;

      if (ar !== 0 || ag !== 0 || ablue !== 0 || aalpha !== 0) {
        identical = false;
        if (ar > tolerance || ag > tolerance || ablue > tolerance || aalpha > tolerance) {
          mismatched++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
  }

  const channelCount = n * 4;
  const mismatchRatio = mismatched / n;
  const metrics = {
    mismatchRatio,
    mae: totalAbs / channelCount / 255,
    rmse: Math.sqrt(totalSq / channelCount) / 255,
    maxDelta,
    channelMae: [chAbs[0] / n / 255, chAbs[1] / n / 255, chAbs[2] / n / 255, chAbs[3] / n / 255],
  };
  if (wantSsim) metrics.ssim = ssim(a, b);
  metrics.changedBounds = maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };

  const result = {
    width: w,
    height: h,
    identical,
    metrics,
    pass: mismatchRatio <= threshold,
  };
  if (wantImage) result.diffRaster = diffRaster(a, b, { amplify });
  return result;
}

/**
 * Build a human-readable diff image: `a` dimmed to grey (luminance * 0.25)
 * with changed pixels lit up red -> yellow by the amplified max channel delta.
 * Identical pixels stay at the dim grey base, so the eye lands on changes.
 *
 * Output is opaque (alpha = 255) by design; it is a diagnostic overlay, not
 * compositing data. Deterministic for the same inputs and options.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} a
 * @param {{width:number,height:number,data:Uint8ClampedArray}} b
 * @param {{amplify?:number}} [opts]
 * @returns {Raster}
 */
export function diffRaster(a, b, { amplify = 4 } = {}) {
  assertSameSize(a, b, 'diffRaster');
  if (typeof amplify !== 'number' || !Number.isFinite(amplify) || amplify <= 0) {
    throw new AshopError('E_USAGE', `amplify must be a positive number, got ${amplify}`);
  }
  const { width: w, height: h } = a;
  const da = a.data;
  const db = b.data;
  const out = new Raster(w, h);
  const od = out.data;

  for (let i = 0; i < da.length; i += 4) {
    // Dimmed luminance of the reference keeps the layout readable.
    const base = (0.299 * da[i] + 0.587 * da[i + 1] + 0.114 * da[i + 2]) * 0.25;
    const dr = da[i] - db[i];
    const dg = da[i + 1] - db[i + 1];
    const dblue = da[i + 2] - db[i + 2];
    const dalpha = da[i + 3] - db[i + 3];
    const ar = dr < 0 ? -dr : dr;
    const ag = dg < 0 ? -dg : dg;
    const ablue = dblue < 0 ? -dblue : dblue;
    const aalpha = dalpha < 0 ? -dalpha : dalpha;
    const delta = Math.max(ar, ag, ablue, aalpha);

    let r = base, g = base, bl = base;
    if (delta > 0) {
      const boost = Math.min(255, delta * amplify);
      const t = boost / 255;
      r = clamp255(base + boost);
      g = clamp255(base + boost * t);
      bl = clamp255(base + boost * 0.12 * t);
    }
    od[i] = r;
    od[i + 1] = g;
    od[i + 2] = bl;
    od[i + 3] = 255;
  }
  return out;
}
