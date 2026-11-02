/**
 * The compositor.
 *
 * Layer model in one paragraph:
 *  - each layer owns content in *content units*; a 2D affine matrix maps those
 *    units to canvas pixels (render scale applied on top);
 *  - layer masks are stored in content-unit space and applied to content alpha;
 *  - styles expand the content into a padded raster (shadows below, glows and
 *    strokes above) so offsets never clip at the content edge;
 *  - clipping masks (`clipTo`) multiply a layer's alpha by the base layer's
 *    rendered alpha;
 *  - adjustment layers transform the backdrop accumulated so far, respecting
 *    their own mask/clip coverage but never changing backdrop alpha;
 *  - groups render their children into an isolated buffer, then behave like a
 *    single layer (mask, styles, opacity, blend).
 */

import { Raster, parseColor } from './raster.js';
import { sampleMaskBilinear } from './mask.js';
import { layerById, contentSize } from './document.js';
import {
  layerMatrix, invert, multiply, translate, apply, matrixMaxScale,
} from './matrix.js';
import { resolveBlend } from './blend.js';
import { getStyle } from './styles/index.js';
import { getAdjustment } from './adjustments/index.js';
import { getFilter } from './filters/index.js';
import { renderTextLayer, renderShapeLayer } from './vector.js';
import { AshopError } from './errors.js';
import { compositeOver } from './effects.js';
import sharp from 'sharp';

const MAX_CONTENT_CACHE = 48;
const MAX_VECTOR_RATIO = 4;

export class Renderer {
  constructor(assets) {
    this.assets = assets;
    this.contentCache = new Map();
  }

  clearCache() {
    this.contentCache.clear();
  }

  /**
   * Render the document to a canvas raster.
   * @param {object} doc
   * @param {{scale?: number}} [opts]
   * @returns {Promise<Raster>}
   */
  async render(doc, { scale = 1 } = {}) {
    const width = Math.max(1, Math.round(doc.canvas.width * scale));
    const height = Math.max(1, Math.round(doc.canvas.height * scale));
    const canvas = new Raster(width, height);
    if (doc.canvas.background && doc.canvas.background !== 'transparent') {
      canvas.fill(parseColor(doc.canvas.background));
    }
    const ctx = {
      doc,
      scale,
      canvas,
      baseAlpha: new Map(),
      baseAlphaInFlight: new Set(),
    };
    await this.renderLayerList(doc.layers, canvas, ctx);
    return canvas;
  }

  /** Render one layer in isolation onto a transparent canvas (for probing / merge). */
  async renderLayerIsolated(doc, layer, { scale = 1 } = {}) {
    const width = Math.max(1, Math.round(doc.canvas.width * scale));
    const height = Math.max(1, Math.round(doc.canvas.height * scale));
    const canvas = new Raster(width, height);
    const ctx = { doc, scale, canvas, baseAlpha: new Map(), baseAlphaInFlight: new Set() };
    await this.renderLayer(layer, canvas, ctx);
    return canvas;
  }

  async renderLayerList(layers, canvas, ctx) {
    for (const layer of layers) {
      if (layer.visible === false) continue;
      if ((layer.opacity ?? 1) <= 0 && layer.type !== 'adjustment') continue;
      await this.renderLayer(layer, canvas, ctx);
    }
  }

  async renderLayer(layer, canvas, ctx) {
    if (layer.type === 'adjustment') return this.renderAdjustment(layer, canvas, ctx);

    if (layer.type === 'group') {
      const buffer = new Raster(canvas.width, canvas.height);
      await this.renderLayerList(layer.children ?? [], buffer, ctx);
      const styled = this.applyStylesToCanvasSpace(buffer, layer, ctx);
      if (layer.mask) {
        const mask = await this.assets.readMask(layer.mask.assetId);
        this.applyCanvasMask(styled.raster, mask, layer.mask, ctx.scale, styled.ox, styled.oy);
      }
      this.blendIntoCanvas(canvas, styled.raster, {
        matrix: null,
        ratio: 1,
        ox: styled.ox,
        oy: styled.oy,
        padPx: styled.pad,
        opacity: layer.opacity ?? 1,
        blend: layer.blend ?? 'normal',
        clipAlpha: layer.clipTo ? await this.getBaseAlpha(layer.clipTo, ctx) : null,
        mask: null,
      });
      return;
    }

    const { raster, ratio, ox, oy, padPx, contentWidth, contentHeight } = await this.resolveLayerContent(layer, ctx);
    const m = this.canvasMatrix(layer, contentWidth, contentHeight, ctx.scale);
    this.blendIntoCanvas(canvas, raster, {
      matrix: m,
      ratio,
      ox,
      oy,
      padPx,
      contentWidth,
      contentHeight,
      opacity: layer.opacity ?? 1,
      blend: layer.blend ?? 'normal',
      clipAlpha: layer.clipTo ? await this.getBaseAlpha(layer.clipTo, ctx) : null,
      mask: null,
    });
  }

  canvasMatrix(layer, contentWidth, contentHeight, scale) {
    const base = layerMatrix(layer.transform, contentWidth, contentHeight);
    return multiply([scale, 0, 0, scale, 0, 0], base);
  }

  // -------------------------------------------------------------------------
  // Content resolution
  // -------------------------------------------------------------------------

  async resolveLayerContent(layer, ctx) {
    const size = contentSize(layer);
    if (!(size.width > 0) || !(size.height > 0)) {
      throw new AshopError('E_LAYER_EMPTY', `layer ${layer.id} has no content size`, {
        hint: 'text/shape layers need width and height; raster layers need an imported image',
      });
    }
    let source;
    let ratio;
    let basePad = 0;
    if (layer.type === 'raster') {
      source = await this.assets.readRaster(layer.content.assetId);
      ratio = 1;
      const effScale = matrixMaxScale(this.canvasMatrix(layer, size.width, size.height, ctx.scale));
      if (effScale > 0 && effScale < 0.6) {
        const factor = Math.pow(2, Math.floor(Math.log2(1 / effScale)));
        if (factor >= 2) {
          const targetW = Math.max(1, Math.round(source.width / factor));
          const targetH = Math.max(1, Math.round(source.height / factor));
          source = await this.downscale(source, layer.content.assetId, targetW, targetH);
          ratio = source.width / size.width;
        }
      }
    } else if (layer.type === 'text') {
      const effScale = matrixMaxScale(this.canvasMatrix(layer, size.width, size.height, ctx.scale));
      const p = clampRatio(effScale);
      const rendered = await this.renderVectorCached(layer, p, (c) => renderTextLayer(c, p));
      source = rendered.raster;
      // Vector content may carry its own padding (stroke width) outside the
      // content box; keep the content box aligned with ratio/ox.
      ratio = source.width / (size.width + rendered.pad * 2);
      basePad = rendered.pad * ratio;
    } else if (layer.type === 'shape') {
      const effScale = matrixMaxScale(this.canvasMatrix(layer, size.width, size.height, ctx.scale));
      const p = clampRatio(effScale);
      const rendered = await this.renderVectorCached(layer, p, (c) => renderShapeLayer(c, p));
      source = rendered.raster;
      ratio = source.width / (size.width + rendered.pad * 2);
      basePad = rendered.pad * ratio;
    } else {
      throw new AshopError('E_LAYER_TYPE', `layer ${layer.id} (${layer.type}) has no renderable content`);
    }

    const filters = layer.content?.filters ?? [];
    if (filters.length > 0) {
      const key = `flt:${hashContent({ filters, assetId: layer.content?.assetId, type: layer.type })}:${ratio}`;
      const hit = this.contentCache.get(key);
      if (hit) source = hit;
      else {
        let out = source.clone();
        for (const f of filters) {
          const def = getFilter(f.type);
          out = def.apply(out, scaleFilterParams(def, f.params ?? {}, ratio));
        }
        this.remember(key, out);
        source = out;
      }
    }

    // Layer mask (content space) + fill opacity.
    let content = source;
    if (layer.mask) {
      content = content.clone();
      const mask = await this.assets.readMask(layer.mask.assetId);
      applyLocalMask(content, mask, layer.mask, {
        ratio,
        padContent: basePad / ratio,
        width: size.width,
        height: size.height,
      });
    }
    if ((layer.fillOpacity ?? 1) !== 1) {
      if (content === source) content = content.clone();
      const f = Math.max(0, Math.min(1, layer.fillOpacity));
      for (let i = 3; i < content.data.length; i += 4) content.data[i] = content.data[i] * f;
    }

    const styled = this.applyStylesToContent(content, layer, ratio);
    return {
      raster: styled.raster,
      ratio,
      ox: basePad + styled.pad,
      oy: basePad + styled.pad,
      padPx: basePad + styled.pad,
      contentWidth: size.width,
      contentHeight: size.height,
    };
  }

  async downscale(raster, assetId, width, height) {
    const key = `${assetId}:${width}x${height}`;
    const hit = this.contentCache.get(key);
    if (hit) return hit;
    const buf = await sharp(raster.toBuffer(), { raw: { width: raster.width, height: raster.height, channels: 4 } })
      .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer();
    const out = new Raster(width, height, new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength));
    this.remember(key, out);
    return out;
  }

  async renderVectorCached(layer, p, renderFn) {
    const key = `vec:${layer.id}:${p}:${hashContent(layer.content)}`;
    const hit = this.contentCache.get(key);
    if (hit) return hit;
    // Vector renderers return {raster, width, height, pad}: `pad` is content
    // units of extra drawing room (strokes) around the content box.
    const result = await renderFn(layer.content);
    this.remember(key, result);
    return result;
  }

  remember(key, value) {
    this.contentCache.set(key, value);
    while (this.contentCache.size > MAX_CONTENT_CACHE) {
      const first = this.contentCache.keys().next().value;
      this.contentCache.delete(first);
    }
  }

  // -------------------------------------------------------------------------
  // Styles
  // -------------------------------------------------------------------------

  applyStylesToContent(content, layer, ratio) {
    const styles = layer.styles ?? [];
    if (styles.length === 0) return { raster: content, ox: 0, oy: 0, pad: 0 };
    let pad = 0;
    const below = [];
    const above = [];
    for (const style of styles) {
      const def = getStyle(style.type);
      const params = scaleLengths(style.params ?? {}, def.lengthParams ?? [], ratio);
      const out = def.apply(content, params) ?? {};
      if (out.under) { below.push(out.under); pad = Math.max(pad, out.under.pad ?? 0); }
      if (out.over) { above.push(out.over); pad = Math.max(pad, out.over.pad ?? 0); }
    }
    if (pad === 0 && below.length === 0 && above.length === 0) return { raster: content, ox: 0, oy: 0, pad: 0 };
    const w = content.width + pad * 2;
    const h = content.height + pad * 2;
    const out = new Raster(w, h);
    for (const eff of below) compositeAt(out, eff.raster, pad - (eff.pad ?? 0), pad - (eff.pad ?? 0));
    compositeAt(out, content, pad, pad);
    for (const eff of above) compositeAt(out, eff.raster, pad - (eff.pad ?? 0), pad - (eff.pad ?? 0));
    // The content box sits at (pad, pad) inside the styled raster.
    return { raster: out, ox: pad, oy: pad, pad };
  }

  applyStylesToCanvasSpace(buffer, layer, ctx) {
    // Group buffers are already in render-pixel space, so ratio = 1.
    const styled = this.applyStylesToContent(buffer, layer, 1);
    return styled;
  }

  applyCanvasMask(raster, mask, maskRef, scale, ox = 0, oy = 0) {
    const inverted = Boolean(maskRef.inverted);
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const mx = (x - ox) / scale;
        const my = (y - oy) / scale;
        let v = sampleMaskBilinear(mask, mx - 0.5, my - 0.5);
        if (inverted) v = 255 - v;
        const i = (y * raster.width + x) * 4 + 3;
        raster.data[i] = (raster.data[i] * v) / 255;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Base alpha for clipping layers
  // -------------------------------------------------------------------------

  async getBaseAlpha(layerId, ctx) {
    if (ctx.baseAlpha.has(layerId)) return ctx.baseAlpha.get(layerId);
    if (ctx.baseAlphaInFlight.has(layerId)) return null; // cyclic clip guard
    const layer = layerById(ctx.doc, layerId)?.layer;
    if (!layer) return null;
    ctx.baseAlphaInFlight.add(layerId);
    try {
      const buffer = new Raster(ctx.canvas.width, ctx.canvas.height);
      const isolated = { ...ctx, canvas: buffer, baseAlpha: new Map(), baseAlphaInFlight: new Set() };
      if (layer.type === 'group') {
        const inner = new Raster(ctx.canvas.width, ctx.canvas.height);
        await this.renderLayerList(layer.children ?? [], inner, isolated);
        const styled = (layer.styles ?? []).length
          ? this.applyStylesToContent(inner, layer, 1)
          : { raster: inner, ox: 0, oy: 0 };
        compositeAt(buffer, styled.raster, styled.ox, styled.oy);
      } else if (layer.type === 'adjustment') {
        // An adjustment layer's alpha mask is its coverage; approximate with full alpha.
        buffer.fill([255, 255, 255, 255]);
      } else {
        const { raster, ratio, ox, oy, padPx, contentWidth, contentHeight } = await this.resolveLayerContent(layer, isolated);
        const m = this.canvasMatrix(layer, contentWidth, contentHeight, ctx.scale);
        drawToBuffer(buffer, raster, m, {
          ratio, ox, oy, padPx, contentWidth, contentHeight,
          opacity: layer.opacity ?? 1,
          blend: 'normal',
          clipAlpha: null,
        });
      }
      // Feed the base alpha back as a plain coverage buffer.
      const alpha = new Uint8ClampedArray(ctx.canvas.width * ctx.canvas.height);
      for (let i = 0, j = 0; i < buffer.data.length; i += 4, j++) alpha[j] = buffer.data[i + 3];
      ctx.baseAlpha.set(layerId, alpha);
      return alpha;
    } finally {
      ctx.baseAlphaInFlight.delete(layerId);
    }
  }

  // -------------------------------------------------------------------------
  // Adjustment layers
  // -------------------------------------------------------------------------

  async renderAdjustment(layer, canvas, ctx) {
    if ((layer.opacity ?? 1) <= 0) return;
    const content = layer.content ?? {};
    const def = getAdjustment(content.adjustment);
    const adjustment = def.create(content.params ?? {});
    const mask = layer.mask ? await this.assets.readMask(layer.mask.assetId) : null;
    const clipAlpha = layer.clipTo ? await this.getBaseAlpha(layer.clipTo, ctx) : null;
    const opacity = Math.max(0, Math.min(1, layer.opacity ?? 1));
    const blend = resolveBlend(layer.blend ?? 'normal');
    const w = canvas.width;
    const d = canvas.data;
    const cb = new Float64Array(3);
    const cs = new Float64Array(3);
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let cover = 1;
        if (mask) {
          let mv = sampleMaskBilinear(mask, x / ctx.scale - 0.5, y / ctx.scale - 0.5);
          if (layer.mask.inverted) mv = 255 - mv;
          cover *= mv / 255;
        }
        if (clipAlpha) cover *= clipAlpha[y * w + x] / 255;
        cover *= opacity;
        if (cover <= 0) continue;
        if (d[i + 3] === 0) continue;
        adjustment.map(d[i], d[i + 1], d[i + 2], cs);
        if (blend.separable) {
          for (let c = 0; c < 3; c++) {
            cb[c] = d[i + c] / 255;
            const target = blend.f(cb[c], cs[c] / 255);
            d[i + c] = (d[i + c] * (1 - cover) + target * 255 * cover);
          }
        } else {
          for (let c = 0; c < 3; c++) cb[c] = d[i + c] / 255;
          const src = new Float64Array([cs[0] / 255, cs[1] / 255, cs[2] / 255]);
          const out = new Float64Array(3);
          blend.f3(out, cb, src);
          for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * (1 - cover) + out[c] * 255 * cover;
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Canvas blending
  // -------------------------------------------------------------------------

  blendIntoCanvas(canvas, src, opts) {
    drawToBuffer(canvas, src, opts.matrix, opts);
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

function clampRatio(v, source) {
  let p = Number.isFinite(v) && v > 0 ? v : 1;
  p = Math.max(0.05, Math.min(MAX_VECTOR_RATIO, p));
  return p;
}

function hashContent(content) {
  return JSON.stringify(content);
}

function scaleLengths(params, keys, factor) {
  if (!keys || keys.length === 0) return params;
  const out = { ...params };
  for (const key of keys) {
    if (out[key] != null && Number.isFinite(Number(out[key]))) out[key] = Number(out[key]) * factor;
  }
  return out;
}

/** Scale a filter's pixel-length parameters into raster pixels. */
function scaleFilterParams(def, params, ratio) {
  if (ratio === 1) return params;
  let out = scaleLengths(params, def.lengthParams ?? [], ratio);
  if (def.scaleOps && Array.isArray(out.ops)) {
    out = {
      ...out,
      ops: out.ops.map((op) => {
        const scaled = { ...op };
        for (const key of ['x', 'y', 'radius', 'dx', 'dy']) {
          if (scaled[key] != null && Number.isFinite(Number(scaled[key]))) scaled[key] = Number(scaled[key]) * ratio;
        }
        return scaled;
      }),
    };
  }
  return out;
}

function applyLocalMask(content, mask, maskRef, { ratio = 1, padContent = 0, width, height } = {}) {
  const inverted = Boolean(maskRef.inverted);
  const w = width ?? content.width;
  const h = height ?? content.height;
  for (let y = 0; y < content.height; y++) {
    for (let x = 0; x < content.width; x++) {
      // Raster pixel -> content-unit coordinates (the raster may be padded).
      const u = x / ratio - padContent;
      const v = y / ratio - padContent;
      const di = (y * content.width + x) * 4 + 3;
      if (u < 0 || v < 0 || u > w || v > h) {
        content.data[di] = 0;
        continue;
      }
      const mu = (u / w) * mask.width;
      const mv = (v / h) * mask.height;
      let value = sampleMaskBilinear(mask, mu - 0.5, mv - 0.5);
      if (inverted) value = 255 - value;
      content.data[di] = (content.data[di] * value) / 255;
    }
  }
}

/**
 * Canvas-space bounds of a content rectangle expanded by `pad` content units.
 * Used to iterate over pixels that styles/strokes may draw outside the box.
 */
function expandedMatrixBounds(m, width, height, pad) {
  const pts = [
    apply(m, -pad, -pad),
    apply(m, width + pad, -pad),
    apply(m, -pad, height + pad),
    apply(m, width + pad, height + pad),
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return {
    x: Math.floor(minX),
    y: Math.floor(minY),
    width: Math.ceil(maxX) - Math.floor(minX),
    height: Math.ceil(maxY) - Math.floor(minY),
  };
}

function compositeAt(dst, src, x, y) {
  for (let sy = 0; sy < src.height; sy++) {
    const dy = y + sy;
    if (dy < 0 || dy >= dst.height) continue;
    for (let sx = 0; sx < src.width; sx++) {
      const dx = x + sx;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (sy * src.width + sx) * 4;
      if (src.data[si + 3] === 0) continue;
      const di = (dy * dst.width + dx) * 4;
      const sa = src.data[si + 3] / 255;
      const da = dst.data[di + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) continue;
      dst.data[di] = (src.data[si] * sa + dst.data[di] * da * (1 - sa)) / oa;
      dst.data[di + 1] = (src.data[si + 1] * sa + dst.data[di + 1] * da * (1 - sa)) / oa;
      dst.data[di + 2] = (src.data[si + 2] * sa + dst.data[di + 2] * da * (1 - sa)) / oa;
      dst.data[di + 3] = oa * 255;
    }
  }
}

/**
 * Composite `src` into `dst` through an affine transform.
 * When matrix is null the source is drawn 1:1 at (0,0).
 */
function drawToBuffer(dst, src, matrix, opts) {
  const {
    ratio = 1, ox = 0, oy = 0, padPx = 0, contentWidth, contentHeight,
    opacity = 1, blend = 'normal', clipAlpha = null, mask = null,
  } = opts;
  const mode = resolveBlend(blend);
  const dw = dst.width, dh = dst.height;
  const d = dst.data;

  const cw = contentWidth ?? src.width / ratio;
  const ch = contentHeight ?? src.height / ratio;
  // Extra drawing room around the content box, expressed in content units.
  const padContent = padPx / ratio;
  const uMin = -padContent;
  const vMin = -padContent;
  const uMax = cw + padContent;
  const vMax = ch + padContent;

  let x0 = 0, y0 = 0, x1 = dw, y1 = dh;
  let inv = null;
  if (matrix) {
    const b = expandedMatrixBounds(matrix, cw, ch, padContent);
    x0 = Math.max(0, b.x);
    y0 = Math.max(0, b.y);
    x1 = Math.min(dw, b.x + b.width);
    y1 = Math.min(dh, b.y + b.height);
    inv = invert(matrix);
    if (!inv) return;
  }
  if (x1 <= x0 || y1 <= y0) return;

  const cb = new Float64Array(3);
  const cs = new Float64Array(3);
  const bo = new Float64Array(3);

  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      let u, v;
      if (matrix) {
        const cx = px + 0.5, cy = py + 0.5;
        u = inv[0] * cx + inv[2] * cy + inv[4];
        v = inv[1] * cx + inv[3] * cy + inv[5];
        if (u < uMin || v < vMin || u > uMax || v > vMax) continue;
      } else {
        u = px + 0.5;
        v = py + 0.5;
      }
      const sx = u * ratio + ox - 0.5;
      const sy = v * ratio + oy - 0.5;
      if (sx < -1 || sy < -1 || sx > src.width || sy > src.height) continue;
      const sample = src.sampleBilinear(sx, sy);
      let sa = sample[3];
      if (sa === 0) continue;
      if (clipAlpha) {
        const ca = clipAlpha[py * dw + px];
        if (ca === 0) continue;
        sa = (sa * ca) / 255;
      }
      if (mask) {
        const mu = (u / cw) * mask.width - 0.5;
        const mv = (v / ch) * mask.height - 0.5;
        sa = (sa * sampleMaskBilinear(mask, mu, mv)) / 255;
      }
      const alpha = (sa / 255) * opacity;
      if (alpha <= 0) continue;

      const di = (py * dw + px) * 4;
      const da = d[di + 3] / 255;
      const oa = alpha + da * (1 - alpha);
      if (oa <= 0) continue;

      if (mode.separable) {
        for (let c = 0; c < 3; c++) {
          cb[c] = d[di + c] / 255;
          const outC = (alpha * (1 - da) * (sample[c] / 255)
            + alpha * da * mode.f(cb[c], sample[c] / 255)
            + (1 - alpha) * da * cb[c]) / oa;
          d[di + c] = outC * 255;
        }
      } else {
        for (let c = 0; c < 3; c++) {
          cb[c] = d[di + c] / 255;
          cs[c] = sample[c] / 255;
        }
        mode.f3(bo, cb, cs);
        for (let c = 0; c < 3; c++) {
          const outC = (alpha * (1 - da) * cs[c] + alpha * da * bo[c] + (1 - alpha) * da * cb[c]) / oa;
          d[di + c] = outC * 255;
        }
      }
      d[di + 3] = oa * 255;
    }
  }
}
