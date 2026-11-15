import { pointInRing, type Point2 } from './geometry.ts';

const SNAP = 0.5;            // meters, wall offsets closer than this share one roof line
const MAX_ROOF_CORNERS = 24; // busier outlines get a flat roof

/** A rectangle in the frame of the house's longest wall. */
export interface RoofRect { minU: number; maxU: number; minV: number; maxV: number }

export interface HipRoofPlan {
  /** Unit vector of the longest wall: u runs along it, v is perpendicular. */
  ux: number;
  uz: number;
  rects: RoofRect[];
}

/** Groups nearby coordinates and returns each value's group average. */
function snapValues(values: number[]): Map<number, number> {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const snapped = new Map<number, number>();
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] - sorted[i] <= SNAP) j++;
    const group = sorted.slice(i, j + 1);
    const average = group.reduce((sum, v) => sum + v, 0) / group.length;
    group.forEach(v => snapped.set(v, average));
    i = j + 1;
  }
  return snapped;
}

/**
 * Every largest rectangle that fits inside the outline, in the frame of its longest wall.
 * One hip roof per rectangle: where they overlap, the depth buffer keeps the highest
 * surface, and that surface is the ridges and valleys of a real cross-hipped roof.
 * Returns null when the outline is not made of right angles or has too many corners.
 */
export function planHipRoof(ring: Point2[]): HipRoofPlan | null {
  if (ring.length > MAX_ROOF_CORNERS) return null;

  let ux = 1, uz = 0, longest = 0;
  ring.forEach(([ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % ring.length];
    const length = Math.hypot(bx - ax, bz - az);
    if (length > longest) { longest = length; ux = (bx - ax) / length; uz = (bz - az) / length; }
  });

  const framed = ring.map(([x, z]): Point2 => [x * ux + z * uz, z * ux - x * uz]);
  const square = framed.every(([a, b], i) => {
    const [c, d] = framed[(i + 1) % framed.length];
    return Math.abs(c - a) <= SNAP || Math.abs(d - b) <= SNAP;
  });
  if (!square) return null;

  const snapU = snapValues(framed.map(p => p[0]));
  const snapV = snapValues(framed.map(p => p[1]));
  const outline = framed.map(([a, b]): Point2 => [snapU.get(a)!, snapV.get(b)!]);
  const us = [...new Set(snapU.values())].sort((a, b) => a - b);
  const vs = [...new Set(snapV.values())].sort((a, b) => a - b);
  const filled = us.slice(1).map((u, i) => vs.slice(1).map((v, j) =>
    pointInRing((us[i] + u) / 2, (vs[j] + v) / 2, outline)));

  const rects: RoofRect[] = [];
  const columns = filled.length, rows = filled[0]?.length ?? 0;
  for (let i0 = 0; i0 < columns; i0++) {
    const open: boolean[] = new Array(rows).fill(true);
    for (let i1 = i0; i1 < columns; i1++) {
      open.forEach((isOpen, j) => { open[j] = isOpen && filled[i1][j]; });
      for (let j0 = 0; j0 < rows; j0++) {
        if (!open[j0]) continue;
        let j1 = j0;
        while (j1 + 1 < rows && open[j1 + 1]) j1++;
        const spans = (column: number) => column >= 0 && column < columns &&
          filled[column].slice(j0, j1 + 1).every(Boolean);
        if (!spans(i0 - 1) && !spans(i1 + 1)) {
          rects.push({ minU: us[i0], maxU: us[i1 + 1], minV: vs[j0], maxV: vs[j1 + 1] });
        }
        j0 = j1;
      }
    }
  }
  return rects.length ? { ux, uz, rects } : null;
}
