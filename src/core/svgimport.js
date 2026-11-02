/**
 * SVG import: turn an SVG document into shape content (version 2).
 *
 * We deliberately do not depend on an XML library. The subset that matters for
 * logos and illustrations is small, and a tolerant tokenizer keeps the engine
 * dependency-free: self-closing tags, single/double quoted attributes,
 * comments, CDATA, DOCTYPE (including an internal subset) and the standard
 * named/numeric entities are all handled here.
 *
 * Geometry is mapped into content units: the layer box runs from (0, 0) to
 * (width, height), and the viewBox offset plus the viewBox-to-viewport scale
 * are folded into each object's `transform`, so renderers only ever see layer
 * local coordinates. Paints reuse `normalizePaint` / `normalizeStroke`, which
 * means imported gradients and strokes speak exactly the same model as
 * `shape.add`.
 *
 * The parser is intentionally forgiving: unsupported elements and attributes
 * degrade to a warning and are skipped instead of failing the import. Only
 * malformed XML (unbalanced tags, no <svg> root, invalid viewBox) raises
 * `E_SVG_PARSE`.
 */

import { fail } from './errors.js';
import { normalizePaint } from './paint.js';
import { normalizeStroke } from './shapes.js';

const DEFAULT_VIEWPORT = { width: 300, height: 150 };

/** SVG user units -> CSS pixels. */
const UNIT_SCALE = { px: 1, pt: 4 / 3, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, pc: 16 };

/** Elements that become a value in the shape content. */
const SHAPE_TAGS = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);

/** Elements whose subtrees are never rendered (definitions and metadata). */
const SILENT_TAGS = new Set(['defs', 'title', 'desc', 'metadata', 'lineargradient', 'radialgradient', 'stop']);

/** Presentation attributes we understand. `opacity`/`display` are consumed at
 *  the element itself; the rest is inherited down the tree (SVG rules). */
const PRESENTATION_KEYS = new Set([
  'fill', 'fill-opacity', 'fill-rule',
  'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'display', 'visibility', 'color',
]);

const DEFAULT_PROPS = {
  fill: '#000000',
  stroke: 'none',
  strokeWidth: 1,
  strokeLinecap: 'butt',
  strokeLinejoin: 'miter',
  strokeMiterlimit: 4,
  strokeDasharray: null,
  strokeDashoffset: 0,
  strokeOpacity: 1,
  fillOpacity: 1,
  fillRule: 'nonzero',
  color: '#000000',
  visibility: 'visible',
};

const IDENTITY = [1, 0, 0, 1, 0, 0];
const LINE_CAPS = new Set(['butt', 'round', 'square']);
const LINE_JOINS = new Set(['miter', 'round', 'bevel']);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const r4 = (value) => {
  const n = Math.round(Number(value) * 10000) / 10000;
  return Object.is(n, -0) ? 0 : n;
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** "50%" -> 0.5, "0.25" -> 0.25, garbage -> fallback. */
function fraction(value, fallback = 1) {
  if (value == null) return fallback;
  const s = String(value).trim();
  if (!s) return fallback;
  const n = s.endsWith('%') ? parseFloat(s) / 100 : Number(s);
  return Number.isFinite(n) ? clamp01(n) : fallback;
}

function identityMatrix() {
  return IDENTITY.slice();
}

function isIdentity(matrix) {
  return matrix.every((value, index) => r4(value) === IDENTITY[index]);
}

/** Compose two affine matrices: result = a * b (apply b first, then a). */
function mul(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function rotationMatrix(degrees) {
  const rad = (num(degrees) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, 0, 0];
}

/** Map a local user-space length into user units, honouring units and %. */
function userLength(value, axis, ctx, fallback = 0) {
  if (value == null) return fallback;
  const s = String(value).trim();
  if (!s || s === 'auto') return fallback;
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z%]*)$/i.exec(s);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return fallback;
  const unit = m[2].toLowerCase();
  if (!unit) return n;
  if (unit === '%') {
    const base = axis === 'x'
      ? ctx.viewportWidth
      : axis === 'y'
        ? ctx.viewportHeight
        : Math.hypot(ctx.viewportWidth, ctx.viewportHeight) / Math.SQRT2;
    return (n / 100) * base;
  }
  const scale = UNIT_SCALE[unit];
  return scale === undefined ? fallback : n * scale;
}

/** Resolve an absolute dimension ("2in", "50%", "320") to pixels, or null. */
function resolveDimension(value, percentBase) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.endsWith('%')) {
    const n = parseFloat(s);
    return Number.isFinite(n) ? (n / 100) * percentBase : null;
  }
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z]*)$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase();
  if (!unit) return n;
  const scale = UNIT_SCALE[unit];
  return scale === undefined ? null : n * scale;
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeEntities(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return '\ufffd';
      return String.fromCodePoint(code);
    }
    const known = NAMED_ENTITIES[body];
    return known === undefined ? match : known;
  });
}

// ---------------------------------------------------------------------------
// Tolerant XML tokenizer
//
// Nodes are plain objects: { name, attrs, children }. Names and attribute
// names are lowercased, attribute values are entity-decoded. Only the element
// tree is kept; text nodes are irrelevant for shape import.
// ---------------------------------------------------------------------------

function failParse(message, hint) {
  fail('E_SVG_PARSE', message, {
    hint: hint ?? 'the file should be well-formed XML with an <svg> root element',
  });
}

function pastMarker(text, from, marker) {
  const at = text.indexOf(marker, from);
  if (at < 0) failParse(`unterminated ${JSON.stringify(marker)} block`);
  return at + marker.length;
}

/** Find the closing ">" of a tag, ignoring ">" inside quoted attribute values. */
function readTag(text, start) {
  let quote = null;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return { raw: text.slice(start + 1, i), end: i + 1 };
    }
  }
  failParse('unterminated tag (missing ">")');
  return null;
}

/** Skip a DOCTYPE declaration, including an optional internal subset. */
function skipDoctype(text, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === '>' && depth === 0) return i + 1;
  }
  failParse('unterminated DOCTYPE declaration');
  return null;
}

function parseAttrs(source) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    const raw = match[2] ?? match[3] ?? match[4];
    attrs[name] = raw === undefined ? 'true' : decodeEntities(raw);
  }
  return attrs;
}

function parseXml(text) {
  let i = 0;
  let root = null;
  const stack = [];
  const current = () => stack[stack.length - 1] ?? null;

  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;

    if (text.startsWith('<!--', i)) { i = pastMarker(text, i + 4, '-->'); continue; }
    if (text.startsWith('<![CDATA[', i)) { i = pastMarker(text, i + 9, ']]>'); continue; }
    if (text.startsWith('<?', i)) { i = pastMarker(text, i + 2, '?>'); continue; }
    if (/^<!doctype/i.test(text.slice(i, i + 9))) { i = skipDoctype(text, i + 9); continue; }
    if (text.startsWith('<!', i)) { i = pastMarker(text, i + 2, '>'); continue; }

    const { raw, end } = readTag(text, i);
    i = end;
    const body = raw.trim();
    if (!body) failParse('empty tag "<>"');

    if (body.startsWith('/')) {
      const name = body.slice(1).trim().toLowerCase();
      const open = stack.pop();
      if (!open || open.name !== name) {
        failParse(`mismatched closing tag </${name}>`, open
          ? `expected </${open.name}> to close <${open.name}>`
          : 'the closing tag has no matching opening tag');
      }
      continue;
    }

    const selfClosing = body.endsWith('/');
    const source = selfClosing ? body.slice(0, -1).trimEnd() : body;
    const head = /^([A-Za-z_][\w:.-]*)([\s\S]*)$/.exec(source);
    if (!head) failParse(`invalid tag: <${body}>`);
    const node = { name: head[1].toLowerCase(), rawName: head[1], attrs: parseAttrs(head[2]), children: [] };
    const parent = current();
    if (parent) parent.children.push(node);
    else if (!root) root = node;
    if (!selfClosing) stack.push(node);
  }

  if (stack.length > 0) {
    failParse(`unclosed element <${stack[stack.length - 1].name}>`);
  }
  if (!root) failParse('no <svg> element found');
  return root;
}

// ---------------------------------------------------------------------------
// Styles, transforms, gradients
// ---------------------------------------------------------------------------

/** Split a declaration list on `separator`, ignoring separators in parens. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** `style="fill:#fff;stroke:none"` -> { fill: '#fff', stroke: 'none' }. */
function parseStyle(text) {
  const out = {};
  if (!text) return out;
  for (const part of splitTopLevel(String(text), ';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

/** Parse an SVG transform list into one affine matrix. */
function parseTransform(text, warn) {
  if (text == null) return identityMatrix();
  const source = String(text).trim();
  if (!source) return identityMatrix();

  let matrix = identityMatrix();
  let matched = false;
  const re = /([A-Za-z]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    matched = true;
    const name = match[1].toLowerCase();
    const values = match[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (values.some((v) => !Number.isFinite(v))) {
      warn(`invalid transform "${match[0]}" ignored`);
      continue;
    }
    switch (name) {
      case 'translate':
        matrix = mul(matrix, [1, 0, 0, 1, values[0] ?? 0, values[1] ?? 0]);
        break;
      case 'scale': {
        const sx = values[0] ?? 1;
        const sy = values[1] ?? sx;
        matrix = mul(matrix, [sx, 0, 0, sy, 0, 0]);
        break;
      }
      case 'rotate': {
        const angle = values[0] ?? 0;
        const rotation = rotationMatrix(angle);
        if (values.length >= 3) {
          const [, cx, cy] = values;
          matrix = mul(matrix, mul(mul([1, 0, 0, 1, cx, cy], rotation), [1, 0, 0, 1, -cx, -cy]));
        } else {
          matrix = mul(matrix, rotation);
        }
        break;
      }
      case 'skewx':
        matrix = mul(matrix, [1, 0, Math.tan(((values[0] ?? 0) * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewy':
        matrix = mul(matrix, [1, Math.tan(((values[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0]);
        break;
      case 'matrix':
        if (values.length === 6) matrix = mul(matrix, values);
        else warn(`matrix() needs 6 numbers, got ${values.length}; ignored`);
        break;
      default:
        warn(`unknown transform function "${name}" ignored`);
    }
  }
  if (!matched) warn(`invalid transform "${source}" ignored`);
  return matrix;
}

function collectGradients(node, map, warn) {
  if (node.name === 'lineargradient' || node.name === 'radialgradient') {
    const id = node.attrs.id;
    if (id) {
      if (map.has(id)) warn(`duplicate gradient id "${id}"; the last definition wins`);
      map.set(id, node);
    }
    return;
  }
  for (const child of node.children) collectGradients(child, map, warn);
}

function hrefOf(node) {
  const href = node.attrs.href ?? node.attrs['xlink:href'];
  return href && href.trim().startsWith('#') ? href.trim().slice(1) : null;
}

/** A gradient may inherit attributes and stops through href/xlink:href. */
function gradientChain(node, ctx) {
  const chain = [];
  const seen = new Set();
  let current = node;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const id = hrefOf(current);
    if (!id) break;
    const next = ctx.gradients.get(id);
    if (!next) {
      ctx.warn(`gradient reference "#${id}" was not found`);
      break;
    }
    current = next;
  }
  return chain;
}

function parseStopOffset(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = s.endsWith('%') ? parseFloat(s) / 100 : Number(s);
  return Number.isFinite(n) ? clamp01(n) : null;
}

function parseStops(node, ctx) {
  const stops = [];
  for (const child of node.children) {
    if (child.name !== 'stop') continue;
    const style = parseStyle(child.attrs.style);
    let color = String(child.attrs['stop-color'] ?? style['stop-color'] ?? '#000000').trim();
    if (/^(currentcolor|inherit)$/i.test(color)) {
      ctx.warn(`stop-color "${color}" is not supported; using #000000`);
      color = '#000000';
    }
    stops.push({
      offset: parseStopOffset(child.attrs.offset ?? style.offset),
      color,
      opacity: fraction(child.attrs['stop-opacity'] ?? style['stop-opacity'], 1),
    });
  }
  return stops;
}

/** objectBoundingBox gradient coordinate: "50%" -> 0.5, "0.25" -> 0.25. */
function gradientCoord(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).trim();
  if (!s) return fallback;
  const n = s.endsWith('%') ? parseFloat(s) / 100 : Number(s);
  return Number.isFinite(n) ? n : fallback;
}

function buildGradientPaint(node, ctx) {
  const id = node.attrs.id ?? '(anonymous)';
  const chain = gradientChain(node, ctx);
  const attrFrom = (name) => {
    for (const entry of chain) if (entry.attrs[name] !== undefined) return entry.attrs[name];
    return undefined;
  };
  const stopsNode = chain.find((entry) => entry.children.some((child) => child.name === 'stop'));
  const stops = stopsNode ? parseStops(stopsNode, ctx) : [];
  const degrade = (reason) => {
    ctx.warn(reason);
    const first = stops[0];
    if (!first) return null;
    try {
      return normalizePaint({ type: 'solid', color: first.color, opacity: first.opacity });
    } catch {
      return null;
    }
  };

  if (attrFrom('gradienttransform') !== undefined) {
    ctx.warn(`gradientTransform on gradient "${id}" is not supported; ignored`);
  }
  if (stops.length === 0) {
    ctx.warn(`gradient "${id}" has no stops; paint skipped`);
    return null;
  }
  if (stops.length === 1) {
    return degrade(`gradient "${id}" has a single stop; approximated with a solid colour`);
  }
  const units = String(attrFrom('gradientunits') ?? 'objectBoundingBox');
  if (units.toLowerCase() === 'userspaceonuse') {
    return degrade(`gradient "${id}" uses userSpaceOnUse, which objectBoundingBox paints cannot express; using the first stop colour`);
  }
  if (units.toLowerCase() !== 'objectboundingbox') {
    ctx.warn(`gradient "${id}" has unsupported gradientUnits "${units}"; assuming objectBoundingBox`);
  }

  if (node.name === 'lineargradient') {
    const input = {
      type: 'linear-gradient',
      from: [
        gradientCoord(attrFrom('x1'), 0),
        gradientCoord(attrFrom('y1'), 0),
      ],
      to: [
        gradientCoord(attrFrom('x2'), 1),
        gradientCoord(attrFrom('y2'), 0),
      ],
      stops,
    };
    try {
      return normalizePaint(input);
    } catch (err) {
      return degrade(`gradient "${id}" could not be normalized (${err.message}); using the first stop colour`);
    }
  }

  const radius = gradientCoord(attrFrom('r'), 0.5);
  if (attrFrom('fx') !== undefined || attrFrom('fy') !== undefined) {
    ctx.warn(`radial gradient "${id}" has a focal point, which is not supported; using the centre`);
  }
  if (!(radius > 0)) {
    return degrade(`radial gradient "${id}" has a zero radius; using the first stop colour`);
  }
  try {
    return normalizePaint({
      type: 'radial-gradient',
      center: [gradientCoord(attrFrom('cx'), 0.5), gradientCoord(attrFrom('cy'), 0.5)],
      radius,
      stops,
    });
  } catch (err) {
    return degrade(`gradient "${id}" could not be normalized (${err.message}); using the first stop colour`);
  }
}

function gradientPaint(id, ctx) {
  if (ctx.gradientCache.has(id)) return ctx.gradientCache.get(id);
  const node = ctx.gradients.get(id);
  if (!node) {
    ctx.gradientCache.set(id, null);
    return null;
  }
  const paint = buildGradientPaint(node, ctx);
  ctx.gradientCache.set(id, paint);
  return paint;
}

// ---------------------------------------------------------------------------
// Element interpretation
// ---------------------------------------------------------------------------

function applyDeclaration(props, key, value, state) {
  const text = String(value).trim();
  if (!text) return;
  switch (key) {
    case 'fill':
      props.fill = text;
      break;
    case 'fill-opacity':
      props.fillOpacity = fraction(text, 1);
      break;
    case 'fill-rule':
      props.fillRule = text.toLowerCase();
      break;
    case 'stroke':
      props.stroke = text;
      break;
    case 'stroke-width':
      props.strokeWidth = userLength(text, 'diagonal', state.ctx, props.strokeWidth);
      break;
    case 'stroke-opacity':
      props.strokeOpacity = fraction(text, 1);
      break;
    case 'stroke-linecap':
      props.strokeLinecap = text.toLowerCase();
      break;
    case 'stroke-linejoin':
      props.strokeLinejoin = text.toLowerCase();
      break;
    case 'stroke-miterlimit':
      props.strokeMiterlimit = num(text, props.strokeMiterlimit);
      break;
    case 'stroke-dasharray':
      props.strokeDasharray = text;
      break;
    case 'stroke-dashoffset':
      props.strokeDashoffset = userLength(text, 'diagonal', state.ctx, props.strokeDashoffset);
      break;
    case 'color':
      props.color = text;
      break;
    case 'visibility':
      props.visibility = text.toLowerCase();
      break;
    case 'display':
      state.display = text.toLowerCase();
      break;
    case 'opacity':
      state.opacity = fraction(text, 1);
      break;
    default:
      break;
  }
}

/**
 * Resolve one element's own declarations on top of inherited presentation
 * properties. `opacity`/`display` belong to the element itself and are
 * returned separately; everything else is inherited by children.
 */
function resolveElement(node, inherited, ctx) {
  const props = { ...inherited.props };
  const state = { ctx, display: 'inline', opacity: 1 };

  for (const key of PRESENTATION_KEYS) {
    if (node.attrs[key] !== undefined) applyDeclaration(props, key, node.attrs[key], state);
  }
  const style = parseStyle(node.attrs.style);
  for (const [key, value] of Object.entries(style)) {
    if (PRESENTATION_KEYS.has(key)) applyDeclaration(props, key, value, state);
  }

  const hidden = state.display === 'none' || props.visibility === 'hidden' || props.visibility === 'collapse';
  return {
    props,
    opacity: clamp01(state.opacity),
    hidden,
    matrix: parseTransform(node.attrs.transform, ctx.warn),
  };
}

function parsePointList(text, ctx) {
  if (text == null) return [];
  const nums = String(text).trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (nums.length < 2 || nums.some((n) => !Number.isFinite(n))) {
    ctx.warn(`invalid points attribute "${text}"`);
    return [];
  }
  if (nums.length % 2 !== 0) {
    ctx.warn(`odd number of coordinates in points attribute "${text}"; trailing value ignored`);
  }
  const points = [];
  for (let i = 0; i + 1 < nums.length; i += 2) points.push({ x: r4(nums[i]), y: r4(nums[i + 1]) });
  return points;
}

function linePath(x1, y1, x2, y2) {
  return `M ${r4(x1)} ${r4(y1)} L ${r4(x2)} ${r4(y2)}`;
}

/** Build the geometry object for one shape element, or null to skip it. */
function buildGeometry(node, ctx) {
  const attrs = node.attrs;
  switch (node.name) {
    case 'rect': {
      const x = userLength(attrs.x, 'x', ctx, 0);
      const y = userLength(attrs.y, 'y', ctx, 0);
      const width = userLength(attrs.width, 'x', ctx, 0);
      const height = userLength(attrs.height, 'y', ctx, 0);
      if (!(width > 0) || !(height > 0)) {
        ctx.warn('rect without a positive width/height skipped');
        return null;
      }
      let rx = attrs.rx == null ? null : userLength(attrs.rx, 'x', ctx, null);
      let ry = attrs.ry == null ? null : userLength(attrs.ry, 'y', ctx, null);
      if (rx == null) rx = ry;
      if (ry == null) ry = rx;
      if (rx == null) rx = 0;
      if (ry == null) ry = 0;
      rx = Math.min(rx, width / 2);
      ry = Math.min(ry, height / 2);
      if (Math.abs(rx - ry) > 1e-6) {
        ctx.warn('rect with different rx/ry is approximated with a single corner radius');
      }
      const radius = Math.max(rx, ry);
      return {
        kind: 'rect',
        x: r4(x),
        y: r4(y),
        width: r4(width),
        height: r4(height),
        ...(radius > 0 ? { radius: r4(radius) } : {}),
      };
    }
    case 'circle': {
      const cx = userLength(attrs.cx, 'x', ctx, 0);
      const cy = userLength(attrs.cy, 'y', ctx, 0);
      const radius = userLength(attrs.r, 'diagonal', ctx, 0);
      if (!(radius > 0)) {
        ctx.warn('circle without a positive radius skipped');
        return null;
      }
      return { kind: 'ellipse', cx: r4(cx), cy: r4(cy), rx: r4(radius), ry: r4(radius) };
    }
    case 'ellipse': {
      const cx = userLength(attrs.cx, 'x', ctx, 0);
      const cy = userLength(attrs.cy, 'y', ctx, 0);
      const rx = userLength(attrs.rx, 'x', ctx, 0);
      const ry = userLength(attrs.ry, 'y', ctx, 0);
      if (!(rx > 0) || !(ry > 0)) {
        ctx.warn('ellipse without positive radii skipped');
        return null;
      }
      return { kind: 'ellipse', cx: r4(cx), cy: r4(cy), rx: r4(rx), ry: r4(ry) };
    }
    case 'line': {
      const x1 = userLength(attrs.x1, 'x', ctx, 0);
      const y1 = userLength(attrs.y1, 'y', ctx, 0);
      const x2 = userLength(attrs.x2, 'x', ctx, 0);
      const y2 = userLength(attrs.y2, 'y', ctx, 0);
      return { kind: 'path', d: linePath(x1, y1, x2, y2) };
    }
    case 'polyline': {
      const points = parsePointList(attrs.points, ctx);
      if (points.length < 2) {
        ctx.warn('polyline with fewer than two points skipped');
        return null;
      }
      const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      return { kind: 'path', d };
    }
    case 'polygon': {
      const points = parsePointList(attrs.points, ctx);
      if (points.length < 3) {
        ctx.warn('polygon with fewer than three points skipped');
        return null;
      }
      return { kind: 'polygon', points };
    }
    case 'path': {
      const d = attrs.d == null ? '' : String(attrs.d).trim();
      if (!d) {
        ctx.warn('path without path data skipped');
        return null;
      }
      return { kind: 'path', d };
    }
    default:
      return null;
  }
}

/** Resolve one paint value ("#fff", "url(#g)", "currentColor", "none"). */
function resolvePaintValue(raw, props, ctx) {
  if (raw == null) return [];
  const text = String(raw).trim();
  if (!text || text.toLowerCase() === 'none') return [];

  const url = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)\s*([\s\S]*)$/i.exec(text);
  if (url) {
    const reference = (url[1] ?? url[2] ?? url[3] ?? '').trim();
    const fallback = (url[4] ?? '').trim();
    if (!reference.startsWith('#')) {
      ctx.warn(`external paint reference "${reference}" is not supported; skipped`);
      return fallback ? resolvePaintValue(fallback, props, ctx) : [];
    }
    const paint = gradientPaint(reference.slice(1), ctx);
    if (paint) return [paint];
    if (fallback) return resolvePaintValue(fallback, props, ctx);
    ctx.warn(`paint reference "${reference}" was not found; skipped`);
    return [];
  }

  if (/^currentcolor$/i.test(text)) {
    const color = props.color && !/^currentcolor$/i.test(props.color) ? props.color : '#000000';
    return resolvePaintValue(color, props, ctx);
  }

  try {
    const paint = normalizePaint(text);
    return paint ? [paint] : [];
  } catch (err) {
    ctx.warn(`unsupported paint "${text}" skipped (${err.message})`);
    return [];
  }
}

function resolveFills(props, ctx) {
  const opacity = clamp01(props.fillOpacity);
  return resolvePaintValue(props.fill, props, ctx).map((paint) => ({
    ...paint,
    opacity: r4(clamp01(paint.opacity * opacity)),
  }));
}

function resolveStroke(props, ctx) {
  const paints = resolvePaintValue(props.stroke, props, ctx);
  if (paints.length === 0) return null;
  const width = num(props.strokeWidth, 0);
  if (!(width > 0)) return null;

  let lineCap = String(props.strokeLinecap ?? 'butt').toLowerCase();
  if (!LINE_CAPS.has(lineCap)) {
    ctx.warn(`invalid stroke-linecap "${lineCap}"; using butt`);
    lineCap = 'butt';
  }
  let lineJoin = String(props.strokeLinejoin ?? 'miter').toLowerCase();
  if (!LINE_JOINS.has(lineJoin)) {
    ctx.warn(`invalid stroke-linejoin "${lineJoin}"; using miter`);
    lineJoin = 'miter';
  }

  try {
    return normalizeStroke({
      paint: paints[0],
      width,
      opacity: clamp01(props.strokeOpacity),
      lineCap,
      lineJoin,
      miterLimit: num(props.strokeMiterlimit, 4),
      dash: props.strokeDasharray,
      dashOffset: num(props.strokeDashoffset, 0),
    });
  } catch (err) {
    ctx.warn(`stroke skipped (${err.message})`);
    return null;
  }
}

function renderShape(node, inherited, out, ctx) {
  const element = resolveElement(node, inherited, ctx);
  if (element.hidden) return;
  const geometry = buildGeometry(node, ctx);
  if (!geometry) return;

  const matrix = mul(inherited.matrix, element.matrix);
  const opacity = clamp01(inherited.opacity * element.opacity);
  const shape = { ...geometry };

  // A line has no area to fill; every other shape carries its own fill stack.
  shape.fills = node.name === 'line' ? [] : resolveFills(element.props, ctx);
  const stroke = resolveStroke(element.props, ctx);
  if (stroke) shape.strokes = [stroke];
  if (opacity < 1) shape.opacity = r4(opacity);
  if (String(element.props.fillRule).toLowerCase() === 'evenodd') shape.fillRule = 'evenodd';
  if (!isIdentity(matrix)) shape.transform = matrix.map(r4);
  out.push(shape);
}

function renderContainer(node, inherited, out, ctx) {
  const element = resolveElement(node, inherited, ctx);
  if (element.hidden) return;
  const matrix = mul(inherited.matrix, element.matrix);
  const opacity = clamp01(inherited.opacity * element.opacity);
  const childInherited = { props: element.props, opacity, matrix };
  for (const child of node.children) renderNode(child, childInherited, out, ctx);
}

function renderNode(node, inherited, out, ctx) {
  if (SILENT_TAGS.has(node.name)) return;
  if (node.name === 'style') {
    ctx.warn('CSS in <style> is not supported; only presentation attributes are imported');
    return;
  }
  if (node.name === 'g') {
    renderContainer(node, inherited, out, ctx);
    return;
  }
  if (node.name === 'svg') {
    ctx.warn('nested <svg> is treated as a group');
    renderContainer(node, inherited, out, ctx);
    return;
  }
  if (SHAPE_TAGS.has(node.name)) {
    renderShape(node, inherited, out, ctx);
    return;
  }
  ctx.warn(`unsupported element <${node.rawName ?? node.name}> skipped`);
}

// ---------------------------------------------------------------------------
// Document size
// ---------------------------------------------------------------------------

function readViewBox(root) {
  const raw = root.attrs.viewbox;
  if (raw == null || !String(raw).trim()) return null;
  const parts = String(raw).trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v)) || !(parts[2] > 0) || !(parts[3] > 0)) {
    failParse(`invalid viewBox "${raw}"`, 'use "min-x min-y width height" with a positive width and height');
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function resolveSize(root, viewBox, warn, maxSide) {
  const baseWidth = viewBox ? viewBox.width : DEFAULT_VIEWPORT.width;
  const baseHeight = viewBox ? viewBox.height : DEFAULT_VIEWPORT.height;
  const rawWidth = resolveDimension(root.attrs.width, baseWidth);
  const rawHeight = resolveDimension(root.attrs.height, baseHeight);

  let width = rawWidth ?? (viewBox ? viewBox.width : DEFAULT_VIEWPORT.width);
  let height = rawHeight ?? (viewBox ? viewBox.height : DEFAULT_VIEWPORT.height);
  if (!(width > 0) || !(height > 0)) {
    failParse('the root <svg> has no usable size', 'give it a positive width/height or a viewBox');
  }
  const intrinsicWidth = width;
  const intrinsicHeight = height;

  let factor = 1;
  const largest = Math.max(width, height);
  if (Number.isFinite(maxSide) && maxSide > 0 && largest > maxSide) {
    factor = maxSide / largest;
    width *= factor;
    height *= factor;
    warn(`SVG intrinsic size ${r4(largest)}px exceeds maxSide ${maxSide}; scaled down to fit`);
  }

  let matrix;
  if (viewBox) {
    const sx = width / viewBox.width;
    const sy = height / viewBox.height;
    matrix = [sx, 0, 0, sy, -viewBox.x * sx, -viewBox.y * sy];
  } else {
    matrix = [factor, 0, 0, factor, 0, 0];
  }
  return { width, height, matrix, intrinsicWidth, intrinsicHeight };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function toText(input) {
  if (typeof input === 'string') return input;
  if (Buffer.isBuffer(input)) return input.toString('utf8');
  if (input instanceof Uint8Array) return Buffer.from(input).toString('utf8');
  failParse(`SVG input must be a string or Buffer, got ${input === null ? 'null' : typeof input}`, 'read the file first, e.g. fs.readFile(path)');
  return '';
}

/**
 * Import an SVG document into shape content (version 2).
 *
 * @param {Buffer|string} input SVG markup
 * @param {{maxSide?: number}} [options] largest allowed layer side, in pixels
 * @returns {{content: object, warnings: string[], viewBox: {x:number,y:number,width:number,height:number}, width: number, height: number}}
 */
export async function importSvg(input, { maxSide = 8192 } = {}) {
  const warnings = [];
  const warn = (message) => {
    const text = String(message);
    if (!warnings.includes(text)) warnings.push(text);
  };

  const text = toText(input).replace(/^\uFEFF/, '');
  if (!text.trim()) failParse('the SVG input is empty');

  const root = parseXml(text);
  if (root.name !== 'svg') {
    failParse(`expected an <svg> root element, found <${root.name}>`);
  }

  const gradients = new Map();
  collectGradients(root, gradients, warn);

  const viewBox = readViewBox(root);
  const size = resolveSize(root, viewBox, warn, maxSide);
  const ctx = {
    gradients,
    gradientCache: new Map(),
    warn,
    viewportWidth: viewBox ? viewBox.width : size.intrinsicWidth,
    viewportHeight: viewBox ? viewBox.height : size.intrinsicHeight,
  };

  const shapes = [];
  const rootElement = resolveElement(root, { props: DEFAULT_PROPS, opacity: 1 }, ctx);
  if (!rootElement.hidden) {
    const inherited = {
      props: rootElement.props,
      opacity: rootElement.opacity,
      matrix: mul(size.matrix, rootElement.matrix),
    };
    for (const child of root.children) renderNode(child, inherited, shapes, ctx);
  }

  if (shapes.length === 0) warn('SVG contains no importable shapes');

  const content = {
    type: 'shape',
    version: 2,
    width: r4(size.width),
    height: r4(size.height),
    fills: [],
    strokes: [],
    shapes,
  };

  return {
    content,
    warnings,
    viewBox: viewBox ?? { x: 0, y: 0, width: r4(size.intrinsicWidth), height: r4(size.intrinsicHeight) },
    width: content.width,
    height: content.height,
  };
}
