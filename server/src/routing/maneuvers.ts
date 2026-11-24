// Turns a search result into the API's Route (TN-38): the driven polyline, one stretch per road piece, and one
// maneuver per junction or roundabout on the way.
//
// Junction nodes are grouped into one maneuver so a roundabout, or the two crossings of a dual carriageway, read as
// one instruction instead of a zigzag of small turns: the next junction node joins the group when the piece leading to
// it is part of a roundabout, or, outside roundabouts, when that piece is shorter than GROUP_GAP and the node is within
// GROUP_SPAN of the group's first node. Nothing joins once the route has left a ring.

import type { Maneuver, Route, RouteStretch, TurnKind } from '@town-navigator/shared';
import { canMove, edgeCoords, type RouteGraph } from './graph.ts';
import type { PathResult } from './search.ts';
import { bearingOf, wrap180 } from './snap.ts';

export const GROUP_GAP = 20;    // m
export const GROUP_SPAN = 30;   // m
export const BEARING_SPAN = 30; // m of road a bearing is measured over

type Point = [number, number];

/**
 * One directed edge as driven: from `from` to `to` meters along it. `before` is the edge up to `to` and `after` the
 * edge from `from` on, so bearings at a junction are measured over the road even where the car starts or stops on it.
 */
interface Leg { edge: number; from: number; to: number; coords: Point[]; before: Point[]; after: Point[] }

const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const bearing360 = (deg: number) => Math.round(((deg % 360) + 360) % 360) % 360;

/** The part of a polyline between `a` and `b` meters along it. */
export function slice(coords: Point[], a: number, b: number): Point[] {
  const out: Point[] = [];
  let walked = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i], [bx, by] = coords[i + 1], length = Math.hypot(bx - ax, by - ay);
    const at = (d: number): Point => {
      const t = length ? Math.min(1, Math.max(0, (d - walked) / length)) : 0;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    };
    if (!out.length && a <= walked + length) out.push(at(a));
    if (out.length) {
      if (b <= walked + length) { out.push(at(b)); return out; }
      out.push([bx, by]);
    }
    walked += length;
  }
  if (!out.length) out.push(coords[coords.length - 1]);
  if (out.length === 1) out.push(out[0]);
  return out;
}

/** The bearing over up to `span` meters at the start of a polyline (or at its end, looking forward). */
function bearingAt(coords: Point[], atEnd: boolean, span = BEARING_SPAN): number {
  const line = atEnd ? [...coords].reverse() : coords;
  let walked = 0, k = 1;
  for (; k < line.length - 1; k++) {
    walked += Math.hypot(line[k][0] - line[k - 1][0], line[k][1] - line[k - 1][1]);
    if (walked >= span) break;
  }
  const [x0, y0] = line[0], [x1, y1] = line[Math.min(k, line.length - 1)];
  const b = bearingOf(x1 - x0, y1 - y0);
  return atEnd ? b + 180 : b;
}

function turnOf(angle: number): TurnKind {
  const a = Math.abs(angle), side = angle < 0 ? 'left' : 'right';
  if (a < 30) return 'straight';
  if (a < 60) return `slight_${side}`;
  if (a < 130) return side;
  if (a < 170) return `sharp_${side}`;
  return 'uturn';
}

function legsOf(g: RouteGraph, path: PathResult): Leg[] {
  const startAt = g.edgeLength[path.seed.edge] - (path.seed.cost - path.seed.penalty);
  const leg = (edge: number, from: number, to: number): Leg => {
    const coords = edgeCoords(g, edge), length = g.edgeLength[edge];
    return { edge, from, to, coords: slice(coords, from, to), before: slice(coords, 0, to), after: slice(coords, from, length) };
  };
  if (!path.edges.length) return [leg(path.seed.edge, startAt, path.goal.offset)];
  const legs = path.edges.map((e, i) => leg(e, i === 0 ? startAt : 0, g.edgeLength[e]));
  legs.push(leg(path.goal.edge, 0, path.goal.offset));
  return legs;
}

interface Group { members: number[]; inLeg: number; outLeg: number; along: number; ring: boolean; joinNext: boolean }

export function toRoute(g: RouteGraph, path: PathResult): Route {
  const legs = legsOf(g, path);
  const pieceOf = (leg: Leg) => g.pieces[g.edgePiece[leg.edge]];

  const points: Point[] = [];
  const stretches: RouteStretch[] = [];
  const legEnd: number[] = []; // meters driven at the end of each leg
  let driven = 0;
  for (const leg of legs) {
    const pc = pieceOf(leg);
    const first = points.length ? Math.max(0, points.length - 1) : 0;
    for (const [x, y] of leg.coords) {
      const p: Point = [r2(x), r2(y)];
      const last = points[points.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) points.push(p);
    }
    stretches.push({ start: first, highway: pc.highway, oneway: pc.oneway !== 0, ...(pc.name ? { name: pc.name } : {}) });
    driven += leg.to - leg.from;
    legEnd.push(driven);
  }
  if (points.length === 1) points.push([...points[0]]);

  // Group the junction nodes between legs.
  const groups: Group[] = [];
  let group: Group | null = null;
  const distance = (a: number, b: number) => Math.hypot(g.nodeX[a] - g.nodeX[b], g.nodeY[a] - g.nodeY[b]);
  for (let k = 0; k < legs.length - 1; k++) {
    const node = g.edgeTo[legs[k].edge];
    const next = legs[k + 1];
    const nextNode = g.edgeTo[next.edge];
    const short = (grp: Group) => !grp.ring && !pieceOf(legs[k]).roundabout && g.edgeLength[next.edge] < GROUP_GAP
      && distance(grp.members[0], nextNode) < GROUP_SPAN;
    if (g.degree[node] < 3) {
      // Not a junction (two ways joined end to end): the group may only carry on along a ring or a short hop.
      if (group?.joinNext) group.joinNext = pieceOf(next).roundabout || short(group);
      continue;
    }
    if (group?.joinNext) {
      group.members.push(node);
      group.outLeg = k + 1;
      group.ring ||= pieceOf(legs[k]).roundabout;
    } else {
      group = { members: [node], inLeg: k, outLeg: k + 1, along: legEnd[k], ring: false, joinNext: false };
      groups.push(group);
    }
    group.joinNext = pieceOf(next).roundabout || short(group);
  }

  const maneuvers = groups.map((grp): Maneuver | null => {
    const inBearing = bearingAt(legs[grp.inLeg].before, true);
    const outBearing = bearingAt(legs[grp.outLeg].after, false);
    const angle = Math.round(wrap180(outBearing - inBearing));
    // A car standing on a junction node already faces its way out when that is straight on: nothing to say there.
    if (grp.along < 1 && !grp.ring && Math.abs(angle) < 30) return null;
    const last = grp.members[grp.members.length - 1];
    const inEdge = legs[grp.outLeg - 1].edge, outEdge = legs[grp.outLeg].edge;
    const outPiece = g.pieces[g.edgePiece[outEdge]];
    let ambiguous = false;
    if (!grp.ring && Math.abs(angle) < 30) {
      for (let k = g.outStart[last]; k < g.outStart[last + 1]; k++) {
        const alt = g.outEdges[k];
        if (alt === outEdge || !canMove(g, inEdge, alt)) continue;
        if (Math.abs(wrap180(bearingAt(edgeCoords(g, alt), false) - inBearing)) < Math.abs(angle)) ambiguous = true;
      }
    }
    const exitsOff = (node: number) => {
      for (let k = g.outStart[node]; k < g.outStart[node + 1]; k++) if (!g.pieces[g.edgePiece[g.outEdges[k]]].roundabout) return true;
      return false;
    };
    const first = grp.members[0];
    return {
      nodes: grp.members.map(n => g.nodeId[n]),
      x: r2(g.nodeX[first]), y: r2(g.nodeY[first]),
      along: r1(grp.along),
      inBearing: bearing360(inBearing), outBearing: bearing360(outBearing), angle,
      turn: grp.ring ? 'roundabout' : turnOf(angle),
      ...(grp.ring ? { exit: grp.members.slice(1, -1).filter(exitsOff).length + 1 } : {}),
      ...(outPiece.name ? { road: outPiece.name } : {}),
      ...(ambiguous ? { ambiguous } : {}),
    };
  }).filter((m): m is Maneuver => m !== null);

  // Starting against the car's bearing (the seed carried the U-turn penalty): the first thing to do is turn round.
  if (path.seed.penalty > 0) {
    const outBearing = bearingAt(legs[0].after, false);
    const [x, y] = legs[0].coords[0];
    maneuvers.unshift({
      nodes: [], x: r2(x), y: r2(y), along: 0,
      inBearing: bearing360(outBearing + 180), outBearing: bearing360(outBearing), angle: 180, turn: 'uturn',
      ...(pieceOf(legs[0]).name ? { road: pieceOf(legs[0]).name } : {}),
    });
  }

  const [sx, sy] = legs[0].coords[0];
  const [dx, dy] = legs[legs.length - 1].coords[legs[legs.length - 1].coords.length - 1];
  return {
    distance: r1(driven),
    points,
    stretches,
    start: { x: r2(sx), y: r2(sy) },
    destination: { x: r2(dx), y: r2(dy) },
    maneuvers,
  };
}
