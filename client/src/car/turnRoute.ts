// The route a car takes through a junction zone, drawn as the turn arrow and followed by the car's auto-steer.
//
// A zone with one member (a T-junction, a crossing of two roads) is crossed on a smooth curve from the lane where the car
// enters to the lane of the exit. A zone of several members (a roundabout, a dual-carriageway crossing) is crossed along
// the real roads between its members, in their direction of travel: a roundabout is driven around its ring.
//
// Pure code, so `node --test` can load it. World meters: x east, z south. A heading h faces (sin h, cos h) in x, z, so
// the right-hand side of a car going (dx, dz) is (-dz, dx).

import { nodeKey, type RoadGraph, type Zone, type ZoneExit } from '../town/roadGraph.ts';
import type { StreetSegment } from '../town/roads.ts';

export interface Vec2 { x: number; z: number }
/** A point on a lane with the direction of travel there. */
export interface LanePoint { x: number; z: number; heading: number }

export const LANE_OFFSET = 1.75; // m right of the center line, at most
export const ARROW_TAIL = 2.6;   // m of straight route past the exit's lane point
export const CURVE_SAMPLES = 24; // segments in a curve
const ROUTE_ROUNDS = 3;          // corner-cutting rounds that smooth a route along road vertices

/** How far right of the center line a car drives on the segment. */
export const laneOffset = (s: Pick<StreetSegment, 'halfWidth' | 'oneway'>) => (s.oneway ? 0 : Math.min(s.halfWidth / 2, LANE_OFFSET));

const facing = (heading: number): Vec2 => ({ x: Math.sin(heading), z: Math.cos(heading) });

function quadratic(a: Vec2, c: Vec2, b: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, m = 1 - t;
    out.push({ x: m * m * a.x + 2 * m * t * c.x + t * t * b.x, z: m * m * a.z + 2 * m * t * c.z + t * t * b.z });
  }
  return out;
}

function cubic(a: Vec2, c1: Vec2, c2: Vec2, b: Vec2, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, m = 1 - t;
    out.push({
      x: m * m * m * a.x + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * b.x,
      z: m * m * m * a.z + 3 * m * m * t * c1.z + 3 * m * t * t * c2.z + t * t * t * b.z,
    });
  }
  return out;
}

/**
 * A smooth curve from the entry lane point to the exit lane point. A quadratic Bézier whose control point is where the
 * two lane lines cross, so it hugs the corner on a right turn and swings wide on a left. When the lines don't cross ahead
 * of the entry and behind the exit (near-straight or U-shaped), a cubic with handles half the chord long.
 */
export function curve(entry: LanePoint, exit: LanePoint): Vec2[] {
  const a = facing(entry.heading), b = facing(exit.heading);
  const den = a.x * b.z - a.z * b.x, dx = exit.x - entry.x, dz = exit.z - entry.z;
  const crossing = Math.abs(den) > 1e-3;
  const s = crossing ? (dx * b.z - dz * b.x) / den : -1; // along the entry line to the crossing
  const u = crossing ? (dx * a.z - dz * a.x) / den : 1;  // along the exit line from the exit point (negative: behind it)
  const from = { x: entry.x, z: entry.z }, to = { x: exit.x, z: exit.z };
  if (s > 0 && u < 0) return quadratic(from, { x: entry.x + a.x * s, z: entry.z + a.z * s }, to, CURVE_SAMPLES);
  const half = Math.hypot(dx, dz) * 0.5;
  return cubic(from, { x: entry.x + a.x * half, z: entry.z + a.z * half }, { x: exit.x - b.x * half, z: exit.z - b.z * half }, to, CURVE_SAMPLES);
}

/** The route's end: `ARROW_TAIL` meters straight on along the exit. */
export const withTail = (path: Vec2[], exit: LanePoint): Vec2[] => {
  const h = facing(exit.heading);
  return [...path, { x: exit.x + h.x * ARROW_TAIL, z: exit.z + h.z * ARROW_TAIL }];
};

/** The lane point where the exit's road crosses the zone's edge, facing out. */
export function exitLanePoint(graph: RoadGraph, exit: ZoneExit): LanePoint {
  const s = graph.segments[exit.segment!];
  const length = Math.hypot(s.bx - s.ax, s.bz - s.az);
  const heading = Math.atan2(exit.dir! * (s.bx - s.ax) / length, exit.dir! * (s.bz - s.az) / length);
  const lane = laneOffset(s);
  return { x: exit.edgePoint!.x - Math.cos(heading) * lane, z: exit.edgePoint!.z + Math.sin(heading) * lane, heading };
}

interface Step { x: number; z: number; via: number; lane: number } // a vertex reached along segment `via`; `lane` is that segment's

/**
 * The shortest legal way along the zone's own roads from the vertex `from` to the member junction the exit leaves from:
 * going only along one-way roads' direction, and never straight back the way the car came (`avoid`, or behind `heading`
 * when the car is not at a road end). Null when there is none. A start that already is the member is a path of just it.
 */
function roadsThrough(graph: RoadGraph, zone: Zone, from: Vec2, avoid: Vec2 | null, heading: number | null, exit: ZoneExit): Step[] | null {
  const goal = nodeKey(exit.from.x, exit.from.z);
  const startKey = nodeKey(from.x, from.z);
  if (startKey === goal) return [{ x: from.x, z: from.z, via: -1, lane: 0 }];
  const reach = zone.radius + 1;
  const best = new Map<number, { cost: number; prev: number | null; step: Step }>();
  best.set(startKey, { cost: 0, prev: null, step: { x: from.x, z: from.z, via: -1, lane: 0 } });
  const open = new Set<number>([startKey]);
  const done = new Set<number>();
  while (open.size) {
    let at = -1, cost = Infinity;
    for (const key of open) if (best.get(key)!.cost < cost) { at = key; cost = best.get(key)!.cost; }
    open.delete(at);
    done.add(at);
    if (at === goal) break;
    const here = best.get(at)!.step;
    for (const [index, end] of graph.at(here.x, here.z)) {
      const s = graph.segments[index];
      const toB = end === 0; // leaving through end a runs a to b
      if (s.oneway !== 0 && (toB ? s.oneway !== 1 : s.oneway !== -1)) continue; // against a one-way road
      const nx = toB ? s.bx : s.ax, nz = toB ? s.bz : s.az;
      const dx = nx - here.x, dz = nz - here.z, length = Math.hypot(dx, dz);
      if (length === 0 || Math.hypot(nx - zone.x, nz - zone.z) > reach) continue;
      if (at === startKey) {
        if (avoid && Math.hypot(nx - avoid.x, nz - avoid.z) < 0.02) continue;      // not back along the road it came in on
        if (heading !== null && dx * Math.sin(heading) + dz * Math.cos(heading) < 0) continue; // nor back behind the car
      }
      const key = nodeKey(nx, nz);
      if (done.has(key)) continue;
      const total = cost + length;
      if (!best.has(key) || total < best.get(key)!.cost) {
        best.set(key, { cost: total, prev: at, step: { x: nx, z: nz, via: index, lane: laneOffset(s) } });
        open.add(key);
      }
    }
  }
  if (!best.has(goal) || !done.has(goal)) return null;
  const path: Step[] = [];
  for (let key: number | null = goal; key !== null; key = best.get(key)!.prev) path.push(best.get(key)!.step);
  return path.reverse();
}

/** Chaikin corner cutting, keeping the ends: rounds the corners between road vertices into a smooth line. */
function smooth(points: Vec2[], rounds: number): Vec2[] {
  let line = points;
  for (let r = 0; r < rounds && line.length > 2; r++) {
    const next: Vec2[] = [line[0]];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      if (i > 0) next.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      if (i < line.length - 2) next.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    next.push(line[line.length - 1]);
    line = next;
  }
  return line;
}

export const U_TURN_MARGIN = 0.6; // m between the top of a dead end's U-turn and the end of the road

/**
 * The U-turn at a dead end: straight on into the dead end in the car's lane, a half circle over to the lane of the
 * road coming back, and straight out to the exit. The half circle is as wide as the two lanes are apart and ends short
 * of the end of the road, so it is tight: a car follows it only at a crawl, with a hard steering lock (see TURN_AROUND_*).
 */
export function uTurnRoute(entry: LanePoint, exit: LanePoint, zoneRadius: number): Vec2[] {
  const a = facing(entry.heading), b = facing(exit.heading);
  const apart = Math.hypot(exit.x - entry.x, exit.z - entry.z);
  const R = Math.max(1, apart / 2);
  const f = Math.max(0.5, zoneRadius - R - U_TURN_MARGIN); // straight meters before and after the half circle
  const from = { x: entry.x + a.x * f, z: entry.z + a.z * f };
  const to = { x: exit.x - b.x * f, z: exit.z - b.z * f };
  const k = (4 / 3) * R;
  const half = cubic(from, { x: from.x + a.x * k, z: from.z + a.z * k }, { x: to.x - b.x * k, z: to.z - b.z * k }, to, CURVE_SAMPLES);
  return withTail([{ x: entry.x, z: entry.z }, ...half, { x: exit.x, z: exit.z }], exit);
}

export interface RouteStart {
  /** Where the route starts: the entry lane point at the zone's edge, or the car's own pose when it is replanned inside. */
  pose: LanePoint;
  /** The member junction the car's road reaches (at the zone's edge) or the vertex nearest ahead of the car. */
  node: Vec2 | null;
  /** The road end the car came from, which it may not turn straight back onto. */
  came: Vec2 | null;
}

/**
 * The route from `start` to the lane of `exit` on the zone's edge, plus the straight tail: points in order, the last
 * 2.6 m past the exit. Through a zone of several members it follows their roads in their direction of travel; it falls
 * back to the smooth curve when the zone is one junction, the roads don't connect legally, or the car is already there.
 */
export function routeThrough(graph: RoadGraph, zone: Zone, start: RouteStart, exit: ZoneExit): Vec2[] {
  const out = exitLanePoint(graph, exit);
  const direct = () => withTail(curve(start.pose, out), out);
  if (zone.kind === 'dead_end') return uTurnRoute(start.pose, out, zone.radius);
  if (zone.members.length < 2 || !start.node) return direct();
  const steps = roadsThrough(graph, zone, start.node, start.came, start.came ? null : start.pose.heading, exit);
  if (!steps || steps.length < 2) return direct();

  // The road vertices, each moved to the right-hand lane of the road the car leaves it along (the center line of a one-way road).
  const points: Vec2[] = [{ x: start.pose.x, z: start.pose.z }];
  for (let i = 0; i < steps.length; i++) {
    const here = steps[i];
    const next = steps[i + 1];
    const outDir = next ? { x: next.x - here.x, z: next.z - here.z } : facing(exit.heading);
    const inDir = i > 0 ? { x: here.x - steps[i - 1].x, z: here.z - steps[i - 1].z } : outDir;
    const norm = (v: Vec2) => { const l = Math.hypot(v.x, v.z) || 1; return { x: v.x / l, z: v.z / l }; };
    const a = norm(inDir), b = norm(outDir);
    const mid = norm({ x: a.x + b.x, z: a.z + b.z });
    const lane = next ? next.lane : laneOffset(graph.segments[exit.segment!]);
    points.push({ x: here.x - mid.z * lane, z: here.z + mid.x * lane });
  }
  points.push({ x: out.x, z: out.z });
  return withTail(smooth(points, ROUTE_ROUNDS), out);
}

/** The heading the route ends on, along its tail. */
export function routeHeading(route: Vec2[]): number {
  const a = route[route.length - 2], b = route[route.length - 1];
  return Math.atan2(b.x - a.x, b.z - a.z);
}

export interface Pursuit { steer: number; index: number }

/**
 * Pure pursuit along `route`: the steer (+1 is A, left) toward the point `lookahead` meters ahead of where the car is on it.
 * `from` is the route segment the car was last on; the search never goes back before it, and looks 40 segments ahead. The steer is limited to +-`limit`.
 */
export function pursue(route: Vec2[], pose: LanePoint, from: number, lookahead: number, gain: number, limit = 1): Pursuit {
  let index = Math.max(0, Math.min(from, route.length - 2)), bestDistance = Infinity, along = 0;
  for (let i = Math.max(0, from - 1); i < Math.min(route.length - 1, from + 40); i++) {
    const a = route[i], b = route[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
    const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((pose.x - a.x) * dx + (pose.z - a.z) * dz) / length2));
    const d = Math.hypot(pose.x - (a.x + dx * t), pose.z - (a.z + dz * t));
    if (d < bestDistance - 1e-9) { bestDistance = d; index = i; along = t * Math.sqrt(length2); }
  }
  // Walk `lookahead` meters on from the closest point.
  let remaining = lookahead + along;
  let i = index;
  let aim = route[route.length - 1];
  for (; i < route.length - 1; i++) {
    const length = Math.hypot(route[i + 1].x - route[i].x, route[i + 1].z - route[i].z);
    if (remaining <= length || i === route.length - 2) {
      const t = length === 0 ? 1 : remaining / length; // past the end: carries straight on along the last segment
      aim = { x: route[i].x + (route[i + 1].x - route[i].x) * t, z: route[i].z + (route[i + 1].z - route[i].z) * t };
      break;
    }
    remaining -= length;
  }
  const bearing = Math.atan2(aim.x - pose.x, aim.z - pose.z);
  const turn = Math.atan2(Math.sin(bearing - pose.heading), Math.cos(bearing - pose.heading));
  return { steer: Math.min(limit, Math.max(-limit, gain * turn)), index };
}

// How fast a route can be driven. Two limits, the lower wins:
//  - the route as a whole: the speed at which its average radius (its length divided by how far it turns) takes
//    `AVERAGE_ACCEL` of sideways acceleration, so wide junctions are quick and tight ones slow;
//  - its tightest bend: a kink where the route joins a road must not be taken faster than `KINK_ACCEL` allows.
export const AVERAGE_ACCEL = 6;               // m/s²
export const KINK_ACCEL = 15;                 // m/s²
export const ROUTE_SPEED_MIN = 15 / 3.6;      // m/s: no turn is taken slower than this ...
export const ROUTE_SPEED_MAX = 50 / 3.6;      // ... or needs to be slower than this when it is wide open
const BEND_SPAN = 4;                          // m each side of a point that its bend is measured over

/** The route resampled every meter, so bends are measured on even steps. */
function evenly(route: Vec2[]): Vec2[] {
  const line: Vec2[] = [route[0]];
  let carried = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i], length = Math.hypot(b.x - a.x, b.z - a.z);
    for (let d = 1 - carried; d <= length + 1e-9; d += 1) line.push({ x: a.x + (b.x - a.x) * d / length, z: a.z + (b.z - a.z) * d / length });
    carried = (carried + length) % 1;
  }
  return line;
}

/** The tightest bend of the route, as a radius in meters (Infinity: it has none). */
export function tightestRadius(route: Vec2[]): number {
  const line = evenly(route);
  let tightest = Infinity;
  for (let i = BEND_SPAN; i < line.length - BEND_SPAN; i++) {
    const a = line[i - BEND_SPAN], b = line[i], c = line[i + BEND_SPAN];
    const cross = Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x));
    if (cross < 1e-9) continue;
    const ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ac = Math.hypot(c.x - a.x, c.z - a.z);
    tightest = Math.min(tightest, (ab * bc * ac) / (2 * cross));
  }
  return tightest;
}

/** The route's length divided by the angle it turns through, in meters (Infinity: it hardly turns). */
export function averageRadius(route: Vec2[]): number {
  const line = evenly(route);
  let length = 0, turned = 0;
  for (let i = 1; i < line.length - 1; i++) {
    length += Math.hypot(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    const before = Math.atan2(line[i].x - line[i - 1].x, line[i].z - line[i - 1].z);
    const after = Math.atan2(line[i + 1].x - line[i].x, line[i + 1].z - line[i].z);
    turned += Math.abs(Math.atan2(Math.sin(after - before), Math.cos(after - before)));
  }
  return turned > 0.2 ? length / turned : Infinity;
}

/** The speed to take the route at, in m/s, between 15 and 50 km/h. */
export const routeSpeed = (route: Vec2[]): number =>
  Math.min(ROUTE_SPEED_MAX, Math.max(ROUTE_SPEED_MIN,
    Math.min(Math.sqrt(AVERAGE_ACCEL * averageRadius(route)), Math.sqrt(KINK_ACCEL * tightestRadius(route)))));
