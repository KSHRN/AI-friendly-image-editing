/**
 * 2D affine matrices, same convention as Canvas/SVG:
 *
 *   | a c e |
 *   | b d f |
 *   | 0 0 1 |
 *
 * x' = a*x + c*y + e
 * y' = b*x + d*y + f
 */

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function translate(x, y) {
  return [1, 0, 0, 1, x, y];
}

export function scale(sx, sy = sx) {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotate(radians) {
  const c = Math.cos(radians), s = Math.sin(radians);
  return [c, s, -s, c, 0, 0];
}

export function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invert(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (Math.abs(det) < 1e-12) return null;
  const id = 1 / det;
  return [
    d * id,
    -b * id,
    -c * id,
    a * id,
    (c * f - d * e) * id,
    (b * e - a * f) * id,
  ];
}

/** Matrix that maps content units to canvas units for a layer transform. */
export function layerMatrix(transform, contentWidth, contentHeight) {
  const {
    x = 0, y = 0,
    scaleX = 1, scaleY = 1,
    rotation = 0,
    anchorX = 0, anchorY = 0,
    skewX = 0, skewY = 0,
  } = transform ?? {};
  const ax = anchorX * contentWidth;
  const ay = anchorY * contentHeight;
  let m = multiply(translate(x, y), rotate((rotation * Math.PI) / 180));
  if (skewX || skewY) {
    m = multiply(m, [1, Math.tan((skewY * Math.PI) / 180), Math.tan((skewX * Math.PI) / 180), 1, 0, 0]);
  }
  m = multiply(m, scale(scaleX, scaleY));
  m = multiply(m, translate(-ax, -ay));
  return m;
}

/** Axis-aligned canvas-space bounds of a transformed content rectangle. */
export function matrixBounds(m, width, height) {
  const pts = [apply(m, 0, 0), apply(m, width, 0), apply(m, 0, height), apply(m, width, height)];
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

/** Approximate uniform scale factor of a matrix (average singular value). */
export function matrixScale(m) {
  const [a, b, c, d] = m;
  const sx = Math.hypot(a, b);
  const sy = Math.hypot(c, d);
  return (sx + sy) / 2;
}

export function matrixMaxScale(m) {
  const [a, b, c, d] = m;
  return Math.max(Math.hypot(a, b), Math.hypot(c, d));
}

export function isIdentity(m) {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

export function roundMatrix(m, d = 6) {
  const f = 10 ** d;
  return m.map((v) => Math.round(v * f) / f);
}
