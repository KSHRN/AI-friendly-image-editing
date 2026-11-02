/**
 * Content-space layer cropping.
 *
 * A crop rect is expressed in the layer's *content space* (for raster layers
 * that is source-pixel space). The pixels inside the rect are baked into a new
 * content-addressed asset, so every downstream consumer (filters, masks,
 * merge-down, export) simply sees the cropped content.
 *
 * The original asset, size and mask are kept in `content.original`, which makes
 * the operation reversible with `layer.crop --reset` even before/without a
 * history checkout. The previous asset is never deleted from the bundle, so
 * history snapshots that still point at it keep working.
 *
 * Placement follows the ImageMagick/Pillow convention by default: the crop box
 * becomes the new content origin, and the layer transform is left untouched —
 * a layer imported at (0,0) shows the cropped region at (0,0). Pass
 * `keepPosition` to instead keep the cropped pixels at their old canvas
 * position (adjusts the layer's normalized anchor).
 */

import { findLayer, touch } from './document.js';
import { Mask } from './mask.js';
import { fail } from './errors.js';
import { parseRect } from './units.js';

/**
 * Crop one raster layer in content space.
 *
 * @param {import('./session.js').Session} session
 * @param {string} ref layer id or name
 * @param {string|object} rect "x,y,w,h" or {x,y,width,height} (content units)
 * @param {{reset?: boolean, keepPosition?: boolean}} [opts]
 */
export async function cropLayer(session, ref, rect, { reset = false, keepPosition = false } = {}) {
  const { layer } = findLayer(session.doc, ref);
  if (layer.type !== 'raster') {
    fail('E_UNSUPPORTED', `layer ${layer.id} is a ${layer.type} layer`, {
      hint: 'layer.crop works on raster layers; merge the artwork into a raster layer first',
    });
  }
  if (reset) return resetCrop(session, layer);
  if (rect == null) {
    fail('E_USAGE', 'layer.crop needs --rect (or --reset)', {
      hint: 'e.g. --rect "0,0,400,300" in layer content units',
    });
  }

  const content = layer.content ?? {};
  const contentWidth = Math.max(1, Math.round(Number(content.width)));
  const contentHeight = Math.max(1, Math.round(Number(content.height)));
  if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight) || contentWidth <= 0 || contentHeight <= 0) {
    fail('E_LAYER_EMPTY', `layer ${layer.id} has no content size`, { hint: 'import an image before cropping it' });
  }
  const box = normalizeRect(rect, contentWidth, contentHeight);

  const source = await session.assets.readRaster(content.assetId);
  const croppedRaster = extractRaster(source, box, contentWidth, contentHeight);
  const stored = await session.assets.putRaster(croppedRaster);

  // Masks are content-space; crop them with the same box so later selection /
  // masking math keeps matching the new content box.
  const previousMask = layer.mask ? { ...layer.mask } : null;
  let nextMask = previousMask;
  if (previousMask) {
    const fullMask = await session.assets.readMask(previousMask.assetId);
    const croppedMask = extractMask(fullMask, box, contentWidth, contentHeight);
    const storedMask = await session.assets.putMask(croppedMask);
    nextMask = { ...previousMask, assetId: storedMask.hash };
  }

  const original = content.original ?? {
    assetId: content.assetId,
    width: contentWidth,
    height: contentHeight,
    mask: previousMask,
    anchorX: layer.transform?.anchorX ?? 0,
    anchorY: layer.transform?.anchorY ?? 0,
  };
  const croppedFrom = {
    x: (content.crop?.x ?? 0) + box.x,
    y: (content.crop?.y ?? 0) + box.y,
    width: box.width,
    height: box.height,
    sourceWidth: original.width,
    sourceHeight: original.height,
  };

  layer.content = {
    ...content,
    // New asset + new content box: the cropped pixels are the content now.
    assetId: stored.hash,
    width: box.width,
    height: box.height,
    crop: croppedFrom,
    original,
  };
  layer.mask = nextMask;

  if (keepPosition) {
    // Keep the cropped pixels where they were: the normalized anchor moves by
    // the crop offset, which is exact for rotation/skew too.
    const t = layer.transform;
    const ax = (t.anchorX ?? 0) * contentWidth;
    const ay = (t.anchorY ?? 0) * contentHeight;
    t.anchorX = (ax - box.x) / box.width;
    t.anchorY = (ay - box.y) / box.height;
    original.positionAdjusted = true;
  }

  touch(session.doc);
  session.markDirty();
  session.renderer.clearCache();
  return {
    layer,
    crop: { ...box },
    contentSize: { width: box.width, height: box.height },
    sourceSize: { width: contentWidth, height: contentHeight },
    originalSize: { width: original.width, height: original.height },
    keptPosition: keepPosition,
    resetAvailable: true,
  };
}

/** Restore the pre-crop asset, size, mask and anchor. */
function resetCrop(session, layer) {
  const content = layer.content ?? {};
  const original = content.original;
  if (!original) {
    fail('E_CROP_MISSING', `layer ${layer.id} has no crop to reset`, {
      hint: 'crop it first with `layer.crop <layer> --rect x,y,w,h`',
    });
  }
  const next = { ...content, assetId: original.assetId, width: original.width, height: original.height };
  delete next.crop;
  delete next.original;
  layer.content = next;
  layer.mask = original.mask ? { ...original.mask } : null;

  // Only keepPosition crops touched the normalized anchor; restore it then so
  // the pre-crop placement is exact again. A later, deliberate transform edit
  // is left alone when the crop never moved the anchor.
  if (original.positionAdjusted) {
    const t = layer.transform;
    t.anchorX = original.anchorX ?? 0;
    t.anchorY = original.anchorY ?? 0;
  }

  touch(session.doc);
  session.markDirty();
  session.renderer.clearCache();
  return {
    layer,
    reset: true,
    contentSize: { width: original.width, height: original.height },
    originalSize: { width: original.width, height: original.height },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamp a caller rect to `cw x ch` content units; throw when nothing is left. */
function normalizeRect(input, cw, ch) {
  let rect;
  try {
    rect = parseRect(input);
  } catch (err) {
    if (err?.code === 'E_USAGE') throw err;
    fail('E_USAGE', `invalid --rect: ${input}`, { hint: 'use "x,y,w,h", e.g. "0,0,400,300"' });
  }
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
    fail('E_USAGE', `invalid --rect: ${input}`, { hint: 'use four numbers "x,y,w,h" in content units' });
  }
  if (!(rect.width > 0) || !(rect.height > 0)) {
    fail('E_USAGE', `crop width and height must be positive, got ${rect.width}x${rect.height}`);
  }
  const x0 = clamp(Math.round(rect.x), 0, cw);
  const y0 = clamp(Math.round(rect.y), 0, ch);
  const x1 = clamp(Math.round(rect.x + rect.width), 0, cw);
  const y1 = clamp(Math.round(rect.y + rect.height), 0, ch);
  if (x1 <= x0 || y1 <= y0) {
    fail('E_CROP_EMPTY', 'crop rect does not overlap the layer content', {
      hint: `content is ${cw}x${ch} content units; pass an overlapping --rect "x,y,w,h"`,
    });
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Crop the full source raster to the content-space box (1:1 for raster layers). */
function extractRaster(source, box, cw, ch) {
  const sx0 = clamp(Math.round((box.x / cw) * source.width), 0, source.width - 1);
  const sy0 = clamp(Math.round((box.y / ch) * source.height), 0, source.height - 1);
  const sx1 = clamp(Math.round(((box.x + box.width) / cw) * source.width), sx0 + 1, source.width);
  const sy1 = clamp(Math.round(((box.y + box.height) / ch) * source.height), sy0 + 1, source.height);
  return source.crop(sx0, sy0, sx1 - sx0, sy1 - sy0);
}

function extractMask(mask, box, cw, ch) {
  const mx0 = clamp(Math.round((box.x / cw) * mask.width), 0, mask.width - 1);
  const my0 = clamp(Math.round((box.y / ch) * mask.height), 0, mask.height - 1);
  const mx1 = clamp(Math.round(((box.x + box.width) / cw) * mask.width), mx0 + 1, mask.width);
  const my1 = clamp(Math.round(((box.y + box.height) / ch) * mask.height), my0 + 1, mask.height);
  const out = new Mask(mx1 - mx0, my1 - my0);
  for (let y = 0; y < out.height; y++) {
    const from = (my0 + y) * mask.width + mx0;
    out.data.set(mask.data.subarray(from, from + out.width), y * out.width);
  }
  return out;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
