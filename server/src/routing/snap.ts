// Snapping the route's ends onto the road graph (TN-38).

import { GRID_CELL, cellKey, type RouteGraph } from './graph.ts';

export const SNAP_RADIUS = 60;      // m: no road nearer than this, no route
export const ALIGN_MAX = 100;       // degrees between the car's bearing and a piece direction it may start along
export const U_TURN_PENALTY = 50;   // m added to starting the other way
export const TIE = 0.5;             // m: pieces this much farther than the nearest count as just as near

/** A point on a piece: `t` meters from its a end. */
export interface PiecePoint { piece: number; x: number; y: number; t: number; distance: number; segment: number }

/** A directed edge the search starts on, its cost to the edge's end, and the part of that cost that is a U-turn penalty. */
export interface Seed { edge: number; cost: number; penalty: number }

export interface StartSnap extends PiecePoint { seeds: Seed[] }

/** The goal piece reached along `edge` (entered at its from-node), `offset` meters on. */
export interface GoalEntry { edge: number; offset: number }

export interface GoalSnap extends PiecePoint {
  entries: GoalEntry[];
  /** entries by the edge's from-node */
  byNode: Map<number, GoalEntry[]>;
}

/** Degrees clockwise from north of the direction (dx, dy). */
export const bearingOf = (dx: number, dy: number) => (Math.atan2(dx, dy) * 180) / Math.PI;
export const wrap180 = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** The closest point of each piece within `radius` of (x, y), nearest first. */
export function nearbyPieces(g: RouteGraph, x: number, y: number, radius = SNAP_RADIUS): PiecePoint[] {
  const best = new Map<number, PiecePoint>();
  const reach = Math.ceil(radius / GRID_CELL);
  const cx = Math.floor(x / GRID_CELL), cy = Math.floor(y / GRID_CELL);
  for (let i = cx - reach; i <= cx + reach; i++) {
    for (let j = cy - reach; j <= cy + reach; j++) {
      const cell = g.grid.get(cellKey(i, j));
      if (!cell) continue;
      for (let k = 0; k < cell.length; k += 2) {
        const piece = cell[k], segment = cell[k + 1];
        const coords = g.pieces[piece].coords, [ax, ay] = coords[segment], [bx, by] = coords[segment + 1];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
        const u = l2 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        const px = ax + dx * u, py = ay + dy * u, distance = Math.hypot(x - px, y - py);
        if (distance > radius || (best.get(piece)?.distance ?? Infinity) <= distance) continue;
        let t = u * Math.sqrt(l2);
        for (let s = 0; s < segment; s++) t += Math.hypot(coords[s + 1][0] - coords[s][0], coords[s + 1][1] - coords[s][1]);
        best.set(piece, { piece, x: px, y: py, t, distance, segment });
      }
    }
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance);
}

/** The directed edges of a piece: [forward edge or -1, backward edge or -1]. */
function edgesOf(g: RouteGraph, piece: number): [number, number] {
  const pc = g.pieces[piece];
  let forward = -1, backward = -1;
  for (const node of [pc.a, pc.b]) {
    for (let k = g.outStart[node]; k < g.outStart[node + 1]; k++) {
      const e = g.outEdges[k];
      if (g.edgePiece[e] !== piece) continue;
      if (g.edgeForward[e]) forward = e; else backward = e;
    }
  }
  return [forward, backward];
}

/**
 * Where the car joins the road: the nearest piece with a legal direction within ALIGN_MAX of its bearing, seeded that
 * way at the remaining length, and the other way (when legal) with the U-turn penalty. With no aligned piece, the
 * nearest piece's legal directions all carry the penalty. Null when no road is within SNAP_RADIUS.
 */
export function snapStart(g: RouteGraph, x: number, y: number, bearing: number): StartSnap | null {
  const near = nearbyPieces(g, x, y);
  if (!near.length) return null;
  const direction = (p: PiecePoint, forward: boolean) => {
    const [ax, ay] = g.pieces[p.piece].coords[p.segment], [bx, by] = g.pieces[p.piece].coords[p.segment + 1];
    return forward ? bearingOf(bx - ax, by - ay) : bearingOf(ax - bx, ay - by);
  };
  const seedsOf = (p: PiecePoint, aligned: number | null): Seed[] => {
    const [f, b] = edgesOf(g, p.piece), length = g.pieces[p.piece].length, seeds: Seed[] = [];
    const penalty = (edge: number) => (edge === aligned ? 0 : U_TURN_PENALTY);
    if (f >= 0) seeds.push({ edge: f, cost: length - p.t + penalty(f), penalty: penalty(f) });
    if (b >= 0) seeds.push({ edge: b, cost: p.t + penalty(b), penalty: penalty(b) });
    return seeds;
  };
  // The nearest aligned piece direction. Pieces as near as it (within TIE m: a car standing on a junction node is on all
  // of them) are tied: prefer the one the car is arriving on (least road left on it, so every exit at the node stays
  // open), then the one closest to its bearing.
  let best: { p: PiecePoint; edge: number; left: number; turn: number } | null = null;
  for (const p of near) {
    if (best && p.distance > best.p.distance + TIE) break;
    const [f, b] = edgesOf(g, p.piece), length = g.pieces[p.piece].length;
    for (const [edge, forward] of [[f, true], [b, false]] as const) {
      const turn = Math.abs(wrap180(direction(p, forward) - bearing));
      if (edge < 0 || turn > ALIGN_MAX) continue;
      const left = forward ? length - p.t : p.t;
      if (!best || left < best.left - TIE || (Math.abs(left - best.left) <= TIE && turn < best.turn)) best = { p, edge, left, turn };
    }
  }
  if (best) return { ...best.p, seeds: seedsOf(best.p, best.edge) };
  return { ...near[0], seeds: seedsOf(near[0], null) };
}

/** Where the destination joins the road: the nearest point on any piece, reachable along either legal direction. */
export function snapGoal(g: RouteGraph, x: number, y: number): GoalSnap | null {
  const p = nearbyPieces(g, x, y)[0];
  if (!p) return null;
  const [f, b] = edgesOf(g, p.piece), length = g.pieces[p.piece].length;
  const entries: GoalEntry[] = [];
  if (f >= 0) entries.push({ edge: f, offset: p.t });
  if (b >= 0) entries.push({ edge: b, offset: length - p.t });
  const byNode = new Map<number, GoalEntry[]>();
  for (const entry of entries) {
    const node = g.edgeFrom[entry.edge];
    (byNode.get(node) ?? byNode.set(node, []).get(node)!).push(entry);
  }
  return { ...p, entries, byNode };
}
