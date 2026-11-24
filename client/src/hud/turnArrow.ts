// The turn arrow's shape, kept apart from three.js so `node --test` can check it: the curved path through a junction
// zone, and the vertex arrays of the ribbon layers and the head. glowRibbon.ts turns the arrays into a mesh.
//
// TN-37 draws the driver's queued turn in violet; the navigation overlay (TN-40) draws the route in cyan with the same
// layers, plus a quieter line along the road and a cyan rim around a violet arrow that is on the route.
//
// Positions are world meters: x east, z south. A heading h faces (sin h, cos h) in x, z.

import { ARROW_TAIL, CURVE_SAMPLES, curve, withTail, type LanePoint, type Vec2 } from '../car/turnRoute.ts';

export type { Vec2 };

export { ARROW_TAIL };
export const SAMPLES = CURVE_SAMPLES;
export type RGB = readonly [number, number, number];
export const VIOLET: RGB = [0x9b / 255, 0x5c / 255, 1];
export const CYAN: RGB = [0x22 / 255, 0xd3 / 255, 0xee / 255];

export interface Layer { width: number; color: readonly number[]; core: number }

/** Ribbon layers, bottom to top, in `color`. `core` layers get their dashes in the shader. */
export const layersOf = (color: RGB): readonly Layer[] => [
  { width: 2.4, color: [...color, 0.3], core: 0 },  // halo
  { width: 1.2, color: [...color, 1], core: 0 },    // body
  { width: 0.35, color: [1, 1, 1, 0.9], core: 1 },  // flowing core
];
export const LAYERS = layersOf(VIOLET);
export const HEAD = { width: 2.5, length: 2.4, halo: 0.6 };

/** The route line: a quieter ribbon with no head. */
export const LINE_LAYERS: readonly Layer[] = [
  { width: 1.6, color: [...CYAN, 0.2], core: 0 },
  { width: 0.8, color: [...CYAN, 0.55], core: 0 },
  { width: 0.25, color: [1, 1, 1, 0.7], core: 1 },
];

/**
 * The cyan rim around a violet arrow that is on the route: wider than violet's halo, with a bigger head. The glow adds
 * to what is behind it, so the rim is hollow where violet's solid body and head are (`gap`): drawn under them it would
 * wash the violet out to white.
 */
export const RIM_LAYERS: readonly Layer[] = [{ width: 3.6, color: [...CYAN, 0.45], core: 0 }];
export const RIM_HEAD = { grow: 0.9 }; // m around violet's head on every side
export const RIM_GAP = 1.2;            // m: violet's body width, left open in the rim

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

const empty = (): ArrowArrays => ({ positions: [], colors: [], along: [], core: [], indices: [] });

function vertex(out: ArrowArrays, x: number, y: number, z: number, color: readonly number[], along: number, core: number): number {
  out.positions.push(x, y, z);
  out.colors.push(color[0], color[1], color[2], color[3]);
  out.along.push(along);
  out.core.push(core);
  return out.along.length - 1;
}

const distancesOf = (path: Vec2[]) => {
  const d = [0];
  for (let i = 1; i < path.length; i++) d.push(d[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z));
  return d;
};

/** Each layer as a strip of quads along `path`, appended to `out`. */
function addRibbon(out: ArrowArrays, path: Vec2[], layers: readonly Layer[], y: number): number[] {
  const distances = distancesOf(path);
  for (const layer of layers) {
    const first = out.along.length;
    for (let i = 0; i < path.length; i++) {
      const before = path[Math.max(0, i - 1)], after = path[Math.min(path.length - 1, i + 1)];
      const tx = after.x - before.x, tz = after.z - before.z, length = Math.hypot(tx, tz) || 1;
      const nx = -tz / length * layer.width / 2, nz = tx / length * layer.width / 2; // to the left of travel in x, z
      vertex(out, path[i].x + nx, y, path[i].z + nz, layer.color, distances[i], layer.core);
      vertex(out, path[i].x - nx, y, path[i].z - nz, layer.color, distances[i], layer.core);
    }
    for (let i = 0; i < path.length - 1; i++) {
      const k = first + i * 2;
      out.indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  return distances;
}

/** Each layer as two strips along `path`, from `gap` / 2 to the layer's edge on either side: a ribbon open down the middle. */
function addBand(out: ArrowArrays, path: Vec2[], layers: readonly Layer[], gap: number, y: number): number[] {
  const distances = distancesOf(path);
  for (const layer of layers) {
    for (const side of [1, -1]) {
      const first = out.along.length;
      for (let i = 0; i < path.length; i++) {
        const before = path[Math.max(0, i - 1)], after = path[Math.min(path.length - 1, i + 1)];
        const tx = after.x - before.x, tz = after.z - before.z, length = Math.hypot(tx, tz) || 1;
        const nx = -tz / length * side, nz = tx / length * side;
        vertex(out, path[i].x + nx * layer.width / 2, y, path[i].z + nz * layer.width / 2, layer.color, distances[i], layer.core);
        vertex(out, path[i].x + nx * gap / 2, y, path[i].z + nz * gap / 2, layer.color, distances[i], layer.core);
      }
      for (let i = 0; i < path.length - 1; i++) {
        const k = first + i * 2;
        out.indices.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }
  return distances;
}

/** A triangle with its base `back` meters behind `end`, `half` wide each side, and its tip `length` ahead, along `heading`. */
function addTriangle(out: ArrowArrays, end: Vec2, heading: number, y: number, back: number, half: number, length: number, color: readonly number[], along: number): void {
  const h = facing(heading), r = { x: -h.z, z: h.x };
  const bx = end.x - h.x * back, bz = end.z - h.z * back;
  const k = vertex(out, bx + r.x * half, y, bz + r.z * half, color, along, 0);
  vertex(out, end.x + h.x * length, y, end.z + h.z * length, color, along, 0);
  vertex(out, bx - r.x * half, y, bz - r.z * half, color, along, 0);
  out.indices.push(k, k + 1, k + 2);
}

/**
 * Halo, body and core ribbons along `path` plus the head (a halo triangle under a solid one), as one set of arrays:
 * one geometry, one draw call. `heading` is the exit's, which the head points along. `color` tints the halo, body and
 * head; the core stays white.
 */
export function buildArrowArrays(path: Vec2[], heading: number, y = 0, color: RGB = VIOLET): ArrowArrays {
  const out = empty();
  const layers = layersOf(color);
  const distances = addRibbon(out, path, layers, y);
  // The head: base on the path's last point, pointing along the exit. The halo is wider and starts a little behind.
  const end = path[path.length - 1], total = distances[distances.length - 1];
  addTriangle(out, end, heading, y, HEAD.halo, HEAD.width / 2 + HEAD.halo, HEAD.length + HEAD.halo, layers[0].color, total);
  addTriangle(out, end, heading, y, 0, HEAD.width / 2, HEAD.length, layers[1].color, total);
  return out;
}

/**
 * The cyan rim around a violet arrow on the route: a 3.6 m ribbon open over violet's 1.2 m body, and around the head a
 * frame from violet's solid head out to a triangle `RIM_HEAD.grow` larger on every side (its two slanted sides).
 */
export function buildRimArrays(path: Vec2[], heading: number, y = 0): ArrowArrays {
  const out = empty();
  const distances = addBand(out, path, RIM_LAYERS, RIM_GAP, y);
  const end = path[path.length - 1], along = distances[distances.length - 1], color = RIM_LAYERS[0].color;
  const h = facing(heading), r = { x: -h.z, z: h.x }, g = RIM_HEAD.grow;
  const corner = (back: number, side: number) => vertex(out, end.x - h.x * back + r.x * side, y, end.z - h.z * back + r.z * side, color, along, 0);
  const tip = (length: number) => vertex(out, end.x + h.x * length, y, end.z + h.z * length, color, along, 0);
  const oL = corner(g, HEAD.width / 2 + g), oT = tip(HEAD.length + g), oR = corner(g, -(HEAD.width / 2 + g));
  const iL = corner(0, HEAD.width / 2), iT = tip(HEAD.length), iR = corner(0, -HEAD.width / 2);
  out.indices.push(oL, oT, iL, iL, oT, iT, oT, oR, iT, iT, oR, iR);
  return out;
}

/** Ribbons with no head along several separate pieces, as one set of arrays. Each piece counts its own meters. */
export function buildRibbonArrays(paths: Vec2[][], layers: readonly Layer[], y = 0): ArrowArrays {
  const out = empty();
  for (const path of paths) if (path.length > 1) addRibbon(out, path, layers, y);
  return out;
}

/** `b` added to the end of `a` (which is changed and returned), so two shapes share one geometry. */
export function appendArrays(a: ArrowArrays, b: ArrowArrays): ArrowArrays {
  const offset = a.along.length;
  a.positions.push(...b.positions);
  a.colors.push(...b.colors);
  a.along.push(...b.along);
  a.core.push(...b.core);
  for (const i of b.indices) a.indices.push(i + offset);
  return a;
}
