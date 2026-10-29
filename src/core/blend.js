/**
 * Blend modes.
 *
 * Separable modes operate per channel; non-separable ones (HSL family) need
 * all three channels at once. Formulas follow the W3C compositing spec plus
 * Photoshop's extra modes (linear-burn/dodge/light, pin-light, subtract,
 * divide) so that a designer's mental model carries over.
 *
 * All values are floats in 0..1.
 */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function colorBurn(cb, cs) {
  return cs <= 0 ? 0 : cb >= 1 ? 1 : 1 - Math.min(1, (1 - cb) / cs);
}

function colorDodge(cb, cs) {
  return cs >= 1 ? 1 : cb <= 0 ? 0 : Math.min(1, cb / (1 - cs));
}

function softLight(cb, cs) {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
  return cb + (2 * cs - 1) * (d - cb);
}

// --- non-separable helpers (W3C "Compositing and Blending Level 1") ---
const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(out) {
  const l = lum(out[0], out[1], out[2]);
  const n = Math.min(out[0], out[1], out[2]);
  const x = Math.max(out[0], out[1], out[2]);
  if (n < 0) {
    const denom = l - n;
    if (denom !== 0) for (let i = 0; i < 3; i++) out[i] = l + ((out[i] - l) * l) / denom;
  }
  if (x > 1) {
    const denom = x - l;
    if (denom !== 0) for (let i = 0; i < 3; i++) out[i] = l + ((out[i] - l) * (1 - l)) / denom;
  }
}

function setLum(out, l) {
  const d = l - lum(out[0], out[1], out[2]);
  out[0] += d;
  out[1] += d;
  out[2] += d;
  clipColor(out);
}

function sat(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function setSat(out, s) {
  const idx = [0, 1, 2].sort((a, b) => out[a] - out[b]);
  const [min, mid, max] = idx;
  if (out[max] > out[min]) {
    out[mid] = ((out[mid] - out[min]) * s) / (out[max] - out[min]);
    out[max] = s;
  } else {
    out[mid] = 0;
    out[max] = 0;
  }
  out[min] = 0;
}

/**
 * @typedef {{label: string, separable: boolean, f?: (cb:number,cs:number)=>number, f3?: (out: Float64Array, cb: Float64Array, cs: Float64Array) => void, group: string}} BlendMode
 */

/** @type {Map<string, BlendMode>} */
export const BLEND_MODES = new Map();

function sep(name, label, f, group = 'normal') {
  BLEND_MODES.set(name, { label, separable: true, f, group });
}

function nonsep(name, label, f3) {
  BLEND_MODES.set(name, { label, separable: false, f3, group: 'component' });
}

sep('normal', 'Normal', (cb, cs) => cs, 'normal');
sep('darken', 'Darken', (cb, cs) => Math.min(cb, cs), 'darken');
sep('multiply', 'Multiply', (cb, cs) => cb * cs, 'darken');
sep('color-burn', 'Color Burn', colorBurn, 'darken');
sep('linear-burn', 'Linear Burn', (cb, cs) => Math.max(0, cb + cs - 1), 'darken');
sep('lighten', 'Lighten', (cb, cs) => Math.max(cb, cs), 'lighten');
sep('screen', 'Screen', (cb, cs) => cb + cs - cb * cs, 'lighten');
sep('color-dodge', 'Color Dodge', colorDodge, 'lighten');
sep('linear-dodge', 'Linear Dodge (Add)', (cb, cs) => Math.min(1, cb + cs), 'lighten');
sep('overlay', 'Overlay', (cb, cs) => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs)), 'contrast');
sep('soft-light', 'Soft Light', softLight, 'contrast');
sep('hard-light', 'Hard Light', (cb, cs) => (cs <= 0.5 ? 2 * cs * cb : 1 - 2 * (1 - cs) * (1 - cb)), 'contrast');
sep('vivid-light', 'Vivid Light', (cb, cs) => (cs <= 0.5 ? colorBurn(cb, 2 * cs) : colorDodge(cb, 2 * cs - 1)), 'contrast');
sep('linear-light', 'Linear Light', (cb, cs) => clamp01(cb + 2 * cs - 1), 'contrast');
sep('pin-light', 'Pin Light', (cb, cs) => (cs <= 0.5 ? Math.min(cb, 2 * cs) : Math.max(cb, 2 * cs - 1)), 'contrast');
sep('hard-mix', 'Hard Mix', (cb, cs) => (cb + cs >= 1 ? 1 : 0), 'contrast');
sep('difference', 'Difference', (cb, cs) => Math.abs(cb - cs), 'inversion');
sep('exclusion', 'Exclusion', (cb, cs) => cb + cs - 2 * cb * cs, 'inversion');
sep('subtract', 'Subtract', (cb, cs) => Math.max(0, cb - cs), 'inversion');
sep('divide', 'Divide', (cb, cs) => (cs <= 0 ? 1 : Math.min(1, cb / cs)), 'inversion');

nonsep('darker-color', 'Darker Color', (out, cb, cs) => {
  const use = lum(cs[0], cs[1], cs[2]) < lum(cb[0], cb[1], cb[2]) ? cs : cb;
  out[0] = use[0]; out[1] = use[1]; out[2] = use[2];
});
nonsep('lighter-color', 'Lighter Color', (out, cb, cs) => {
  const use = lum(cs[0], cs[1], cs[2]) > lum(cb[0], cb[1], cb[2]) ? cs : cb;
  out[0] = use[0]; out[1] = use[1]; out[2] = use[2];
});
nonsep('hue', 'Hue', (out, cb, cs) => {
  out[0] = cs[0]; out[1] = cs[1]; out[2] = cs[2];
  setSat(out, sat(cb[0], cb[1], cb[2]));
  setLum(out, lum(cb[0], cb[1], cb[2]));
});
nonsep('saturation', 'Saturation', (out, cb, cs) => {
  out[0] = cb[0]; out[1] = cb[1]; out[2] = cb[2];
  setSat(out, sat(cs[0], cs[1], cs[2]));
  setLum(out, lum(cb[0], cb[1], cb[2]));
});
nonsep('color', 'Color', (out, cb, cs) => {
  out[0] = cs[0]; out[1] = cs[1]; out[2] = cs[2];
  setLum(out, lum(cb[0], cb[1], cb[2]));
});
nonsep('luminosity', 'Luminosity', (out, cb, cs) => {
  out[0] = cb[0]; out[1] = cb[1]; out[2] = cb[2];
  setLum(out, lum(cs[0], cs[1], cs[2]));
});

export const BLEND_MODE_NAMES = [...BLEND_MODES.keys()];

export function resolveBlend(name) {
  const m = BLEND_MODES.get(name);
  if (!m) {
    const err = new Error(`unknown blend mode: ${name}`);
    err.code = 'E_BLEND_MODE';
    err.hint = `known modes: ${BLEND_MODE_NAMES.join(', ')}`;
    throw err;
  }
  return m;
}
