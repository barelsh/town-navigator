// The town's drivable road graph for routing (TN-38), built from the backend town file.
//
// Nodes are the OSM nodes where a road ends or roads meet (degree != 2, as the tiler counts it); every road is cut
// at them into pieces. Each piece gives one directed edge per legal direction. Directed edges are kept in CSR
// typed arrays (the out-edges of node n are outEdges[outStart[n] .. outStart[n + 1])), so a search allocates nothing
// per edge. Positions are the town's map meters: x east, y north.

import type { OsmRestriction, RoadFeature, Town } from '@town-navigator/shared';
import { DRIVABLE_HIGHWAYS, nodeDegrees, onewayOf } from '../../../data/scripts/roadRules.js';

export interface Piece {
  /** Node indexes of the first and last coordinate. */
  a: number;
  b: number;
  length: number;
  wayId: number;
  name?: string;
  highway: string;
  roundabout: boolean;
  /** 1: a to b only, -1: b to a only, 0: both. */
  oneway: 1 | -1 | 0;
  coords: [number, number][];
}

/** At a via node, arriving along a way: the ways a car may not take (no_*), or the only ones it may (only_*). */
export interface TurnRule { only: boolean; ways: Set<number> }

export interface RouteGraph {
  nodeId: Float64Array; // OSM ids exceed 2^31
  nodeX: Float64Array;
  nodeY: Float64Array;
  /** The tiler's degree: road ends count 1, pass-throughs 2. 3+ is a junction. */
  degree: Uint16Array;
  pieces: Piece[];
  outStart: Int32Array;
  outEdges: Int32Array;
  edgeFrom: Int32Array;
  edgeTo: Int32Array;
  edgePiece: Int32Array;
  /** 1 when the edge runs along the piece's coordinates (a to b). */
  edgeForward: Uint8Array;
  edgeLength: Float64Array;
  /** Keyed by ruleKey(via node, from way). */
  rules: Map<string, TurnRule>;
  /** GRID_CELL m cells → [piece, segment] pairs of the piece segments touching the cell, flattened. */
  grid: Map<number, number[]>;
  /** `roadsWithoutIds`: drivable roads left out because they have no OSM node ids. */
  stats: { nodes: number; edges: number; restrictions: number; viaWaySkipped: number; roadsWithoutIds: number };
}

export const GRID_CELL = 50; // m

export const ruleKey = (viaNode: number, fromWay: number) => `${viaNode}:${fromWay}`;
export const cellKey = (cx: number, cy: number) => (cx + 1e5) * 2e5 + (cy + 1e5);

const isRoad = (f: Town['features'][number]): f is RoadFeature =>
  f.geometry?.type === 'LineString' && DRIVABLE_HIGHWAYS.has(f.properties?.highway ?? '');

/** The way id in a feature id like "way/131049510", or NaN. */
const wayIdOf = (f: RoadFeature) => Number(String(f.id ?? f.properties?.['@id'] ?? '').split('/')[1]);

function polylineLength(coords: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  return total;
}

export function buildGraph(town: Town): RouteGraph {
  const drivable = town.features.filter(isRoad);
  const roads = drivable.filter(f => f.osm?.nodes && f.osm.nodes.length === f.geometry.coordinates.length);
  const degrees = nodeDegrees(roads, (f, i) => f.osm!.nodes[i]);

  const index = new Map<number, number>();
  const ids: number[] = [], xs: number[] = [], ys: number[] = [];
  const nodeOf = (id: number, pos: number[]) => {
    let n = index.get(id);
    if (n === undefined) {
      n = ids.length;
      index.set(id, n);
      ids.push(id);
      xs.push(pos[0]);
      ys.push(pos[1]);
    }
    return n;
  };

  const pieces: Piece[] = [];
  for (const f of roads) {
    const nodes = f.osm!.nodes, c = f.geometry.coordinates as [number, number][];
    const p = f.properties ?? {};
    let start = 0;
    for (let i = 1; i < nodes.length; i++) {
      if (i < nodes.length - 1 && degrees.get(nodes[i]) === 2) continue;
      const coords = c.slice(start, i + 1).map(([x, y]) => [x, y] as [number, number]);
      const length = polylineLength(coords);
      if (length > 0) {
        pieces.push({
          a: nodeOf(nodes[start], c[start]), b: nodeOf(nodes[i], c[i]), length, wayId: wayIdOf(f),
          ...(p.name ? { name: p.name } : {}), highway: p.highway!, roundabout: p.junction === 'roundabout',
          oneway: onewayOf(p), coords,
        });
      }
      start = i;
    }
  }

  // Directed edges, then CSR by from-node.
  const from: number[] = [], to: number[] = [], piece: number[] = [], forward: number[] = [];
  pieces.forEach((pc, i) => {
    if (pc.oneway !== -1) { from.push(pc.a); to.push(pc.b); piece.push(i); forward.push(1); }
    if (pc.oneway !== 1) { from.push(pc.b); to.push(pc.a); piece.push(i); forward.push(0); }
  });
  const nodeCount = ids.length, edgeCount = from.length;
  const outStart = new Int32Array(nodeCount + 1);
  for (const n of from) outStart[n + 1]++;
  for (let n = 0; n < nodeCount; n++) outStart[n + 1] += outStart[n];
  const fill = outStart.slice(0, nodeCount);
  const outEdges = new Int32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) outEdges[fill[from[e]]++] = e;

  const { rules, applied, viaWaySkipped } = buildRules(town.osm?.restrictions ?? [], index);

  const grid = new Map<number, number[]>();
  pieces.forEach((pc, i) => {
    for (let s = 0; s < pc.coords.length - 1; s++) {
      const [ax, ay] = pc.coords[s], [bx, by] = pc.coords[s + 1];
      for (let cx = Math.floor(Math.min(ax, bx) / GRID_CELL); cx <= Math.floor(Math.max(ax, bx) / GRID_CELL); cx++) {
        for (let cy = Math.floor(Math.min(ay, by) / GRID_CELL); cy <= Math.floor(Math.max(ay, by) / GRID_CELL); cy++) {
          const k = cellKey(cx, cy);
          (grid.get(k) ?? grid.set(k, []).get(k)!).push(i, s);
        }
      }
    }
  });

  const degree = new Uint16Array(nodeCount);
  ids.forEach((id, n) => { degree[n] = degrees.get(id) ?? 0; });

  return {
    nodeId: Float64Array.from(ids), nodeX: Float64Array.from(xs), nodeY: Float64Array.from(ys), degree,
    pieces, outStart, outEdges,
    edgeFrom: Int32Array.from(from), edgeTo: Int32Array.from(to), edgePiece: Int32Array.from(piece),
    edgeForward: Uint8Array.from(forward), edgeLength: Float64Array.from(piece.map(i => pieces[i].length)),
    rules, grid,
    stats: { nodes: nodeCount, edges: edgeCount, restrictions: applied, viaWaySkipped, roadsWithoutIds: drivable.length - roads.length },
  };
}

/** Via-node restrictions as rules; via-way ones are skipped and counted. */
function buildRules(restrictions: OsmRestriction[], index: Map<number, number>) {
  const rules = new Map<string, TurnRule>();
  let applied = 0, viaWaySkipped = 0;
  for (const r of restrictions) {
    const kind = r.tags.restriction ?? r.tags['restriction:motorcar'];
    const via = r.members.filter(m => m.role === 'via');
    if (via.some(m => m.type !== 'node')) { viaWaySkipped++; continue; } // one or more via ways
    if (!kind || via.length !== 1) continue;
    const node = index.get(via[0].ref);
    const fromWays = r.members.filter(m => m.role === 'from' && m.type === 'way').map(m => m.ref);
    const toWays = r.members.filter(m => m.role === 'to' && m.type === 'way').map(m => m.ref);
    const only = kind.startsWith('only_');
    if (node === undefined || !fromWays.length || !toWays.length || (!only && !kind.startsWith('no_'))) continue;
    for (const w of fromWays) {
      const key = ruleKey(node, w);
      const existing = rules.get(key);
      if (!existing || (only && !existing.only)) rules.set(key, { only, ways: new Set(toWays) }); // an only_* rule wins
      else if (existing.only === only) for (const t of toWays) existing.ways.add(t);
    }
    applied++;
  }
  return { rules, applied, viaWaySkipped };
}

/** Whether a car arriving along edge `from` may leave along edge `to` (turn restrictions only). */
export function allowed(g: RouteGraph, from: number, to: number): boolean {
  const rule = g.rules.get(ruleKey(g.edgeTo[from], g.pieces[g.edgePiece[from]].wayId));
  if (!rule) return true;
  const toWay = g.pieces[g.edgePiece[to]].wayId;
  return rule.only ? rule.ways.has(toWay) : !rule.ways.has(toWay);
}

/** Whether `from` → `to` is a legal move: not straight back along the same piece (unless it is the only way on, a dead end) and not restricted. */
export function canMove(g: RouteGraph, from: number, to: number): boolean {
  const node = g.edgeTo[from];
  if (g.edgePiece[to] === g.edgePiece[from] && g.outStart[node + 1] - g.outStart[node] > 1) return false;
  return allowed(g, from, to);
}

/** The directed edge's coordinates in its direction of travel. */
export function edgeCoords(g: RouteGraph, e: number): [number, number][] {
  const coords = g.pieces[g.edgePiece[e]].coords;
  return g.edgeForward[e] ? coords : [...coords].reverse();
}
