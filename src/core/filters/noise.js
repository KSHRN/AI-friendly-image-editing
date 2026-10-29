import { Raster } from '../raster.js';

/** Seeded xorshift32 — deterministic noise, no Math.random anywhere. */
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0xffffffff;
  };
}

export default {
  name: 'noise',
  label: 'Add Noise',
  params: {
    amount: { type: 'number', default: 12, desc: 'noise amplitude 0..255' },
    seed: { type: 'integer', default: 1, desc: 'deterministic seed' },
    monochrome: { type: 'boolean', default: false },
    gaussian: { type: 'boolean', default: true },
  },
  apply(raster, { amount = 12, seed = 1, monochrome = false, gaussian = true } = {}) {
    const amp = Math.max(0, Math.min(255, Number(amount)));
    if (amp === 0) return raster.clone();
    const rng = makeRng(seed);
    const out = raster.clone();
    const { data } = out;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      let dr, dg, db;
      if (monochrome) {
        dr = dg = db = gaussian ? (rng() + rng() + rng() - 1.5) / 1.5 : rng() * 2 - 1;
      } else {
        dr = gaussian ? (rng() + rng() + rng() - 1.5) / 1.5 : rng() * 2 - 1;
        dg = gaussian ? (rng() + rng() + rng() - 1.5) / 1.5 : rng() * 2 - 1;
        db = gaussian ? (rng() + rng() + rng() - 1.5) / 1.5 : rng() * 2 - 1;
      }
      data[i] = data[i] + dr * amp;
      data[i + 1] = data[i + 1] + dg * amp;
      data[i + 2] = data[i + 2] + db * amp;
    }
    return out;
  },
};
