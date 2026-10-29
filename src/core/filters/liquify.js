import { Raster } from '../raster.js';

/**
 * Liquify: a parametric displacement field.
 *
 * Each op pulls pixels from a source coordinate derived from the output pixel,
 * so the transform is defined by inverse sampling and stays deterministic.
 *  - push:   drag pixels by (dx, dy) inside the falloff radius
 *  - twirl:  rotate around (x, y) by `angle` degrees at full strength
 *  - pinch:  pull towards (x, y) (negative strength bulges outwards)
 */

function falloff(d2, r2) {
  if (d2 >= r2) return 0;
  const t = 1 - d2 / r2;
  return t * t;
}

export default {
  name: 'liquify',
  label: 'Liquify',
  params: {
    ops: {
      type: 'json',
      default: [],
      desc: 'array of {mode,x,y,radius,dx,dy,angle,strength} displacement ops',
    },
  },
  scaleOps: true,
  apply(raster, { ops = [] } = {}) {
    if (!Array.isArray(ops) || ops.length === 0) return raster.clone();
    const w = raster.width, h = raster.height;
    const out = new Raster(w, h);
    const prepared = ops.map((op) => {
      const radius = Math.max(1, Number(op.radius ?? 100));
      return {
        mode: op.mode ?? 'push',
        x: Number(op.x ?? 0),
        y: Number(op.y ?? 0),
        radius,
        r2: radius * radius,
        dx: Number(op.dx ?? 0),
        dy: Number(op.dy ?? 0),
        angle: ((Number(op.angle ?? 0)) * Math.PI) / 180,
        strength: Number(op.strength ?? 1),
      };
    });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sx = x, sy = y;
        for (const op of prepared) {
          const ddx = x - op.x, ddy = y - op.y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= op.r2) continue;
          const f = falloff(d2, op.r2) * op.strength;
          if (op.mode === 'push') {
            sx -= op.dx * f;
            sy -= op.dy * f;
          } else if (op.mode === 'twirl') {
            const a = op.angle * f;
            const cos = Math.cos(a), sin = Math.sin(a);
            const rx = ddx * cos - ddy * sin;
            const ry = ddx * sin + ddy * cos;
            sx = op.x + rx;
            sy = op.y + ry;
          } else if (op.mode === 'pinch') {
            const scale = 1 - 0.75 * f * op.strength;
            sx = op.x + ddx * scale;
            sy = op.y + ddy * scale;
          }
        }
        const s = raster.sampleBilinear(sx, sy);
        const i = (y * w + x) * 4;
        out.data[i] = s[0];
        out.data[i + 1] = s[1];
        out.data[i + 2] = s[2];
        out.data[i + 3] = s[3];
      }
    }
    return out;
  },
};
