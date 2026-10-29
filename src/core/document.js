/**
 * Document model: a plain-JSON layer tree.
 *
 * Design rules that the rest of the engine relies on:
 *  - `layers` is ordered bottom -> top (index 0 is the lowest layer).
 *  - Groups nest children with the same rule.
 *  - Content lives in "content units"; the layer transform maps content units
 *    to canvas pixels. For raster layers content units == source pixels.
 *  - Every layer id is unique and stable for the life of the project.
 */

import { AshopError, fail } from './errors.js';
import { IDENTITY, isIdentity } from './matrix.js';

export const DOC_FORMAT = 'ashop/1';
export const DOC_VERSION = 1;

export const LAYER_TYPES = ['raster', 'group', 'text', 'shape', 'adjustment'];

const LAYER_NAME = {
  raster: 'Image',
  group: 'Group',
  text: 'Text',
  shape: 'Shape',
  adjustment: 'Adjustment',
};

export function createDocument({ width, height, background = 'transparent', name = 'untitled', colorSpace = 'srgb' } = {}) {
  if (!Number.isInteger(width) || width <= 0 || width > 32768) {
    fail('E_USAGE', `invalid canvas width: ${width}`, { hint: 'width must be an integer between 1 and 32768' });
  }
  if (!Number.isInteger(height) || height <= 0 || height > 32768) {
    fail('E_USAGE', `invalid canvas height: ${height}`, { hint: 'height must be an integer between 1 and 32768' });
  }
  return {
    format: DOC_FORMAT,
    version: DOC_VERSION,
    name,
    canvas: { width, height, background },
    colorSpace,
    layers: [],
    selection: null,
    counter: 0,
    rev: 0,
    meta: { created: new Date().toISOString(), tool: 'ashop' },
  };
}

/** Default transform: content anchored at its top-left corner, unscaled. */
export function defaultTransform() {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, anchorX: 0, anchorY: 0, skewX: 0, skewY: 0 };
}

export function makeLayer(type, props = {}) {
  if (!LAYER_TYPES.includes(type)) fail('E_USAGE', `unknown layer type: ${type}`, { hint: `known types: ${LAYER_TYPES.join(', ')}` });
  const base = {
    id: null,
    type,
    name: props.name ?? LAYER_NAME[type],
    visible: true,
    opacity: 1,
    fillOpacity: 1,
    blend: 'normal',
    clipTo: null,
    locked: false,
    transform: { ...defaultTransform(), ...(props.transform ?? {}) },
    mask: null,
    styles: [],
  };
  if (type === 'group') base.children = props.children ?? [];
  return { ...base, ...props, id: props.id ?? null, transform: { ...defaultTransform(), ...(props.transform ?? {}) } };
}

export function nextLayerId(doc) {
  doc.counter = (doc.counter ?? 0) + 1;
  return `lyr_${doc.counter}`;
}

export function touch(doc) {
  doc.rev = (doc.rev ?? 0) + 1;
  doc.updatedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

/**
 * Depth-first walk. `parent` is the containing group layer (or null).
 * Yields { layer, parent, index, depth } where index is the position inside
 * its sibling array.
 */
export function* walkLayers(layers, parent = null, depth = 0) {
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    yield { layer, parent, index: i, depth };
    if (layer.type === 'group' && Array.isArray(layer.children)) {
      yield* walkLayers(layer.children, layer, depth + 1);
    }
  }
}

/** Flat listing with a stable path string, useful for JSON output. */
export function listLayers(doc) {
  const out = [];
  for (const { layer, parent, index, depth } of walkLayers(doc.layers)) {
    out.push({
      id: layer.id,
      name: layer.name,
      type: layer.type,
      depth,
      index,
      parentId: parent ? parent.id : null,
      path: parent ? `${parent.id}/${layer.id}` : layer.id,
      visible: layer.visible,
      opacity: layer.opacity,
      blend: layer.blend,
      clipTo: layer.clipTo,
      hasMask: Boolean(layer.mask),
      styles: layer.styles.map((s) => s.type),
      contentSize: contentSize(layer),
      transform: layer.transform,
    });
  }
  return out;
}

/** Find a layer by id (fast path) or name (unique, searched breadth first). */
export function findLayer(doc, ref, { required = true } = {}) {
  if (ref == null) {
    if (required) fail('E_LAYER_REQUIRED', 'no layer reference given', { hint: 'pass --layer <id|name>' });
    return null;
  }
  const key = String(ref).replace(/^#/, '').replace(/^layer:/, '').replace(/^@/, '');
  for (const node of walkLayers(doc.layers)) {
    if (node.layer.id === key) return node;
  }
  const matches = [];
  for (const node of walkLayers(doc.layers)) {
    if (node.layer.name === key) matches.push(node);
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    fail('E_LAYER_AMBIGUOUS', `layer name "${key}" matches ${matches.length} layers`, {
      hint: 'use the layer id instead',
      details: { candidates: matches.map((m) => m.layer.id) },
    });
  }
  if (required) {
    fail('E_LAYER_NOT_FOUND', `no layer with id or name "${key}"`, {
      hint: 'run `ashop layer list` to see available layers',
      details: { known: listLayers(doc).map((l) => ({ id: l.id, name: l.name })) },
    });
  }
  return null;
}

export function layerById(doc, id) {
  if (!id) return null;
  for (const node of walkLayers(doc.layers)) if (node.layer.id === id) return node;
  return null;
}

/** The sibling array that owns `layer`. */
export function containerOf(doc, layer) {
  const node = layer.id ? layerById(doc, layer.id) : null;
  if (node) return node.parent ? node.parent.children : doc.layers;
  return doc.layers;
}

export function siblingArray(doc, parentId) {
  if (!parentId) return doc.layers;
  const parent = layerById(doc, parentId);
  if (!parent) fail('E_LAYER_NOT_FOUND', `no group layer ${parentId}`);
  if (parent.layer.type !== 'group') fail('E_USAGE', `layer ${parentId} is not a group`);
  return parent.layer.children;
}

// ---------------------------------------------------------------------------
// Mutation primitives (callers are responsible for touch(doc))
// ---------------------------------------------------------------------------

export function insertLayer(doc, layer, { parentId = null, index = null, id = null } = {}) {
  const siblings = siblingArray(doc, parentId);
  layer.id = id ?? layer.id ?? nextLayerId(doc);
  if (layerById(doc, layer.id)) fail('E_LAYER_EXISTS', `layer id already exists: ${layer.id}`);
  if (index == null || index >= siblings.length) siblings.push(layer);
  else siblings.splice(Math.max(0, index), 0, layer);
  return layer;
}

export function detachLayer(doc, ref) {
  const node = findLayer(doc, ref);
  const siblings = node.parent ? node.parent.children : doc.layers;
  siblings.splice(node.index, 1);
  return node.layer;
}

/** Move a layer to another position/parent. `index` is the target slot after removal. */
export function moveLayer(doc, ref, { parentId = null, index = null } = {}) {
  const node = findLayer(doc, ref);
  const layer = node.layer;
  if (parentId && isAncestor(layer, parentId)) {
    fail('E_USAGE', 'cannot move a group into itself');
  }
  if (parentId && layer.type === 'group') {
    // moving a group under its own descendant is already covered above
  }
  const source = node.parent ? node.parent.children : doc.layers;
  source.splice(node.index, 1);
  const target = siblingArray(doc, parentId);
  let at = index == null ? target.length : Math.max(0, Math.min(index, target.length));
  // Compensate for the removal when moving within the same array.
  if (source === target && node.index < at) at -= 1;
  target.splice(at, 0, layer);
  return layer;
}

export function isAncestor(maybeAncestor, childId) {
  if (maybeAncestor.type !== 'group') return false;
  for (const child of maybeAncestor.children ?? []) {
    if (child.id === childId) return true;
    if (isAncestor(child, childId)) return true;
  }
  return false;
}

export function allLayerIds(doc) {
  return [...walkLayers(doc.layers)].map((n) => n.layer.id);
}

/** Number of layers, flattened. */
export function layerCount(doc) {
  let n = 0;
  for (const _ of walkLayers(doc.layers)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Intrinsic size of a layer's content, in content units.
 * Raster content carries its pixel size; text/shape carry explicit boxes.
 */
export function contentSize(layer) {
  if (layer.type === 'raster') {
    return { width: layer.content?.width ?? 0, height: layer.content?.height ?? 0 };
  }
  if (layer.type === 'text' || layer.type === 'shape') {
    return { width: layer.content?.width ?? 0, height: layer.content?.height ?? 0 };
  }
  return { width: 0, height: 0 };
}

/**
 * Ensure the transform is representable: groups must not carry a transform in
 * this version (their children carry their own), which keeps composition
 * semantics predictable.
 */
export function assertLayerTransformable(layer) {
  if (layer.type === 'group' && !isIdentity(identityFromTransform(layer.transform))) {
    fail('E_USAGE', 'group transforms are not supported; transform the children instead', {
      hint: `group ${layer.id} has a non-identity transform`,
    });
  }
}

export function identityFromTransform(t) {
  if (!t) return IDENTITY;
  const identity = t.x === 0 && t.y === 0 && (t.scaleX ?? 1) === 1 && (t.scaleY ?? 1) === 1
    && (t.rotation ?? 0) === 0 && (t.skewX ?? 0) === 0 && (t.skewY ?? 0) === 0;
  return identity ? IDENTITY : [1, 0, 0, 1, 1, 1];
}

// ---------------------------------------------------------------------------
// Validation & cloning
// ---------------------------------------------------------------------------

export function validateDocument(doc) {
  const problems = [];
  const ids = new Set();
  const nodes = new Map();
  for (const node of walkLayers(doc.layers)) {
    const { layer, parent } = node;
    if (!layer.id) problems.push(`layer without id at depth ${node.depth}`);
    else if (ids.has(layer.id)) problems.push(`duplicate layer id: ${layer.id}`);
    else ids.add(layer.id);
    nodes.set(layer.id, node);
    if (!LAYER_TYPES.includes(layer.type)) problems.push(`layer ${layer.id}: unknown type ${layer.type}`);
    if (layer.type === 'group' && !Array.isArray(layer.children)) problems.push(`group ${layer.id}: missing children array`);
    if (layer.type !== 'group' && Array.isArray(layer.children)) problems.push(`layer ${layer.id}: children on non-group`);
    if (parent && parent.type !== 'group') problems.push(`layer ${layer.id}: parent is not a group`);
  }
  for (const [id, node] of nodes) {
    const clip = node.layer.clipTo;
    if (!clip) continue;
    const target = nodes.get(clip);
    if (!target) problems.push(`layer ${id}: clips unknown layer ${clip}`);
    else if (target.parent !== node.parent) problems.push(`layer ${id}: clipping layer must share a parent with ${clip}`);
    else if (!isBelow(target, node)) problems.push(`layer ${id}: clipping target ${clip} must be below the clipped layer`);
  }
  if (problems.length) {
    throw new AshopError('E_DOC_INVALID', `document is invalid: ${problems[0]}`, { details: { problems } });
  }
  return doc;
}

/** True when node A appears below node B within the same sibling list. */
export function isBelow(nodeA, nodeB) {
  if (nodeA.parent !== nodeB.parent) return false;
  return nodeA.index < nodeB.index;
}

export function cloneDocument(doc) {
  return structuredClone(doc);
}
