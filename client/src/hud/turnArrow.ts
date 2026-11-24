// The turn arrow's shape, kept apart from three.js so `node --test` can check it: the curved path through a junction
// zone, and the vertex arrays of the ribbon layers and the head. turnIntent.ts turns the arrays into a mesh.
//
// Positions are world meters: x east, z south. A heading h faces (sin h, cos h) in x, z.

import { ARROW_TAIL, CURVE_SAMPLES, curve, withTail, type LanePoint, type Vec2 } from '../car/turnRoute.ts';

export type { Vec2 };

export { ARROW_TAIL };
export const SAMPLES = CURVE_SAMPLES;
export const VIOLET: readonly [number, number, number] = [0x9b / 255, 0x5c / 255, 1];

/** Ribbon layers, bottom to top. `core` layers get their dashes in the shader. */
export const LAYERS = [
  { width: 2.4, color: [...VIOLET, 0.3], core: 0 },  // halo
  { width: 1.2, color: [...VIOLET, 1], core: 0 },    // body
  { width: 0.35, color: [1, 1, 1, 0.9], core: 1 },   // flowing core
] as const;
export const HEAD = { width: 2.5, length: 2.4, halo: 0.6 };

const facing = (heading: number): Vec2 => ({ x: Math.sin(heading), z: Math.cos(heading) });

/** The smooth curve from the entry lane point to the exit lane point, then 2.6 m straight on along the exit (see turnRoute.ts). */
export const arrowPath = (entry: LanePoint, exit: LanePoint): Vec2[] => withTail(curve(entry, exit), exit);

export interface ArrowArrays {
  positions: number[];  // x, y, z per vertex
  colors: number[];     // r, g, b, a per vertex
  along: number[];      // meters along the path
  core: number[];       // 1 on the flowing core
  indices: number[];
}

/**
 * Halo, body and core ribbons along `path` plus the head (a halo triangle under a solid one), as one set of arrays:
 * one geometry, one draw call. `heading` is the exit's, which the head points along.
 */
export function buildArrowArrays(path: Vec2[], heading: number, y = 0): ArrowArrays {
  const out: ArrowArrays = { positions: [], colors: [], along: [], core: [], indices: [] };
  const distances = [0];
  for (let i = 1; i < path.length; i++) distances.push(distances[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));

  const vertex = (x: number, z: number, color: readonly number[], along: number, core: number) => {
    out.positions.push(x, y, z);
    out.colors.push(color[0], color[1], color[2], color[3]);
    out.along.push(along);
    out.core.push(core);
    return out.along.length - 1;
  };

  for (const layer of LAYERS) {
    const first = out.along.length;
    for (let i = 0; i < path.length; i++) {
      const before = path[Math.max(0, i - 1)], after = path[Math.min(path.length - 1, i + 1)];
      const tx = after.x - before.x, tz = after.z - before.z, length = Math.hypot(tx, tz) || 1;
      const nx = -tz / length * layer.width / 2, nz = tx / length * layer.width / 2; // to the left of travel in x, z
      vertex(path[i].x + nx, path[i].z + nz, layer.color, distances[i], layer.core);
      vertex(path[i].x - nx, path[i].z - nz, layer.color, distances[i], layer.core);
    }
    for (let i = 0; i < path.length - 1; i++) {
      const k = first + i * 2;
      out.indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }

  // The head: base on the path's last point, pointing along the exit. The halo is wider and starts a little behind.
  const end = path[path.length - 1], h = facing(heading), r = { x: -h.z, z: h.x };
  const total = distances[distances.length - 1];
  const triangle = (back: number, half: number, length: number, color: readonly number[]) => {
    const bx = end.x - h.x * back, bz = end.z - h.z * back;
    const k = vertex(bx + r.x * half, bz + r.z * half, color, total, 0);
    vertex(end.x + h.x * length, end.z + h.z * length, color, total, 0);
    vertex(bx - r.x * half, bz - r.z * half, color, total, 0);
    out.indices.push(k, k + 1, k + 2);
  };
  triangle(HEAD.halo, HEAD.width / 2 + HEAD.halo, HEAD.length + HEAD.halo, LAYERS[0].color);
  triangle(0, HEAD.width / 2, HEAD.length, LAYERS[1].color);
  return out;
}
