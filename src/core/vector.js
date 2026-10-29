/**
 * Vector and text rasterisation.
 *
 * Everything vector goes through SVG -> resvg -> RGBA raster. Text is turned
 * into outline paths first (see text.js), so no font matching happens inside
 * the rasteriser.
 */

import { Resvg } from '@resvg/resvg-js';
import { decodeToRaster } from './codec.js';
import { Raster } from './raster.js';
import { buildTextContent } from './text.js';
import { AshopError } from './errors.js';

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
  const { svg, width, height, layout } = buildTextContent(content, ratio);
  const raster = await rasterizeSvg(svg);
  if (raster.width !== Math.max(1, Math.round(width * ratio)) || raster.height !== Math.max(1, Math.round(height * ratio))) {
    // resvg rounds sub-pixel sizes; the raster is still the right box.
  }
  return { raster, width, height, layout };
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function shapeElement(shape) {
  switch (shape.kind) {
    case 'rect': {
      const radius = num(shape.radius);
      const rx = radius > 0 ? ` rx="${radius}" ry="${radius}"` : '';
      return `<rect x="${num(shape.x)}" y="${num(shape.y)}" width="${num(shape.width)}" height="${num(shape.height)}"${rx}/>`;
    }
    case 'ellipse':
      return `<ellipse cx="${num(shape.cx)}" cy="${num(shape.cy)}" rx="${num(shape.rx)}" ry="${num(shape.ry)}"/>`;
    case 'polygon': {
      const pts = (shape.points ?? []).map((p) => `${num(p.x ?? p[0])},${num(p.y ?? p[1])}`).join(' ');
      return `<polygon points="${pts}"/>`;
    }
    case 'path':
      return `<path d="${String(shape.d ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"${shape.fillRule ? ` fill-rule="${shape.fillRule}"` : ''}/>`;
    default:
      throw new AshopError('E_USAGE', `unknown shape kind: ${shape.kind}`, { hint: 'use rect, ellipse, polygon or path' });
  }
}

export function shapeToSvg(content, ratio = 1) {
  const w = Math.max(1, Math.ceil(num(content.width, 1)));
  const h = Math.max(1, Math.ceil(num(content.height, 1)));
  const shapes = Array.isArray(content.shapes) ? content.shapes : [];
  if (shapes.length === 0) throw new AshopError('E_USAGE', 'shape layer has no shapes');
  const el = shapes.map(shapeElement).join('');
  const fill = content.fill ?? null;
  const stroke = content.stroke ?? null;
  let attrs = '';
  if (fill) attrs += ` fill="${fill}"`;
  else attrs += ' fill="none"';
  if (stroke && num(stroke.width) > 0) {
    attrs += ` stroke="${stroke.color ?? '#000000'}" stroke-width="${num(stroke.width)}"`;
    attrs += ` stroke-linejoin="${stroke.lineJoin ?? 'miter'}" stroke-linecap="${stroke.lineCap ?? 'butt'}"`;
    if (stroke.dash) attrs += ` stroke-dasharray="${stroke.dash}"`;
  }
  const group = shapes.length === 1 ? `<g${attrs}>${el}</g>` : `<g${attrs}>${el}</g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * ratio}" height="${h * ratio}" viewBox="0 0 ${w} ${h}">${group}</svg>`;
  return { svg, width: w, height: h };
}

/** Rasterise a shape layer content object. */
export async function renderShapeLayer(content, ratio = 1) {
  const { svg, width, height } = shapeToSvg(content, ratio);
  const raster = await rasterizeSvg(svg);
  return { raster, width, height };
}

/** Compose SVG for a raster layer's content? Not used; kept for extensions. */
export function emptyRaster(width, height) {
  return new Raster(width, height);
}
