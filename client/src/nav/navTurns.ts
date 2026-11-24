// The route on the road (TN-40): which junction zones of the local road graph the route's maneuvers fall in, the
// path an arrow takes through each one, and the lane-offset pieces of the route line between them.
//
// Pure code, so `node --test` can load it. World meters: x east, z south. A heading h faces (sin h, cos h) in x, z, so
// the right-hand side of a car going (dx, dz) is (-dz, dx).

import { exitLanePoint, laneOffset, routeHeading, routeThrough, type LanePoint, type Vec2 } from '../car/turnRoute.ts';
import { buildArrowArrays, buildRimArrays, appendArrays, CYAN, type ArrowArrays } from '../hud/turnArrow.ts';
import type { RoadGraph, Zone, ZoneExit } from '../town/roadGraph.ts';
import { roadStyle } from '../town/roadStyles.ts';
import { isShown, type WorldManeuver, type WorldRoute } from './routeProgress.ts';

export const TURNS_AHEAD = 2;
export const LINE_AHEAD = 500;                     // m of route line ahead of the car
export const EXIT_MATCH = (45 * Math.PI) / 180;    // the route must leave within this of a legal exit's heading
export const MEMBER_MATCH = 0.5;                   // m: a route point this close to a member junction is on it

/** One junction zone the route turns through, with the arrow's path through it. */
export interface NavTurn {
  /** The route's maneuver the zone was matched from, and the last one merged into it (the same unless two fell in one zone). */
  index: number;
  last: number;
  zone: Zone;
  /** Where the route's lane enters the zone circle, facing in. */
  entry: LanePoint;
  exit: ZoneExit;
  /** From the entry to the exit's lane, plus the 2.6 m tail, through routeThrough: the same path TN-37's arrow takes. */
  path: Vec2[];
  /** The heading the head points along. */
  heading: number;
  /** Meters along the route where it leaves the zone circle: the arrow goes away once the car is past it. */
  leaveAlong: number;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** The route point at (or nearest to) `along` meters. */
export function pointIndexAt(route: WorldRoute, along: number): number {
  const { cum } = route;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { // the first point at or past `along`
    const mid = (lo + hi) >> 1;
    if (cum[mid] < along) lo = mid + 1; else hi = mid;
  }
  return lo > 0 && along - cum[lo - 1] < cum[lo] - along ? lo - 1 : lo;
}

/** How far right of the route's center line the car drives on the segment that starts at point `i`. */
export function laneAt(route: WorldRoute, i: number): number {
  let stretch = route.stretches[0];
  for (const s of route.stretches) { if (s.start <= i) stretch = s; else break; }
  if (!stretch) return 0;
  const halfWidth = (roadStyle({ highway: stretch.highway })?.width ?? 6) / 2;
  return laneOffset({ halfWidth, oneway: stretch.oneway ? 1 : 0 });
}

/** Where segment a → b crosses the circle: the first crossing going in, or the last going out, as a fraction of it. */
function crossingAt(a: Vec2, b: Vec2, c: { x: number; z: number; radius: number }, entering: boolean): number {
  const dx = b.x - a.x, dz = b.z - a.z, ox = a.x - c.x, oz = a.z - c.z;
  const A = dx * dx + dz * dz, B = 2 * (dx * ox + dz * oz), C = ox * ox + oz * oz - c.radius * c.radius;
  if (A === 0) return 0;
  const root = Math.sqrt(Math.max(0, B * B - 4 * A * C));
  return Math.min(1, Math.max(0, (-B + (entering ? -root : root)) / (2 * A)));
}

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
const inside = (p: Vec2, zone: Zone) => Math.hypot(p.x - zone.x, p.z - zone.z) <= zone.radius;

/** A lane point `lane` meters right of `p` facing `heading`, as exitLanePoint places one. */
const inLane = (p: Vec2, heading: number, lane: number): LanePoint =>
  ({ x: p.x - Math.cos(heading) * lane, z: p.z + Math.sin(heading) * lane, heading });

/** The route's lane point where its polyline crosses into the zone circle, walking back from point `at`. */
function entryOf(route: WorldRoute, zone: Zone, at: number): { pose: LanePoint; index: number } | null {
  const pts = route.points;
  for (let i = at; i > 0; i--) {
    const a = pts[i - 1], b = pts[i];
    if (!inside(a, zone) && inside(b, zone)) {
      const heading = Math.atan2(b.x - a.x, b.z - a.z);
      return { pose: inLane(lerp(a, b, crossingAt(a, b, zone, true)), heading, laneAt(route, i - 1)), index: i };
    }
  }
  if (pts.length > 1 && inside(pts[0], zone)) { // the route starts inside the zone: from its first point
    const heading = Math.atan2(pts[1].x - pts[0].x, pts[1].z - pts[0].z);
    return { pose: inLane(pts[0], heading, laneAt(route, 0)), index: 0 };
  }
  return null;
}

/** Where the route's polyline leaves the zone circle after point `at`: the heading there and the meters along. */
function leaveOf(route: WorldRoute, zone: Zone, at: number): { heading: number; along: number; index: number } | null {
  const pts = route.points;
  for (let i = Math.max(0, at); i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (inside(a, zone) && !inside(b, zone)) {
      const t = crossingAt(a, b, zone, false);
      return { heading: Math.atan2(b.x - a.x, b.z - a.z), along: route.cum[i] + t * (route.cum[i + 1] - route.cum[i]), index: i };
    }
  }
  return null; // the route ends inside the zone
}

/** The legal exit (one a car may leave by, with a road matched) whose heading is closest to `heading`, within `max`. */
export function closestExit(graph: RoadGraph, zone: Zone, heading: number, max = EXIT_MATCH): ZoneExit | null {
  let best: ZoneExit | null = null, bestTurn = max;
  for (const exit of zone.exits) {
    if (exit.flow === 'in' || exit.segment === undefined || !exit.dir || !exit.edgePoint) continue;
    const turn = Math.abs(wrapAngle(exitLanePoint(graph, exit).heading - heading));
    if (turn <= bestTurn) { bestTurn = turn; best = exit; }
  }
  return best;
}

/** The zone a maneuver happens in: by the OSM ids of its junction nodes, or else the zone around its first node. */
export function zoneOf(graph: RoadGraph, m: WorldManeuver): Zone | null {
  if (m.nodes.length) {
    const byId = graph.zones.find(z => z.members.some(j => j.id !== null && m.nodes.includes(j.id)));
    if (byId) return byId;
  }
  return graph.zonesAt(m.wx, m.wz)[0] ?? null;
}

/** The arrow for maneuver `index`, or null when its zone isn't loaded or the route can't be matched to the zone's exits. */
export function matchManeuver(graph: RoadGraph, route: WorldRoute, index: number): NavTurn | null {
  const m = route.maneuvers[index];
  if (!m.nodes.length) return null; // the U-turn at the start is on a road, not at a junction
  const zone = zoneOf(graph, m);
  if (!zone) return null;
  const at = pointIndexAt(route, m.along);
  const entry = entryOf(route, zone, at);
  const leave = leaveOf(route, zone, at);
  if (!entry || !leave) return null;
  const exit = closestExit(graph, zone, leave.heading);
  if (!exit) return null;
  // The member the route reaches first, as routeThrough's start node; else the one nearest the entry.
  let node: Vec2 | null = null;
  for (let i = entry.index; i <= leave.index && !node; i++) {
    const p = route.points[i];
    node = zone.members.find(j => Math.hypot(j.x - p.x, j.z - p.z) < MEMBER_MATCH) ?? null;
  }
  node ??= zone.members.reduce((a, b) =>
    Math.hypot(a.x - entry.pose.x, a.z - entry.pose.z) <= Math.hypot(b.x - entry.pose.x, b.z - entry.pose.z) ? a : b);
  const path = routeThrough(graph, zone, { pose: entry.pose, node: { x: node.x, z: node.z }, came: null }, exit);
  return { index, last: index, zone, entry: entry.pose, exit, path, heading: routeHeading(path), leaveAlong: leave.along };
}

/**
 * The next `count` zones ahead of `along` where the route turns (a maneuver that isn't straight, or is ambiguous), in
 * order. Maneuvers that fall in one zone become one turn. `cache` keeps the matches for one route and graph.
 */
export function upcomingTurns(graph: RoadGraph, route: WorldRoute, along: number, count = TURNS_AHEAD,
  cache?: Map<number, NavTurn | null>): NavTurn[] {
  const out: NavTurn[] = [];
  for (let i = 0; i < route.maneuvers.length; i++) {
    const m = route.maneuvers[i];
    if (!isShown(m) || !m.nodes.length) continue;
    let turn = cache?.get(i);
    if (turn === undefined) {
      turn = matchManeuver(graph, route, i);
      cache?.set(i, turn);
    }
    if (!turn || turn.leaveAlong <= along) continue;
    const previous = out[out.length - 1];
    if (previous && previous.zone === turn.zone) { previous.last = i; continue; }
    if (out.length === count) break;
    out.push(turn);
  }
  return out;
}

export interface Circle { x: number; z: number; radius: number }

interface LinePoint extends Vec2 { seg: number } // `seg`: the route segment whose lane the point is in

/**
 * The route line from `along` to `length` meters on (or the destination), cut out inside the circles, each piece moved
 * into the right-hand lane of the road it runs along.
 */
export function lineSpans(route: WorldRoute, along: number, length = LINE_AHEAD, cuts: Circle[] = []): Vec2[][] {
  const { points, cum } = route;
  const n = points.length;
  if (n < 2) return [];
  const from = Math.max(0, Math.min(along, cum[n - 1])), to = Math.min(cum[n - 1], from + length);
  if (to - from < 0.01) return [];
  const at = (d: number): LinePoint => {
    let i = 0;
    while (i < n - 2 && cum[i + 1] < d) i++;
    const span = cum[i + 1] - cum[i];
    return { ...lerp(points[i], points[i + 1], span ? (d - cum[i]) / span : 0), seg: i };
  };
  const center: LinePoint[] = [at(from)];
  for (let k = center[0].seg + 1; k < n && cum[k] < to; k++) {
    const last = center[center.length - 1];
    if (Math.hypot(points[k].x - last.x, points[k].z - last.z) > 1e-3) center.push({ ...points[k], seg: k });
  }
  const end = at(to);
  if (Math.hypot(end.x - center[center.length - 1].x, end.z - center[center.length - 1].z) > 1e-3) center.push(end);

  // Cut out the circles: split each segment where it crosses one, and keep the parts whose middle is outside them all.
  const pieces: LinePoint[][] = [];
  let piece: LinePoint[] = [];
  const flush = () => { if (piece.length > 1) pieces.push(piece); piece = []; };
  const cut = (p: Vec2) => cuts.some(c => Math.hypot(p.x - c.x, p.z - c.z) < c.radius);
  for (let k = 0; k < center.length - 1; k++) {
    const a = center[k], b = center[k + 1];
    const ts = [0, 1];
    for (const c of cuts) {
      for (const entering of [true, false]) {
        const t = crossingAt(a, b, c, entering);
        if (t > 0 && t < 1 && Math.abs(Math.hypot(lerp(a, b, t).x - c.x, lerp(a, b, t).z - c.z) - c.radius) < 1e-6) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    for (let j = 0; j < ts.length - 1; j++) {
      if (ts[j + 1] - ts[j] < 1e-9) continue;
      if (cut(lerp(a, b, (ts[j] + ts[j + 1]) / 2))) { flush(); continue; }
      if (!piece.length) piece.push({ ...lerp(a, b, ts[j]), seg: a.seg });
      piece.push({ ...lerp(a, b, ts[j + 1]), seg: a.seg });
    }
  }
  flush();

  // Into the lane: right of travel by the lane of the road each point is on.
  return pieces.map(line => line.map((p, i) => {
    const before = line[Math.max(0, i - 1)], after = line[Math.min(line.length - 1, i + 1)];
    const tx = after.x - before.x, tz = after.z - before.z, l = Math.hypot(tx, tz) || 1;
    const lane = laneAt(route, p.seg);
    return { x: p.x - (tz / l) * lane, z: p.z + (tx / l) * lane };
  }));
}

/** A closed circle of `radius` meters around `c`, for the ring at the destination. */
export function ringPath(c: Vec2, radius: number, samples = 32): Vec2[] {
  return Array.from({ length: samples + 1 }, (_, i) => {
    const a = (i / samples) * Math.PI * 2;
    return { x: c.x + Math.sin(a) * radius, z: c.z + Math.cos(a) * radius };
  });
}

/** Where the driver's queued turn rides on the route: the zone, and TN-37's violet path through it. */
export interface OnRoute { zone: Zone; path: Vec2[] }

/**
 * The arrows' arrays: a full cyan arrow per turn, except at the zone where the queued turn is the route's, which gets
 * the cyan rim along the violet arrow's own path instead.
 */
export function turnArrays(turns: NavTurn[], onRoute: OnRoute | null, y: number): ArrowArrays {
  const out: ArrowArrays = { positions: [], colors: [], along: [], core: [], indices: [] };
  for (const turn of turns) {
    appendArrays(out, onRoute && onRoute.zone === turn.zone
      ? buildRimArrays(onRoute.path, routeHeading(onRoute.path), y)
      : buildArrowArrays(turn.path, turn.heading, y, CYAN));
  }
  return out;
}
