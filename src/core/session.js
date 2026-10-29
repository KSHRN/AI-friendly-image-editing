/**
 * Session = the stateful engine.
 *
 * A session owns one document, its asset store and a renderer. Every mutation
 * goes through a method here so that (a) the document stays valid, (b) the
 * project can autosave, and (c) the CLI/daemon/batch runner all behave the
 * same way.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Raster, parseColor, colorToHex } from './raster.js';
import { Mask, sampleMaskBilinear } from './mask.js';
import {
  createDocument, makeLayer, insertLayer, findLayer, detachLayer, moveLayer,
  listLayers, contentSize, touch, validateDocument, walkLayers, layerById, defaultTransform, nextLayerId,
} from './document.js';
import { layerMatrix, invert as invertMatrix, apply, matrixBounds } from './matrix.js';
import {
  rectMask, ellipseMask, polygonMask, pathMask, colorRangeMask,
  luminanceMask, alphaMask, floodFillMask,
} from './rasterize.js';
import { combine, invertMask, featherMask, growMask, shrinkMask, borderMask } from './maskops.js';
import { decodeFile, decodeToRaster, detectMediaType, encodeRaster, encodeMaskPng, sha256Hex } from './codec.js';
import { Renderer } from './composite.js';
import { getFilter } from './filters/index.js';
import { getAdjustment } from './adjustments/index.js';
import { getStyle } from './styles/index.js';
import { measureText } from './text.js';
import {
  commit, log as historyLog, checkout as historyCheckout, createBranch,
  resetHard, isDirty, branches, diffDocuments, resolveRef, headCommit,
} from './history.js';
import { Project } from './project.js';
import { AshopError, fail } from './errors.js';
import sharp from 'sharp';

const ALIGNMENTS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

export class Session {
  constructor({ project = null, doc, assets }) {
    this.project = project;
    this.doc = doc;
    this.assets = assets;
    this.renderer = new Renderer(assets);
  }

  static async createProject(dir, { width, height, background = 'transparent', name } = {}) {
    const doc = createDocument({ width, height, background, name });
    const project = await Project.create(dir, doc, { name });
    return new Session({ project, doc: project.doc, assets: project.assets });
  }

  static async open(dir) {
    const project = await Project.open(dir);
    return new Session({ project, doc: project.doc, assets: project.assets });
  }

  // -------------------------------------------------------------------------
  // Persistence / metadata
  // -------------------------------------------------------------------------

  get projectPath() {
    return this.project ? this.project.dir : null;
  }

  markDirty() {
    if (this.project) this.project.dirty = true;
  }

  async save() {
    if (!this.project) return;
    this.project.doc = this.doc;
    await this.project.save();
  }

  async reloadFresh() {
    this.renderer.clearCache();
  }

  summary() {
    const sel = this.doc.selection;
    const layers = listLayers(this.doc);
    return {
      project: this.projectPath,
      name: this.doc.name,
      canvas: this.doc.canvas,
      colorSpace: this.doc.colorSpace,
      rev: this.doc.rev,
      layers,
      layerCount: layers.length,
      selection: sel ? { width: sel.width, height: sel.height } : null,
      history: this.project
        ? {
          head: this.project.history.head,
          branch: this.project.history.currentBranch,
          branches: branches(this.project.history),
          dirty: isDirty(this.project.history, this.doc),
        }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // Layer creation
  // -------------------------------------------------------------------------

  insertNewLayer(layer, { zIndex = null, parentId = null, aboveId = null } = {}) {
    if (aboveId) {
      const above = findLayer(this.doc, aboveId);
      const siblings = above.parent ? above.parent.children : this.doc.layers;
      insertLayer(this.doc, layer, { parentId: above.parent ? above.parent.id : null, index: above.index + 1 });
    } else {
      insertLayer(this.doc, layer, { parentId, index: zIndex });
    }
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  async importImage({
    file, buffer, name, fit = 'none', align = 'center', scale = 1,
    at = null, rotation = 0, zIndex = null, parentId = null, opacity = 1,
    blend = 'normal',
  } = {}) {
    let bytes;
    let mediaType;
    if (buffer) {
      bytes = buffer;
      const detected = detectMediaType(bytes);
      mediaType = detected ? detected.mediaType : 'image/png';
    } else if (file) {
      try {
        bytes = await readFile(path.resolve(file));
      } catch (err) {
        fail('E_FILE_NOT_FOUND', `cannot read image: ${file}`, { hint: 'check the path', cause: err });
      }
      const detected = detectMediaType(bytes);
      if (!detected) fail('E_DECODE', `unsupported image format: ${file}`, { hint: 'use PNG, JPEG, WebP, GIF, TIFF or BMP' });
      mediaType = detected.mediaType;
    } else {
      fail('E_USAGE', 'importImage needs a file or buffer');
    }
    const raster = await decodeToRaster(bytes);
    const stored = await this.assets.put(bytes, mediaType);

    const stage = this.doc.canvas;
    let sx = 1, sy = 1;
    if (fit === 'contain') {
      const s = Math.min(stage.width / raster.width, stage.height / raster.height);
      sx = sy = s;
    } else if (fit === 'cover') {
      const s = Math.max(stage.width / raster.width, stage.height / raster.height);
      sx = sy = s;
    } else if (fit === 'stretch') {
      sx = stage.width / raster.width;
      sy = stage.height / raster.height;
    } else if (fit !== 'none') {
      fail('E_USAGE', `unknown fit: ${fit}`, { hint: 'use none, contain, cover or stretch' });
    }
    sx *= scale;
    sy *= scale;

    const width = raster.width;
    const height = raster.height;
    let x, y;
    if (at) {
      x = at.x;
      y = at.y;
    } else {
      ({ x, y } = placeAligned(stage, width * sx, height * sy, align));
    }
    const layer = makeLayer('raster', {
      name: name ?? (file ? path.basename(file) : 'Image'),
      opacity,
      blend,
      transform: { ...defaultTransform(), x, y, scaleX: sx, scaleY: sy, rotation },
      content: { type: 'raster', assetId: stored.hash, width, height, filters: [] },
    });
    return this.insertNewLayer(layer, { zIndex, parentId });
  }

  addFillLayer({ color = '#ffffff', name = 'Fill', zIndex = null, opacity = 1, blend = 'normal' } = {}) {
    const layer = makeLayer('shape', {
      name,
      opacity,
      blend,
      content: {
        type: 'shape',
        width: this.doc.canvas.width,
        height: this.doc.canvas.height,
        shapes: [{ kind: 'rect', x: 0, y: 0, width: this.doc.canvas.width, height: this.doc.canvas.height }],
        fill: color,
        stroke: null,
        filters: [],
      },
    });
    return this.insertNewLayer(layer, { zIndex });
  }

  addTextLayer({
    text, font = 'Segoe UI', fontFile, size = 72, color = '#000000',
    x = 0, y = 0, width = 0, align = 'left', lineHeight = 1.2, letterSpacing = 0,
    stroke = null, weight = 400, italic = false, name, zIndex = null, opacity = 1,
    blend = 'normal', rotation = 0,
  } = {}) {
    const content = {
      type: 'text',
      text: String(text ?? ''),
      font,
      fontFile: fontFile ?? undefined,
      size,
      color,
      align,
      lineHeight,
      letterSpacing,
      width: width || 0,
      height: 1,
      stroke,
      weight,
      italic,
      filters: [],
    };
    const measured = measureText(content);
    content.width = width > 0 ? width : Math.max(1, measured.width);
    content.height = Math.max(1, measured.height);
    const layer = makeLayer('text', {
      name: name ?? firstLine(content.text) ?? 'Text',
      opacity,
      blend,
      transform: { ...defaultTransform(), x, y, rotation },
      content,
    });
    return this.insertNewLayer(layer, { zIndex });
  }

  addShapeLayer({
    shapes, width, height, fill = '#ff0055', stroke = null,
    name = 'Shape', x = 0, y = 0, zIndex = null, opacity = 1, blend = 'normal', rotation = 0,
  } = {}) {
    if (!Array.isArray(shapes) || shapes.length === 0) fail('E_USAGE', 'shape layer needs at least one shape');
    const box = { width: Math.max(1, Math.ceil(width)), height: Math.max(1, Math.ceil(height)) };
    const layer = makeLayer('shape', {
      name,
      opacity,
      blend,
      transform: { ...defaultTransform(), x, y, rotation },
      content: { type: 'shape', ...box, shapes, fill, stroke, filters: [] },
    });
    return this.insertNewLayer(layer, { zIndex });
  }

  addAdjustmentLayer({ adjustment, params = {}, clipTo = null, name = null, zIndex = null, opacity = 1, blend = 'normal' } = {}) {
    getAdjustment(adjustment); // validate early with a good error
    const resolvedClip = clipTo ? findLayer(this.doc, clipTo).layer.id : null;
    const layer = makeLayer('adjustment', {
      name: name ?? getAdjustment(adjustment).label,
      opacity,
      blend,
      clipTo: resolvedClip,
      content: { type: 'adjustment', adjustment, params },
    });
    if (resolvedClip) {
      const base = findLayer(this.doc, resolvedClip);
      return this.insertNewLayer(layer, { aboveId: base.layer.id });
    }
    return this.insertNewLayer(layer, { zIndex });
  }

  // -------------------------------------------------------------------------
  // Layer mutation
  // -------------------------------------------------------------------------

  setLayer(ref, props = {}) {
    const { layer } = findLayer(this.doc, ref);
    const allowed = ['visible', 'opacity', 'fillOpacity', 'blend', 'name', 'clipTo', 'locked', 'styles'];
    for (const key of Object.keys(props)) {
      if (!allowed.includes(key)) fail('E_USAGE', `cannot set layer property: ${key}`, { hint: `settable: ${allowed.join(', ')}` });
    }
    if (props.clipTo !== undefined) {
      if (props.clipTo === null || props.clipTo === '' || props.clipTo === 'none') layer.clipTo = null;
      else {
        const target = findLayer(this.doc, props.clipTo);
        const node = findLayer(this.doc, layer.id);
        const targetNode = findLayer(this.doc, target.layer.id);
        if (targetNode.parent !== node.parent) fail('E_USAGE', 'clipping layer must share a parent with its clipping target');
        if (targetNode.index >= node.index) fail('E_USAGE', 'clipping target must be below the clipped layer', { hint: 'move the target lower or clip another layer' });
        layer.clipTo = target.layer.id;
      }
    }
    for (const [key, value] of Object.entries(props)) {
      if (key === 'clipTo') continue;
      if (key === 'opacity' || key === 'fillOpacity') {
        const v = Number(value);
        if (!(v >= 0 && v <= 1)) fail('E_USAGE', `${key} must be between 0 and 1, got ${value}`);
        layer[key] = v;
      } else if (key === 'blend') {
        layer.blend = value;
      } else if (key === 'visible') {
        layer.visible = Boolean(value);
      } else if (key === 'locked') {
        layer.locked = Boolean(value);
      } else if (key === 'name') {
        layer.name = String(value);
      } else if (key === 'styles') {
        layer.styles = value;
      }
    }
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  transform(ref, { x, y, dx, dy, scaleX, scaleY, scale, rotation, anchorX, anchorY, skewX, skewY } = {}) {
    const { layer } = findLayer(this.doc, ref);
    const t = layer.transform;
    if (x !== undefined) t.x = Number(x);
    if (y !== undefined) t.y = Number(y);
    if (dx !== undefined) t.x += Number(dx);
    if (dy !== undefined) t.y += Number(dy);
    if (scale !== undefined) {
      t.scaleX = Number(scale);
      t.scaleY = Number(scale);
    }
    if (scaleX !== undefined) t.scaleX = Number(scaleX);
    if (scaleY !== undefined) t.scaleY = Number(scaleY);
    if (rotation !== undefined) t.rotation = Number(rotation);
    if (anchorX !== undefined) t.anchorX = Number(anchorX);
    if (anchorY !== undefined) t.anchorY = Number(anchorY);
    if (skewX !== undefined) t.skewX = Number(skewX);
    if (skewY !== undefined) t.skewY = Number(skewY);
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  duplicate(ref, { name } = {}) {
    const node = findLayer(this.doc, ref);
    const copy = structuredClone(node.layer);
    copy.name = name ?? `${node.layer.name} copy`;
    const reid = (l) => {
      l.id = nextLayerId(this.doc);
      if (l.children) l.children.forEach(reid);
    };
    copy.id = null;
    if (copy.children) copy.children.forEach(reid);
    insertLayer(this.doc, copy, {
      parentId: node.parent ? node.parent.id : null,
      index: node.index + 1,
    });
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return copy;
  }

  remove(ref) {
    const layer = detachLayer(this.doc, ref);
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  move(ref, { toIndex = null, toParent = null } = {}) {
    moveLayer(this.doc, ref, { parentId: toParent, index: toIndex });
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return findLayer(this.doc, ref).layer;
  }

  group(refs, { name = 'Group' } = {}) {
    const nodes = refs.map((r) => findLayer(this.doc, r));
    if (nodes.length === 0) fail('E_USAGE', 'group needs at least one layer');
    const parent = nodes[0].parent ? nodes[0].parent.id : null;
    for (const node of nodes) {
      if ((node.parent ? node.parent.id : null) !== parent) {
        fail('E_USAGE', 'all layers must share the same parent to be grouped');
      }
    }
    const sorted = [...nodes].sort((a, b) => a.index - b.index);
    const insertAt = sorted[0].index;
    const group = makeLayer('group', { name, children: [], opacity: 1, blend: 'normal' });
    insertLayer(this.doc, group, { parentId: parent, index: insertAt });
    for (const node of sorted) {
      detachLayer(this.doc, node.layer.id);
      group.children.push(node.layer);
    }
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return group;
  }

  ungroup(ref) {
    const node = findLayer(this.doc, ref);
    if (node.layer.type !== 'group') fail('E_USAGE', 'layer is not a group');
    const siblings = node.parent ? node.parent.children : this.doc.layers;
    const children = node.layer.children;
    siblings.splice(node.index, 1, ...children);
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return children;
  }

  async mergeDown(ref) {
    const node = findLayer(this.doc, ref);
    if (node.index === 0) fail('E_USAGE', 'no layer below to merge into');
    const siblings = node.parent ? node.parent.children : this.doc.layers;
    const base = siblings[node.index - 1];
    if (base.type === 'group' && base.blend === 'pass-through') {
      fail('E_USAGE', 'cannot merge into a pass-through group');
    }
    const { width, height } = this.doc.canvas;
    const buffer = new Raster(width, height);
    const ctx = { doc: this.doc, scale: 1, canvas: buffer, baseAlpha: new Map(), baseAlphaInFlight: new Set() };
    await this.renderer.renderLayer(base, buffer, ctx);
    await this.renderer.renderLayer(node.layer, buffer, ctx);
    const stored = await this.assets.putRaster(buffer);
    const merged = makeLayer('raster', {
      name: `${base.name} + ${node.layer.name}`,
      content: { type: 'raster', assetId: stored.hash, width, height, filters: [] },
    });
    siblings.splice(node.index - 1, 2, merged);
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return merged;
  }

  // -------------------------------------------------------------------------
  // Selections
  // -------------------------------------------------------------------------

  async getSelectionMask() {
    if (!this.doc.selection) return null;
    return this.assets.readMask(this.doc.selection.assetId);
  }

  async setSelectionMask(mask, { mode = 'replace' } = {}) {
    let final = mask;
    if (mode !== 'replace') {
      const current = await this.getSelectionMask();
      final = current ? combine(current, mask, mode) : intersectMode(mask, mode);
    }
    const stored = await this.assets.putMask(final);
    this.doc.selection = { assetId: stored.hash, width: final.width, height: final.height };
    touch(this.doc);
    this.markDirty();
    return final;
  }

  async clearSelection() {
    this.doc.selection = null;
    touch(this.doc);
    this.markDirty();
  }

  async selectionStats() {
    const mask = await this.getSelectionMask();
    if (!mask) return null;
    const bounds = mask.alphaBounds();
    let sum = 0;
    for (let i = 0; i < mask.data.length; i++) sum += mask.data[i];
    return { width: mask.width, height: mask.height, bounds, coverage: sum / (mask.data.length * 255) };
  }

  async selectShape(kind, geom, { mode = 'replace', feather = 0, invert = false } = {}) {
    const { width, height } = this.doc.canvas;
    let mask;
    if (kind === 'rect') mask = rectMask(width, height, geom);
    else if (kind === 'ellipse') mask = ellipseMask(width, height, geom);
    else if (kind === 'polygon') mask = polygonMask(width, height, geom.points ?? geom, geom);
    else if (kind === 'path') mask = pathMask(width, height, geom.d, geom);
    else fail('E_USAGE', `unknown selection shape: ${kind}`);
    if (feather > 0) mask = featherMask(mask, feather);
    if (invert) mask = invertMask(mask);
    return this.setSelectionMask(mask, { mode });
  }

  async selectAll() {
    const { width, height } = this.doc.canvas;
    return this.setSelectionMask(Mask.create(width, height, 255), { mode: 'replace' });
  }

  async invertSelection() {
    const current = await this.getSelectionMask();
    if (!current) return this.selectAll();
    return this.setSelectionMask(invertMask(current), { mode: 'replace' });
  }

  async modifySelection({ grow = 0, shrink = 0, feather = 0, border = 0 } = {}) {
    let mask = await this.getSelectionMask();
    if (!mask) fail('E_SELECTION_EMPTY', 'no active selection', { hint: 'create one first with `ashop select rect` etc.' });
    if (grow > 0) mask = growMask(mask, grow);
    if (shrink > 0) mask = shrinkMask(mask, shrink);
    if (border > 0) mask = borderMask(mask, border);
    if (feather > 0) mask = featherMask(mask, feather);
    return this.setSelectionMask(mask, { mode: 'replace' });
  }

  async sampleRaster({ layer = null } = {}) {
    if (layer) {
      const { layer: target } = findLayer(this.doc, layer);
      return this.renderer.renderLayerIsolated(this.doc, target, { scale: 1 });
    }
    return this.renderer.render(this.doc, { scale: 1 });
  }

  async selectColor({ color, tolerance = 20, metric = 'rgb', layer = null, contiguous = false, at = null, mode = 'replace', feather = 0 } = {}) {
    const raster = await this.sampleRaster({ layer });
    const rgb = parseColor(color).slice(0, 3);
    let mask;
    if (contiguous) {
      if (!at) fail('E_USAGE', 'contiguous colour selection needs a seed point', { hint: 'pass --at "x,y"' });
      mask = floodFillMask(raster, { x: Math.round(at.x), y: Math.round(at.y), tolerance });
    } else {
      mask = colorRangeMask(raster, { color: rgb, tolerance, metric });
      // Transparent pixels never contribute colour.
      const gate = alphaMask(raster, { threshold: 1 });
      mask = combine(mask, gate, 'intersect');
    }
    if (feather > 0) mask = featherMask(mask, feather);
    return this.setSelectionMask(mask, { mode });
  }

  async selectLuminance({ threshold = 128, softness = 0, layer = null, mode = 'replace', feather = 0 } = {}) {
    const raster = await this.sampleRaster({ layer });
    let mask = luminanceMask(raster, { threshold, softness });
    if (feather > 0) mask = featherMask(mask, feather);
    return this.setSelectionMask(mask, { mode });
  }

  async selectAlpha({ threshold = 1, softness = 0, layer = null, mode = 'replace', feather = 0 } = {}) {
    const raster = await this.sampleRaster({ layer });
    let mask = alphaMask(raster, { threshold, softness });
    if (feather > 0) mask = featherMask(mask, feather);
    return this.setSelectionMask(mask, { mode });
  }

  // -------------------------------------------------------------------------
  // Layer masks
  // -------------------------------------------------------------------------

  async maskFromSelection(ref, { feather = 0, invert = false } = {}) {
    const { layer } = findLayer(this.doc, ref);
    let selection = await this.getSelectionMask();
    if (!selection) fail('E_SELECTION_EMPTY', 'no active selection', { hint: 'create a selection before building a mask' });
    let local;
    if (layer.type === 'group' || layer.type === 'adjustment') {
      local = selection.clone();
    } else {
      const size = contentSize(layer);
      const m = layerMatrix(layer.transform, size.width, size.height);
      const inv = invertMatrix(m);
      if (!inv) fail('E_RENDER', 'layer transform is not invertible');
      local = new Mask(Math.max(1, Math.ceil(size.width)), Math.max(1, Math.ceil(size.height)));
      for (let y = 0; y < local.height; y++) {
        for (let x = 0; x < local.width; x++) {
          const c = apply(m, x + 0.5, y + 0.5);
          let v = sampleMaskBilinear(selection, c.x - 0.5, c.y - 0.5);
          if (invert) v = 255 - v;
          local.data[y * local.width + x] = v;
        }
      }
    }
    if (invert && (layer.type === 'group' || layer.type === 'adjustment')) local = invertMask(local);
    if (feather > 0) local = featherMask(local, feather);
    const stored = await this.assets.putMask(local);
    layer.mask = { assetId: stored.hash, inverted: false };
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return { layer, mask: local };
  }

  async maskModify(ref, { feather = 0, grow = 0, shrink = 0, border = 0, invert = false } = {}) {
    const { layer } = findLayer(this.doc, ref);
    if (!layer.mask) fail('E_MASK_MISSING', `layer ${layer.id} has no mask`, { hint: 'create one with `ashop mask from-selection --layer ...`' });
    let mask = await this.assets.readMask(layer.mask.assetId);
    if (invert) mask = invertMask(mask);
    if (grow > 0) mask = growMask(mask, grow);
    if (shrink > 0) mask = shrinkMask(mask, shrink);
    if (border > 0) mask = borderMask(mask, border);
    if (feather > 0) mask = featherMask(mask, feather);
    const stored = await this.assets.putMask(mask);
    layer.mask = { ...layer.mask, assetId: stored.hash, inverted: false };
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return { layer, mask };
  }

  async maskRemove(ref) {
    const { layer } = findLayer(this.doc, ref);
    layer.mask = null;
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  async maskApply(ref) {
    const { layer } = findLayer(this.doc, ref);
    if (!layer.mask) fail('E_MASK_MISSING', `layer ${layer.id} has no mask`);
    if (layer.type !== 'raster') {
      fail('E_UNSUPPORTED', 'mask apply is only supported on raster layers', {
        hint: 'flatten the layer first with `ashop layer merge-down`, or keep the mask',
      });
    }
    const content = layer.content;
    const raster = await this.assets.readRaster(content.assetId);
    const mask = await this.assets.readMask(layer.mask.assetId);
    const out = raster.clone();
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const mu = (x / out.width) * mask.width - 0.5;
        const mv = (y / out.height) * mask.height - 0.5;
        let v = sampleMaskBilinear(mask, mu, mv);
        if (layer.mask.inverted) v = 255 - v;
        const i = (y * out.width + x) * 4 + 3;
        out.data[i] = (out.data[i] * v) / 255;
      }
    }
    const stored = await this.assets.putRaster(out);
    layer.content = { ...content, assetId: stored.hash };
    layer.mask = null;
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  async maskExport(ref, file) {
    const { layer } = findLayer(this.doc, ref);
    if (!layer.mask) fail('E_MASK_MISSING', `layer ${layer.id} has no mask`);
    const mask = await this.assets.readMask(layer.mask.assetId);
    const buf = await encodeMaskPng(mask);
    await writeFile(path.resolve(file), buf);
    return { file: path.resolve(file), width: mask.width, height: mask.height };
  }

  // -------------------------------------------------------------------------
  // Filters / styles / adjustments
  // -------------------------------------------------------------------------

  useFilter(ref, type, params = {}) {
    const { layer } = findLayer(this.doc, ref);
    if (layer.type === 'group' || layer.type === 'adjustment') {
      fail('E_UNSUPPORTED', `filters cannot be applied to ${layer.type} layers`);
    }
    getFilter(type); // validate
    layer.content.filters = layer.content.filters ?? [];
    layer.content.filters.push({ type, params });
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  clearFilters(ref) {
    const { layer } = findLayer(this.doc, ref);
    layer.content.filters = [];
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  addStyle(ref, type, params = {}) {
    const { layer } = findLayer(this.doc, ref);
    getStyle(type); // validate
    layer.styles = layer.styles ?? [];
    layer.styles.push({ type, params });
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  removeStyle(ref, { index = null, type = null } = {}) {
    const { layer } = findLayer(this.doc, ref);
    if (index != null) layer.styles.splice(index, 1);
    else if (type) {
      const before = layer.styles.length;
      layer.styles = layer.styles.filter((s) => s.type !== type);
      if (layer.styles.length === before) fail('E_STYLE_NOT_FOUND', `layer has no ${type} style`);
    } else fail('E_USAGE', 'removeStyle needs an index or type');
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  setAdjustment(ref, params = {}) {
    const { layer } = findLayer(this.doc, ref);
    if (layer.type !== 'adjustment') fail('E_USAGE', 'layer is not an adjustment layer');
    layer.content.params = { ...layer.content.params, ...params };
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  // -------------------------------------------------------------------------
  // Text
  // -------------------------------------------------------------------------

  setText(ref, patch = {}) {
    const { layer } = findLayer(this.doc, ref);
    if (layer.type !== 'text') fail('E_USAGE', 'layer is not a text layer');
    const content = { ...layer.content, ...patch };
    const measured = measureText(content);
    content.width = Number(content.width) > 0 ? Number(content.width) : Math.max(1, measured.width);
    content.height = Math.max(1, measured.height);
    layer.content = content;
    touch(this.doc);
    this.markDirty();
    this.renderer.clearCache();
    return layer;
  }

  measureText(content) {
    return measureText(content);
  }

  // -------------------------------------------------------------------------
  // Rendering / export
  // -------------------------------------------------------------------------

  async render({ scale = 1 } = {}) {
    return this.renderer.render(this.doc, { scale });
  }

  async exportTo(file, { format, quality = 90, width, height, scale = 1, background = null } = {}) {
    const target = path.resolve(file);
    let raster = await this.render({ scale });
    if (width || height) {
      const w = Math.max(1, Math.round(width ?? Math.round((raster.width * height) / raster.height)));
      const h = Math.max(1, Math.round(height ?? Math.round((raster.height * width) / raster.width)));
      const buf = await sharp(raster.toBuffer(), { raw: { width: raster.width, height: raster.height, channels: 4 } })
        .resize(w, h, { fit: 'fill', kernel: 'lanczos3' })
        .raw()
        .toBuffer();
      raster = new Raster(w, h, new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength));
    }
    const fmt = (format ?? (path.extname(target).slice(1) || 'png')).toLowerCase();
    const bytes = await encodeRaster(raster, { format: fmt, quality, background });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    return { file: target, width: raster.width, height: raster.height, format: fmt, bytes: bytes.length, sha256: sha256Hex(bytes), pixelHash: raster.pixelHash() };
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  requireProject() {
    if (!this.project) fail('E_NO_PROJECT', 'this session has no project on disk', { hint: 'create or open a project first' });
    return this.project;
  }

  commit(message = '') {
    const project = this.requireProject();
    const c = commit(project.history, this.doc, message);
    project.doc = this.doc;
    project.dirty = true;
    return { id: c.id, message: c.message, ts: c.ts, head: project.history.head };
  }

  historyLog({ limit = 20 } = {}) {
    const project = this.requireProject();
    return { head: project.history.head, branch: project.history.currentBranch, commits: historyLog(project.history, { limit }) };
  }

  async checkout(ref, { force = false } = {}) {
    const project = this.requireProject();
    if (!force && isDirty(project.history, this.doc)) {
      fail('E_DIRTY_WORKTREE', 'working document has uncommitted changes', {
        hint: 'commit them first, or pass --force to discard them',
      });
    }
    const result = historyCheckout(project.history, ref);
    this.doc = result.doc;
    project.doc = this.doc;
    project.dirty = true;
    this.renderer.clearCache();
    return { commit: result.commit, branch: result.branch, doc: this.summary() };
  }

  createBranch(name, { checkout: shouldCheckout = true } = {}) {
    const project = this.requireProject();
    const b = createBranch(project.history, name, { checkout: shouldCheckout });
    project.dirty = true;
    return b;
  }

  async resetHard(ref) {
    const project = this.requireProject();
    const doc = resetHard(project.history, ref);
    this.doc = doc;
    project.doc = doc;
    project.dirty = true;
    this.renderer.clearCache();
    return { head: project.history.head };
  }

  historyDiff(a, b) {
    const project = this.requireProject();
    const docA = project.history.commits[resolveRef(project.history, a)]?.doc;
    const docB = project.history.commits[resolveRef(project.history, b)]?.doc;
    if (!docA || !docB) fail('E_REF_NOT_FOUND', 'cannot resolve one of the refs');
    return diffDocuments(docA, docB);
  }

  headDoc() {
    const project = this.requireProject();
    return headCommit(project.history)?.doc ?? null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function placeAligned(stage, w, h, align) {
  if (!ALIGNMENTS.includes(align)) fail('E_USAGE', `unknown alignment: ${align}`, { hint: `use one of ${ALIGNMENTS.join(', ')}` });
  const midX = (stage.width - w) / 2;
  const midY = (stage.height - h) / 2;
  const map = {
    'top-left': [0, 0],
    top: [midX, 0],
    'top-right': [stage.width - w, 0],
    left: [0, midY],
    center: [midX, midY],
    right: [stage.width - w, midY],
    'bottom-left': [0, stage.height - h],
    bottom: [midX, stage.height - h],
    'bottom-right': [stage.width - w, stage.height - h],
  };
  const [x, y] = map[align];
  return { x, y };
}

function firstLine(text) {
  return String(text ?? '').split('\n')[0].slice(0, 24) || null;
}

function intersectMode(mask, mode) {
  // With no existing selection, "add" is the mask itself; "subtract" has
  // nothing to subtract from; "intersect" starts empty.
  if (mode === 'intersect' || mode === 'subtract') return Mask.create(mask.width, mask.height, 0);
  return mask;
}
