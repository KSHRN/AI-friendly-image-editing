/**
 * Curves: monotone cubic interpolation through control points.
 *
 * Points are [x,y] in 0..255. Monotone Hermite (Fritsch–Carlson) is used so
 * the curve never overshoots between points — this matters because overshoot
 * produces halos that agents would then have to debug.
 */

function buildLut(points) {
  const pts = [...points]
    .map(([x, y]) => [Math.max(0, Math.min(255, Number(x))), Math.max(0, Math.min(255, Number(y)))])
    .sort((a, b) => a[0] - b[0]);
  if (pts.length === 0) return identityLut();
  if (pts.length === 1) {
    const v = new Uint8ClampedArray(256).fill(pts[0][1]);
    return v;
  }
  // de-duplicate x
  const dedup = [];
  for (const p of pts) {
    if (dedup.length && Math.abs(dedup[dedup.length - 1][0] - p[0]) < 1e-9) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  if (dedup.length === 1) return new Uint8ClampedArray(256).fill(dedup[0][1]);

  const n = dedup.length;
  const xs = dedup.map((p) => p[0]);
  const ys = dedup.map((p) => p[1]);
  const dx = [], dy = [], slopes = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    dy[i] = ys[i + 1] - ys[i];
    slopes[i] = dy[i] / dx[i];
  }
  const m = new Array(n);
  m[0] = slopes[0];
  m[n - 1] = slopes[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slopes[i - 1] * slopes[i] <= 0) m[i] = 0;
    else m[i] = (slopes[i - 1] + slopes[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slopes[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slopes[i];
    const b = m[i + 1] / slopes[i];
    const h = Math.sqrt(a * a + b * b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * slopes[i];
      m[i + 1] = t * b * slopes[i];
    }
  }

  const lut = new Uint8ClampedArray(256);
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    if (x <= xs[0]) {
      lut[x] = ys[0];
      continue;
    }
    if (x >= xs[n - 1]) {
      lut[x] = ys[n - 1];
      continue;
    }
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const h = xs[seg + 1] - xs[seg];
    const t = (x - xs[seg]) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    lut[x] = h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1];
  }
  return lut;
}

function identityLut() {
  const lut = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  return lut;
}

export default {
  name: 'curves',
  label: 'Curves',
  params: {
    rgb: { type: 'curve', default: [[0, 0], [255, 255]], desc: 'control points [[x,y],...] 0..255' },
    r: { type: 'curve', desc: 'optional red-channel curve' },
    g: { type: 'curve', desc: 'optional green-channel curve' },
    b: { type: 'curve', desc: 'optional blue-channel curve' },
  },
  create({ rgb, r, g, b } = {}) {
    const luts = [
      r ? buildLut(r) : identityLut(),
      g ? buildLut(g) : identityLut(),
      b ? buildLut(b) : identityLut(),
    ];
    if (rgb) {
      const master = buildLut(rgb);
      for (let c = 0; c < 3; c++) {
        const lut = luts[c];
        for (let i = 0; i < 256; i++) lut[i] = master[lut[i]];
      }
    }
    return {
      map(rr, gg, bb, out) {
        out[0] = luts[0][Math.round(rr)];
        out[1] = luts[1][Math.round(gg)];
        out[2] = luts[2][Math.round(bb)];
      },
    };
  },
};
