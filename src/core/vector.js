/**
 * Vector and text rasterisation.
 *
 * Everything vector goes through SVG -> resvg -> RGBA raster. Text is turned
 * into outline paths first (see text.js), so no font matching happens inside
 * the rasteriser.
 *
 * Shape layers are drawn object by object: each object emits one SVG element
 * per fill and then one per stroke, which is what allows a paint stack
 * (multiple fills/strokes) and per-object opacity/transform without the
 * compositor needing to know anything about paint.
 */

import { Resvg } from '@resvg/resvg-js';
import { decodeToRaster } from './codec.js';
import { Raster } from './raster.js';
import { buildTextContent } from './text.js';
import { AshopError } from './errors.js';
import { normalizeShapeContent, shapeGeometryElement, wrapShapeElements } from './shapes.js';
import { paintAttributes, fmtNumber } from './paint.js';

const MAX_RASTER_SIDE = 16384;

export async function rasterizeSvg(svg, { width, height } = {}) {
  let img;
  try {
    const resvg = new Resvg(svg, {
      background: 'transparent',
      fitTo: { mode: 'original' },
      logLevel: 'error',
    });
    img = resvg.render();
  } catch (err) {
    throw new AshopError('E_RENDER', `SVG rasterisation failed: ${err.message}`, { cause: err });
  }
  if (img.width > MAX_RASTER_SIDE || img.height > MAX_RASTER_SIDE) {
    throw new AshopError('E_RENDER', `vector raster too large: ${img.width}x${img.height}`, {
      hint: `keep each side <= ${MAX_RASTER_SIDE}px; reduce layer scale or text size`,
    });
  }
  const raster = await decodeToRaster(img.asPng());
  return raster;
}

/** Rasterise a text layer content object at `ratio` pixels per content unit. */
export async function renderTextLayer(content, ratio = 1) {
  const { svg, width, height, pad, layout } = buildTextContent(content, ratio);
  const raster = await rasterizeSvg(svg);
  return { raster, width, height, pad, layout };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const r = (v) => Math.round(v * 100) / 100;

/**
 * Extra drawing room (content units) needed so centred strokes are not clipped
 * at the content box edge.
 */
export function shapePadding(content) {
  const c = normalizeShapeContent(content);
  let maxWidth = 0;
  for (const shape of c.shapes ?? []) {
    const strokes = shape.strokes ?? c.strokes ?? [];
    for (const stroke of strokes) maxWidth = Math.max(maxWidth, num(stroke.width));
  }
  return maxWidth > 0 ? Math.ceil(maxWidth / 2) + 1 : 0;
}

/**
 * Build the SVG document for a shape layer.
 *
 * The output is deterministic: gradient ids, number formatting and element
 * order are all derived from the content, so identical documents keep
 * rendering to identical pixels.
 */
export function shapeToSvg(content, ratio = 1, { pad = null } = {}) {
  const c = normalizeShapeContent(content);
  const w = Math.max(1, Math.ceil(num(c.width, 1)));
  const h = Math.max(1, Math.ceil(num(c.height, 1)));
  const shapes = Array.isArray(c.shapes) ? c.shapes : [];
  if (shapes.length === 0) throw new AshopError('E_USAGE', 'shape layer has no shapes');
  const p = pad == null ? shapePadding(c) : Math.max(0, num(pad));

  const defs = [];
  const body = [];

  shapes.forEach((shape, si) => {
    const fills = shape.fills ?? c.fills ?? [];
    const strokes = shape.strokes ?? c.strokes ?? [];
    const elements = [];

    // Fills first, in draw order (bottom of the stack first).
    fills.forEach((paint, pi) => {
      if (!paint) return;
      const attrs = paintAttributes('fill', paint, `f${si}_${pi}`, defs);
      elements.push(shapeGeometryElement(shape, attrs));
    });

    // Then strokes on top of every fill.
    strokes.forEach((stroke, si2) => {
      if (!stroke || !stroke.paint) return;
      const attrs = paintAttributes('stroke', stroke.paint, `s${si}_${si2}`, defs);
      let extra = ` fill="none" stroke-width="${fmtNumber(stroke.width)}"`;
      extra += ` stroke-linecap="${stroke.lineCap}" stroke-linejoin="${stroke.lineJoin}"`;
      if (stroke.lineJoin === 'miter' && stroke.miterLimit !== 4) {
        extra += ` stroke-miterlimit="${fmtNumber(stroke.miterLimit)}"`;
      }
      if (stroke.dash) {
        extra += ` stroke-dasharray="${stroke.dash.map((v) => fmtNumber(v)).join(' ')}"`;
        if (stroke.dashOffset) extra += ` stroke-dashoffset="${fmtNumber(stroke.dashOffset)}"`;
      }
      elements.push(shapeGeometryElement(shape, attrs + extra));
    });

    body.push(wrapShapeElements(shape, elements));
  });

  const defsText = defs.length ? `<defs>${defs.join('')}</defs>` : '';
  const vw = w + p * 2;
  const vh = h + p * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r(vw * ratio)}" height="${r(vh * ratio)}" viewBox="${-p} ${-p} ${vw} ${vh}">${defsText}${body.join('')}</svg>`;
  return { svg, width: w, height: h, pad: p };
}

/** Alias used by the SVG export command. */
export const buildShapeSvg = shapeToSvg;

/** Rasterise a shape layer content object. */
export async function renderShapeLayer(content, ratio = 1) {
  const { svg, width, height, pad } = shapeToSvg(content, ratio);
  const raster = await rasterizeSvg(svg);
  return { raster, width, height, pad };
}

/** Compose SVG for a raster layer's content? Not used; kept for extensions. */
export function emptyRaster(width, height) {
  return new Raster(width, height);
}
