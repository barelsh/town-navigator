// Stick to roads: the car follows the drivable road graph, W/S set the speed, and the car sits in the
// right-hand lane of two-way roads (on the center line of one-way roads).
//
// Two states. Locked: the car does not steer, it follows its road and eases around curves. Free: inside a junction
// zone (see roadGraph.ts) it steers as in free driving. A locked car enters a zone only if its own road runs into it.
// A free car that leaves the zone locks onto the legal exit closest to its direction of travel. A zone with no such
// exit holds the car at its edge, which is how dead ends work.
//
// Pure code (types only from the town modules, no three.js), so `node --test` can load it. Positions are world
// meters: x east, z south. The car faces (sin heading, cos heading) in x, z.

import { nodeKey, type RoadGraph, type Zone, type ZoneExit } from '../town/roadGraph.ts';
import type { StreetSegment } from '../town/roads.ts';
import { laneOffset, LANE_OFFSET, pursue, routeHeading, routeSpeed, routeThrough, type LanePoint, type RouteStart, type Vec2 } from './turnRoute.ts';

export { LANE_OFFSET };
export type { LanePoint };

export interface Pose { x: number; z: number; heading: number }

/** A turn queued with a tap of A or D, for the next junction. */
export type Side = 'left' | 'right';

/**
 * The route the car is going to take through a zone, which is what the arrow draws and what auto-steer follows: from where
 * its lane crosses the zone's edge (or from where the car was when the target changed) to the target exit's lane, then
 * 2.6 m on. One object, reused; `version` counts changes to the path, `heading` is the way the exit points.
 */
export interface TurnArrow { version: number; path: Vec2[]; heading: number }

/** A circle the free car may not leave. */
export interface Hold { x: number; z: number; radius: number }

/** What the car controller asks for each frame while the lock is on. */
export interface DriveGuide {
  readonly active: boolean;
  /** Locked: the guide places the car with `step`. Free: the car steers, then `observe` and `hold` apply. */
  readonly mode: 'locked' | 'free';
  /** Free mode in a zone with no legal exit: the car must not leave this circle. */
  readonly hold: Hold | undefined;
  /** Locked: the next pose for a car moving at `speed` m/s (negative: reversing), and the speed it ends with. */
  step(pose: Pose, speed: number, dt: number): Pose & { speed: number };
  /** Free: called after the car's own steering step. May lock the car onto an exit. */
  observe(pose: Pose, speed: number, dt: number): void;
  /** The turn queued for the next junction. */
  readonly intent: Side | null;
  /** The speed in m/s the car must not go faster than (turning, or in a short gap between junctions); none: undefined. */
  readonly speedCap: number | undefined;
  /** Locked: a key press of A (left) or D (right) queues a turn; the opposite key cancels it. */
  press(side: Side): void;
  /** Free: a tap of A or D moves the target exit one exit to that side. */
  tap(side: Side): void;
  /** Free: whether the player is steering by hand. Auto-steer pauses while they do, and resumes 0.4 s after they stop. */
  steerHeld(held: boolean): void;
  /** Free: the steer (+1 is A, left) that heads for the target exit, or null when the car steers itself no longer. */
  autoSteer(pose: Pose, speed: number): number | null;
  /** The path to draw on the road, or null while there is nothing to show. The same object every time. */
  arrow(): TurnArrow | null;
}

/** Fields of `RoadLock.inspect`, for the debug log. Numbers only, so a recorder can reuse one object per frame. */
export interface LockSnapshot {
  active: number; mode: number; hold: number;     // 0 / 1; mode 1 is free
  candHeading: number; candFlow: number;           // NaN / 0 when none; flow 1 both, 2 out
  zoneX: number; zoneZ: number; zoneR: number;     // the zone a free car is in; 0 when locked
  trackAx: number; trackAz: number; trackBx: number; trackBz: number; trackT: number; trackDir: number;
  heading: number; lateral: number; offLen: number; ease: number;
  lastZoneR: number;
}

export interface RoadLockOptions {
  /** Called at engage, disengage, zone capture, exit and the like, for the debug log. */
  onEvent?(kind: string, data: Record<string, number | string | null>): void;
}

export interface RoadLock {
  readonly active: boolean;
  readonly mode: 'locked' | 'free';
  readonly hold: Hold | undefined;
  /** The exit a free car would lock onto if it left now, for the debug overlay. Null when locked or none fits. */
  candidate(): ZoneExit | null;
  /** Turns the lock on and snaps onto the closest drivable road. Null, and stays off, when the graph has no road. */
  engage(pose: Pose, graph: RoadGraph): Pose | null;
  disengage(): void;
  /** After a teleport: snaps onto the road closest to the new pose. Null when off or without a road. */
  reset(pose: Pose, graph: RoadGraph): Pose | null;
  step(pose: Pose, speed: number, dt: number, graph: RoadGraph): Pose & { speed: number };
  observe(pose: Pose, speed: number, dt: number, graph: RoadGraph): void;
  readonly intent: Side | null;
  readonly speedCap: number | undefined;
  press(side: Side): void;
  tap(side: Side): void;
  steerHeld(held: boolean): void;
  autoSteer(pose: Pose, speed: number): number | null;
  arrow(): TurnArrow | null;
  /** Fills `out` with the lock's internal state. Allocates nothing. */
  inspect(out: LockSnapshot): void;
}

export const EASE = 0.15;            // s: time constant of the heading and the lane offset
export const ENTER_LOOKAHEAD = 0.3;  // s of speed: a zone catches the car when its road reaches the zone's edge within this
export const EXIT_MARGIN = 1;        // m past the radius before a free car counts as out
export const EXIT_CONE = (100 * Math.PI) / 180; // an exit must be within this of the direction of travel
export const SNAP_EASE = 0.3;        // s: time constant of a snap onto an exit's road ...
export const SNAP_EASE_PER_M = 0.05; // ... plus this per meter the car is off it
const EASE_DECAY = 0.8;              // s of time constant lost per second, back down to EASE
const REARM_DISTANCE = 2;            // m outside a zone it just left before it can capture the car again
const REBIND_DISTANCE = 2;           // m: a zone is the same one after a graph rebuild if its center is this close
const HORIZON = 120;                 // m of road looked at ahead for a zone: the turn is chosen, and shown, from this far
export const TURN_MIN = (30 * Math.PI) / 180;     // a target this far from straight is a turn: it gets the arrow and the cap
const STRAIGHT_MAX = (45 * Math.PI) / 180;        // with no turn asked for, an exit within this of straight is taken
const SIDE_MAX = (150 * Math.PI) / 180;           // an asked-for turn may be at most this sharp
const GAP_SPEED = 36 / 3.6;          // m/s: kept through a short gap to a junction that needs no turn, so there is time to choose one
export const TURN_AROUND_CAP = 20 / 3.6; // m/s: the speed of a U-turn at a dead end
export const TURN_AROUND_STEER = 2.4;   // the hardest steering the auto-drive uses for it: a tighter turn than the player's keys give
export const CAP_BRAKE = 6;          // m/s²: how hard the controller brakes to a cap
const CAP_MARGIN = 2;                // m: braking for a turn starts this much before the braking distance runs out
const GAP_CAP_DISTANCE = 40;         // m: the next zone this close to the exit keeps the cap through the gap
const HANDBACK = 0.4;                // s after the steering keys are let go before auto-steer takes over again
const STEER_GAIN = 2.5;
const TURN_AROUND_LOOK = 1.3; // m ahead on the route that a U-turn aims at
const LOOK_MIN = 3, LOOK_MAX = 5.5, LOOK_PER_MPS = 0.4; // m: how far ahead on the route auto-steer aims, by speed
const SNAP_TIE = 1;                  // m: roads this close to the nearest count as equally near, the better aligned wins
const MAX_HOPS = 64;                 // segments crossed in one frame

/** The segment the car is on, with its own copy of the geometry so a rebuilt graph can't invalidate it. */
interface Track {
  ax: number; az: number; bx: number; bz: number;
  length: number;
  ux: number; uz: number;       // unit vector a to b
  halfWidth: number;
  oneway: 0 | 1 | -1;
  dir: 1 | -1;                  // 1: the car faces a to b
  t: number;                    // meters from a
}

const wrap = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));
const lengthOf = (s: StreetSegment) => Math.hypot(s.bx - s.ax, s.bz - s.az);
const near = (a: number, b: number) => Math.abs(a - b) < 0.006; // tile cuts are rounded to 1 cm

function trackOf(s: StreetSegment, dir: 1 | -1, t: number): Track {
  const length = lengthOf(s);
  return {
    ax: s.ax, az: s.az, bx: s.bx, bz: s.bz, length,
    ux: (s.bx - s.ax) / length, uz: (s.bz - s.az) / length,
    halfWidth: s.halfWidth, oneway: s.oneway, dir, t,
  };
}

const facingOf = (track: Track) => Math.atan2(track.dir * track.ux, track.dir * track.uz);
const laneOf = (track: Track) => laneOffset(track);

function isTrack(s: StreetSegment, track: Track): boolean {
  const same = near(s.ax, track.ax) && near(s.az, track.az) && near(s.bx, track.bx) && near(s.bz, track.bz);
  const flipped = near(s.ax, track.bx) && near(s.az, track.bz) && near(s.bx, track.ax) && near(s.bz, track.az);
  return same || flipped;
}

/** The center line point at `t`, moved `lateral` meters to the right of a car facing `heading`. */
function placed(track: Track, heading: number, lateral: number): Pose {
  // Facing (sin h, cos h) in x, z with z south, the right-hand side is (-cos h, sin h).
  return {
    x: track.ax + track.ux * track.t - Math.cos(heading) * lateral,
    z: track.az + track.uz * track.t + Math.sin(heading) * lateral,
    heading,
  };
}

interface Projection { segment: StreetSegment; t: number; distance: number }

function project(segment: StreetSegment, x: number, z: number): Projection | null {
  const length = lengthOf(segment);
  if (length === 0) return null;
  const t = Math.min(length, Math.max(0, ((x - segment.ax) * (segment.bx - segment.ax) + (z - segment.az) * (segment.bz - segment.az)) / length));
  const px = segment.ax + (segment.bx - segment.ax) * t / length, pz = segment.az + (segment.bz - segment.az) * t / length;
  return { segment, t, distance: Math.hypot(x - px, z - pz) };
}

/** The nearest road to the pose. Among roads about as near, the one best aligned with the car's heading. */
function nearestRoad(segments: StreetSegment[], pose: Pose): Projection | null {
  const found: Projection[] = [];
  let nearest = Infinity;
  for (const segment of segments) {
    const hit = project(segment, pose.x, pose.z);
    if (!hit) continue;
    found.push(hit);
    nearest = Math.min(nearest, hit.distance);
  }
  let best: Projection | null = null;
  let bestAlignment = 0;
  for (const hit of found) {
    if (hit.distance > nearest + SNAP_TIE) continue;
    const s = hit.segment, length = lengthOf(s);
    const alignment = Math.abs(((s.bx - s.ax) * Math.sin(pose.heading) + (s.bz - s.az) * Math.cos(pose.heading)) / length);
    const better = !best || alignment > bestAlignment + 1e-9
      || (Math.abs(alignment - bestAlignment) <= 1e-9 && hit.distance < best.distance);
    if (better) {
      best = hit;
      bestAlignment = alignment;
    }
  }
  return best;
}

/**
 * The legal exit (one that traffic may leave along) closest to the direction of travel, within 100 degrees.
 * Exits the graph could not tie to a road segment can't be locked onto, so they don't count.
 */
export function candidateExit(zone: Zone, travelHeading: number): ZoneExit | null {
  let best: ZoneExit | null = null;
  let bestTurn = EXIT_CONE;
  for (const exit of zone.exits) {
    if (exit.flow === 'in' || exit.segment === undefined) continue;
    const turn = Math.abs(wrap(exit.heading - travelHeading));
    if (turn < bestTurn) {
      bestTurn = turn;
      best = exit;
    }
  }
  return best;
}

/**
 * Keeps a free car inside its zone's hold circle: a step that would leave it is pulled back onto the circle.
 * A car already outside (it entered from a few meters away) just may not get any farther out.
 */
export function applyHold(hold: Hold, before: { x: number; z: number }, after: { x: number; z: number }):
  { x: number; z: number; held: boolean } {
  const limit = Math.max(hold.radius, Math.hypot(before.x - hold.x, before.z - hold.z));
  const dx = after.x - hold.x, dz = after.z - hold.z, distance = Math.hypot(dx, dz);
  if (distance <= limit) return { x: after.x, z: after.z, held: false };
  return { x: hold.x + dx * limit / distance, z: hold.z + dz * limit / distance, held: true };
}

/** Meters along the walked road (stretches of x0, z0, x1, z1, lane) until it first reaches the zone's circle; 0 if it starts inside. */
function distanceToEdge(walked: number[], zone: Zone): number {
  let along = 0;
  for (let i = 0; i < walked.length; i += WALKED) {
    const dx = walked[i + 2] - walked[i], dz = walked[i + 3] - walked[i + 1], length = Math.hypot(dx, dz);
    const ox = walked[i] - zone.x, oz = walked[i + 1] - zone.z;
    const c = ox * ox + oz * oz - zone.radius * zone.radius;
    if (c <= 0) return along;
    const a = length * length, b = 2 * (dx * ox + dz * oz), discriminant = b * b - 4 * a * c;
    if (a > 0 && discriminant >= 0) {
      const u = (-b - Math.sqrt(discriminant)) / (2 * a);
      if (u >= 0 && u <= 1) return along + u * length;
    }
    along += length;
  }
  return Infinity; // not reached: the member node is inside the circle
}
const WALKED = 5; // numbers per stretch of walked road

/** The lane point `distance` meters along the walked road: the car's lane, to the right of the center line. */
function laneAlong(walked: number[], distance: number): LanePoint {
  let along = 0;
  for (let i = 0; i < walked.length; i += WALKED) {
    const dx = walked[i + 2] - walked[i], dz = walked[i + 3] - walked[i + 1], length = Math.hypot(dx, dz);
    if (length === 0) continue;
    if (distance <= along + length || i + WALKED >= walked.length) {
      const u = Math.min(1, Math.max(0, (distance - along) / length));
      const heading = Math.atan2(dx, dz), lane = walked[i + 4];
      return { x: walked[i] + dx * u - Math.cos(heading) * lane, z: walked[i + 1] + dz * u + Math.sin(heading) * lane, heading };
    }
    along += length;
  }
  return { x: 0, z: 0, heading: 0 };
}

export interface Target { exit: ZoneExit; turn: number; byIntent: boolean }

/**
 * The exit to take through `zone` for a car coming in along `approach`. The turn is measured from the approach, positive
 * to the left (the way heading grows). With a turn asked for: the exit on that side between 30 and 150 degrees closest
 * to 90. Otherwise the straightest exit within 45 degrees, or failing that the smallest turn. One-way-in exits never count.
 * A dead end has a target only with a turn asked for: the road back, a U-turn.
 */
export function pickTarget(zone: Zone, approach: number, intent: Side | null): Target | null {
  const legal: { exit: ZoneExit; turn: number }[] = [];
  for (const exit of zone.exits) {
    if (exit.flow !== 'in' && exit.segment !== undefined && exit.edgePoint) legal.push({ exit, turn: wrap(exit.heading - approach) });
  }
  // A dead end has one way out, back the way the car came, and the car turns around only when asked to (either key).
  if (zone.kind === 'dead_end') return intent && legal.length ? { ...legal[0], byIntent: true } : null;
  const closest = (list: typeof legal, cost: (turn: number) => number) =>
    list.reduce<{ exit: ZoneExit; turn: number } | null>((best, c) => (!best || cost(c.turn) < cost(best.turn) ? c : best), null);
  if (intent) {
    const sign = intent === 'left' ? 1 : -1;
    const side = legal.filter(({ turn }) => sign * turn >= TURN_MIN && sign * turn <= SIDE_MAX);
    const pick = closest(side, turn => Math.abs(Math.abs(turn) - Math.PI / 2));
    if (pick) return { ...pick, byIntent: true };
  }
  const straight = legal.filter(({ turn }) => Math.abs(turn) <= STRAIGHT_MAX);
  const pick = closest(straight.length ? straight : legal, turn => Math.abs(turn));
  return pick && { ...pick, byIntent: false };
}

/** Meters before the zone's edge at which a car going `speed` has to start braking to reach the turn speed there. */
export const brakingDistance = (speed: number, cap: number) => Math.max(0, (speed * speed - cap * cap) / (2 * CAP_BRAKE));

/** The speed through a route: a crawl for a U-turn at a dead end, otherwise what its tightest bend allows (turnRoute.ts). */
const speedOf = (z: Zone, route: Vec2[]) => (z.kind === 'dead_end' ? TURN_AROUND_CAP : routeSpeed(route));


// Zones by the nodes of their members, per graph, to tell quickly whether a road runs into one.
const zoneNodeCache = new WeakMap<RoadGraph, Map<number, Zone>>();
function zoneNodes(graph: RoadGraph): Map<number, Zone> {
  let nodes = zoneNodeCache.get(graph);
  if (!nodes) {
    nodes = new Map();
    for (const zone of graph.zones) for (const member of zone.members) nodes.set(nodeKey(member.x, member.z), zone);
    zoneNodeCache.set(graph, nodes);
  }
  return nodes;
}

export function createRoadLock(options: RoadLockOptions = {}): RoadLock {
  const emit = options.onEvent;
  let active = false;
  let track: Track | null = null;
  let heading = 0;  // eased
  let lateral = 0;  // eased, meters to the right
  let offX = 0, offZ = 0;   // eased: how far the car is from where the track says it should be, after a snap
  let ease = EASE;          // current time constant of the three eased values
  let mode: 'locked' | 'free' = 'locked';
  let zone: Zone | null = null;       // free: the zone the car is in
  let zoneGraph: RoadGraph | null = null; // the graph `zone` belongs to
  let lastZone: { x: number; z: number; radius: number } | null = null; // the zone just left
  let hold: Hold | undefined;
  let candidate: ZoneExit | null = null;

  // Turn intent (TN-37)
  let intent: Side | null = null;
  /** The turn planned for the next zone ahead, while locked. */
  let plan: { zone: Zone; graph: RoadGraph; intent: Side | null; entry: LanePoint; target: Target | null; route: Vec2[] | null; cap: number } | null = null;
  let target: Target | null = null;   // free: the exit auto-steer heads for
  let approach = 0;                    // free: the heading the car came into the zone with; turns are measured from it
  let route: Vec2[] | null = null;     // free: the way through the zone to the target exit: what the arrow draws and the car follows
  let routeIndex = 0;                  // free: the segment of the route the car was last on
  let intentUsed = false;              // the zone's target was picked by the intent: it is spent when the car leaves
  let manual = false;                  // free: the player is steering by hand
  let handback = 0;                    // free: seconds until auto-steer takes over again after the player lets go
  let gapCap = false;                  // locked: the next zone is close behind the one just left, so the turn speed stays
  let cap: number | undefined;
  let zoneCap = Infinity;              // free: the speed the route through the zone allows
  let lastPose: Pose = { x: 0, z: 0, heading: 0 };
  const arrowView: TurnArrow = { version: 0, path: [], heading: 0 };
  let arrowOn = false;

  /** Shows `path` as the arrow. The same path object is not rebuilt: the version moves only when the path changes. */
  function showArrow(path: Vec2[]): void {
    if (!arrowOn || arrowView.path !== path) {
      arrowView.path = path;
      arrowView.heading = routeHeading(path);
      arrowView.version++;
    }
    arrowOn = true;
  }

  /** The vertex of the zone's roads nearest to the car, preferring one ahead of it: where a replanned route starts. */
  function nearestNodeAhead(graph: RoadGraph, z: Zone, pose: Pose): Vec2 | null {
    let ahead: Vec2 | null = null, aheadD = Infinity, any: Vec2 | null = null, anyD = Infinity;
    const consider = (x: number, zz: number) => {
      if (Math.hypot(x - z.x, zz - z.z) > z.radius + 1) return;
      const d = Math.hypot(x - pose.x, zz - pose.z);
      if (d < anyD) { anyD = d; any = { x, z: zz }; }
      if (d < aheadD && (x - pose.x) * Math.sin(pose.heading) + (zz - pose.z) * Math.cos(pose.heading) > -1) { aheadD = d; ahead = { x, z: zz }; }
    };
    for (const s of graph.segments) { consider(s.ax, s.az); consider(s.bx, s.bz); }
    return ahead ?? any;
  }

  /** A route to `exit` starting from where the car is now (after a tap, or the hand-back after steering by hand). */
  function replan(graph: RoadGraph, z: Zone, exit: ZoneExit, pose: Pose): Vec2[] {
    const start: RouteStart = { pose: { x: pose.x, z: pose.z, heading: pose.heading }, node: nearestNodeAhead(graph, z, pose), came: null };
    routeIndex = 0;
    const next = routeThrough(graph, z, start, exit);
    zoneCap = speedOf(z, next);
    return next;
  }

  function clearZone(): void {
    mode = 'locked';
    zone = null;
    zoneGraph = null;
    hold = undefined;
    candidate = null;
    target = null;
    manual = false;
    handback = 0;
    intentUsed = false;
    arrowOn = false;
  }

  /** Puts the car on the nearest road, facing the way it already faced, and jumps straight to its lane. */
  function seed(pose: Pose, graph: RoadGraph): Pose | null {
    clearZone();
    lastZone = null;
    plan = null;
    gapCap = false;
    cap = undefined;
    offX = offZ = 0;
    ease = EASE;
    const hit = nearestRoad(graph.segments, pose);
    if (!hit) {
      track = null;
      return null;
    }
    const { segment, t } = hit;
    const length = lengthOf(segment);
    const along = ((segment.bx - segment.ax) * Math.sin(pose.heading) + (segment.bz - segment.az) * Math.cos(pose.heading)) / length;
    // A one-way road only has one way to face.
    const dir: 1 | -1 = segment.oneway !== 0 ? segment.oneway : along >= 0 ? 1 : -1;
    track = trackOf(segment, dir, t);
    heading = facingOf(track);
    lateral = laneOf(track);
    return placed(track, heading, lateral);
  }

  /** Locks onto `next` without a jump: the car's pose becomes an offset from the track that eases away. */
  function lockOnto(next: Track, pose: Pose, easeBase: number): void {
    track = next;
    heading = pose.heading;
    lateral = laneOf(next);
    const target = placed(next, heading, lateral);
    offX = pose.x - target.x;
    offZ = pose.z - target.z;
    ease = easeBase + Math.hypot(offX, offZ) * SNAP_EASE_PER_M;
    clearZone();
  }

  /** The road to take at the node (px, pz) for a car moving along (mx, mz): legal roads first, then the straightest. */
  function choose(graph: RoadGraph, current: Track, px: number, pz: number, mx: number, mz: number, reversing: boolean):
    { segment: StreetSegment; end: 0 | 1 } | null {
    let best: { segment: StreetSegment; end: 0 | 1 } | null = null;
    let bestLegal = false;
    let bestDot = -Infinity;
    for (const [i, end] of graph.at(px, pz)) {
      const segment = graph.segments[i];
      if (isTrack(segment, current)) continue;
      const length = lengthOf(segment);
      if (length === 0) continue;
      // Moving away from the node: from end 0 that runs a to b, from end 1 b to a.
      const moveDir = end === 0 ? 1 : -1;
      const dot = (moveDir * (segment.bx - segment.ax) * mx + moveDir * (segment.bz - segment.az) * mz) / length;
      const facing = reversing ? -moveDir : moveDir;
      const legal = segment.oneway === 0 || segment.oneway === facing;
      if ((legal && !bestLegal) || (legal === bestLegal && dot > bestDot)) {
        best = { segment, end };
        bestLegal = legal;
        bestDot = dot;
      }
    }
    return best;
  }

  /** Moves the track by `delta` meters of t, crossing segments. True when it ran into a dead end and stopped. */
  function advance(graph: RoadGraph, delta: number, reversing: boolean): boolean {
    let t = track!.t + delta;
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const current = track!;
      if (t >= 0 && t <= current.length) {
        current.t = t;
        return false;
      }
      const forward = t > current.length; // leaves through end b
      const px = forward ? current.bx : current.ax, pz = forward ? current.bz : current.az;
      const over = forward ? t - current.length : -t;
      const next = choose(graph, current, px, pz, forward ? current.ux : -current.ux, forward ? current.uz : -current.uz, reversing);
      if (!next) {
        current.t = forward ? current.length : 0;
        return true;
      }
      const moveDir = next.end === 0 ? 1 : -1;
      track = trackOf(next.segment, reversing ? -moveDir as 1 | -1 : moveDir as 1 | -1, next.end === 0 ? over : lengthOf(next.segment) - over);
      t = track.t;
    }
    track!.t = Math.min(track!.length, Math.max(0, t));
    return true;
  }

  /**
   * The first zone the car's own road runs into, ahead in the direction it is moving, and how far along that road
   * the car is from the zone's edge. That distance, not the straight-line one, decides when the zone catches the car:
   * a road that leaves a zone and loops back to it is a long way from the edge while the car drives away.
   */
  function zoneAhead(graph: RoadGraph, reversing: boolean): { zone: Zone; enter: number; walked: number[]; node: Vec2; came: Vec2 } | null {
    const nodes = zoneNodes(graph);
    let current = track!;
    let x = current.ax + current.ux * current.t, z = current.az + current.uz * current.t; // the car on its road's center line
    const walked: number[] = []; // x0, z0, x1, z1 and the lane offset of each stretch of road walked
    let travelled = 0;
    for (let hop = 0; hop < MAX_HOPS && travelled < HORIZON; hop++) {
      const toB = current.dir * (reversing ? -1 : 1) > 0;
      const px = toB ? current.bx : current.ax, pz = toB ? current.bz : current.az;
      walked.push(x, z, px, pz, laneOf(current));
      travelled += Math.hypot(px - x, pz - z);
      const found = nodes.get(nodeKey(px, pz));
      if (found) return { zone: found, enter: distanceToEdge(walked, found), walked, node: { x: px, z: pz }, came: { x, z } };
      const next = choose(graph, current, px, pz, toB ? current.ux : -current.ux, toB ? current.uz : -current.uz, reversing);
      if (!next) return null;
      const moveDir = next.end === 0 ? 1 : -1;
      current = trackOf(next.segment, reversing ? -moveDir as 1 | -1 : moveDir as 1 | -1, next.end === 0 ? 0 : lengthOf(next.segment));
      x = px;
      z = pz;
    }
    return null;
  }

  /** Chooses, and keeps, the turn for the zone ahead; redone when the zone, the queued turn or the graph changes. */
  function planTurn(ahead: { zone: Zone; enter: number; walked: number[]; node: Vec2; came: Vec2 } | null, graph: RoadGraph): void {
    if (!ahead) { plan = null; return; }
    if (plan && plan.zone === ahead.zone && plan.graph === graph && plan.intent === intent) return;
    const entryLane = laneAlong(ahead.walked, ahead.enter);
    const chosen = pickTarget(ahead.zone, entryLane.heading, intent);
    const planned = chosen && routeThrough(graph, ahead.zone, { pose: entryLane, node: ahead.node, came: ahead.came }, chosen.exit);
    plan = { zone: ahead.zone, graph, intent, entry: entryLane, target: chosen, route: planned, cap: planned ? speedOf(ahead.zone, planned) : Infinity };
  }

  return {
    get active() { return active; },
    get mode() { return mode; },
    get hold() { return hold; },
    candidate: () => candidate,
    get intent() { return intent; },
    get speedCap() { return cap; },
    arrow: () => (arrowOn ? arrowView : null),

    press(side) {
      if (!active || mode !== 'locked') return;
      intent = intent && intent !== side ? null : side;
      emit?.('intent', { side: intent });
    },

    tap(side) {
      if (!active || mode !== 'free' || !zone || !target) return;
      const sign = side === 'left' ? 1 : -1;
      const legal: { exit: ZoneExit; turn: number }[] = [];
      for (const exit of zone.exits) {
        if (exit.flow !== 'in' && exit.segment !== undefined && exit.edgePoint) legal.push({ exit, turn: wrap(exit.heading - approach) });
      }
      legal.sort((a, b) => b.turn - a.turn); // sharpest left first
      const now = legal.findIndex(l => l.exit === target!.exit);
      const next = Math.min(legal.length - 1, Math.max(0, now - sign)); // left is toward the start; no wrap
      if (now < 0 || next === now) return;
      target = { ...legal[next], byIntent: true };
      intentUsed = true;
      manual = false;
      handback = 0;
      route = replan(zoneGraph!, zone, target.exit, lastPose);
      emit?.('tap', { side, turn: target.turn });
    },

    steerHeld(held) {
      if (!active || mode !== 'free') return;
      if (held) { manual = true; handback = 0; }
      else if (manual) { manual = false; handback = HANDBACK; }
    },

    autoSteer(pose, speed) {
      if (!active || mode !== 'free' || !target || manual || handback > 0 || speed < 0) return null;
      if (!route) return null;
      // A dead end's U-turn is a tight half circle: aim close ahead and steer with a harder lock than the keys give.
      const turnAround = zone?.kind === 'dead_end';
      const result = turnAround
        ? pursue(route, pose, routeIndex, TURN_AROUND_LOOK, 4, TURN_AROUND_STEER)
        : pursue(route, pose, routeIndex, Math.min(LOOK_MAX, Math.max(LOOK_MIN, LOOK_PER_MPS * speed)), STEER_GAIN);
      routeIndex = result.index;
      return result.steer;
    },

    inspect(out) {
      out.active = active ? 1 : 0;
      out.mode = mode === 'free' ? 1 : 0;
      out.hold = hold ? 1 : 0;
      out.candHeading = candidate ? candidate.heading : NaN;
      out.candFlow = candidate ? (candidate.flow === 'both' ? 1 : candidate.flow === 'out' ? 2 : 3) : 0;
      out.zoneX = zone ? zone.x : 0;
      out.zoneZ = zone ? zone.z : 0;
      out.zoneR = zone ? zone.radius : 0;
      out.trackAx = track ? track.ax : NaN;
      out.trackAz = track ? track.az : NaN;
      out.trackBx = track ? track.bx : NaN;
      out.trackBz = track ? track.bz : NaN;
      out.trackT = track ? track.t : NaN;
      out.trackDir = track ? track.dir : 0;
      out.heading = heading;
      out.lateral = lateral;
      out.offLen = Math.hypot(offX, offZ);
      out.ease = ease;
      out.lastZoneR = lastZone ? lastZone.radius : 0;
    },

    engage(pose, graph) {
      intent = null;
      const snapped = seed(pose, graph);
      active = snapped !== null;
      emit?.('engage', { ok: active ? 1 : 0, x: pose.x, z: pose.z, heading: pose.heading, snapX: snapped?.x ?? null, snapZ: snapped?.z ?? null });
      return snapped;
    },

    disengage() {
      emit?.('disengage', { mode });
      active = false;
      intent = null;
      plan = null;
      gapCap = false;
      cap = undefined;
      track = null;
      lastZone = null;
      offX = offZ = 0;
      ease = EASE;
      clearZone();
    },

    reset(pose, graph) {
      intent = null;
      const snapped = active ? seed(pose, graph) : null;
      if (active) emit?.('reset', { x: pose.x, z: pose.z, snapX: snapped?.x ?? null, snapZ: snapped?.z ?? null });
      return snapped;
    },

    step(pose, speed, dt, graph) {
      if (!active || mode === 'free') return { ...pose, speed };
      if (!track && !seed(pose, graph)) return { ...pose, speed: 0 }; // no road loaded yet: wait
      const reversing = speed < 0;
      let stopped = false;
      if (speed !== 0 && dt > 0) stopped = advance(graph, track!.dir * speed * dt, reversing);
      const k = 1 - Math.exp(-dt / ease);
      heading += wrap(facingOf(track!) - heading) * k;
      lateral += (laneOf(track!) - lateral) * k;
      offX -= offX * k;
      offZ -= offZ * k;
      ease = Math.max(EASE, ease - dt * EASE_DECAY);
      const base = placed(track!, heading, lateral);
      const result = { x: base.x + offX, z: base.z + offZ, heading, speed: stopped ? 0 : speed };

      // A zone just left can't capture the car again until it is a little way outside it.
      if (lastZone && Math.hypot(result.x - lastZone.x, result.z - lastZone.z) > lastZone.radius + REARM_DISTANCE) lastZone = null;
      // Enter a zone only if this car's own road runs into it, once it is within a lookahead of the zone's edge,
      // so a fast car still has room to steer. The distance along the road ahead and the car's own straight-line
      // distance must both be within the lookahead. The straight line alone would catch a car driving away on a road
      // that loops back to the zone. The road alone judges by the car's place on its road, which is not where the car
      // is while a snap is still easing, and that place can lie in another zone the car isn't near.
      const ahead = zoneAhead(graph, reversing);
      const lookahead = Math.abs(speed) * ENTER_LOOKAHEAD;
      const justLeft = ahead && lastZone && Math.hypot(ahead.zone.x - lastZone.x, ahead.zone.z - lastZone.z) < 0.5;
      planTurn(ahead && !justLeft && !reversing ? ahead : null, graph);
      if (!ahead || reversing) gapCap = false;
      // Slow down for a turn: from the braking distance before the zone's edge, and through a short gap between zones.
      const turning = plan?.target && Math.abs(plan.target.turn) > TURN_MIN;
      const turnCap = turning && plan ? plan.cap : undefined;
      cap = gapCap ? (turnCap ?? GAP_SPEED) : undefined; // through a short gap: the next turn's speed, or a gentle one
      if (turnCap !== undefined && ahead && ahead.enter <= brakingDistance(speed, turnCap) + CAP_MARGIN) cap = Math.min(cap ?? Infinity, turnCap);
      if (plan?.target && plan.route && turning) showArrow(plan.route);
      else arrowOn = false;
      if (ahead && !justLeft
        && ahead.enter <= lookahead
        && Math.hypot(result.x - ahead.zone.x, result.z - ahead.zone.z) <= ahead.zone.radius + lookahead) {
        emit?.('capture', {
          zoneX: ahead.zone.x, zoneZ: ahead.zone.z, zoneR: ahead.zone.radius, members: ahead.zone.members.length,
          enter: ahead.enter, lookahead, carDist: Math.hypot(result.x - ahead.zone.x, result.z - ahead.zone.z),
          speed, offLen: Math.hypot(offX, offZ), lastZoneR: lastZone ? lastZone.radius : null,
        });
        const taken = plan && plan.zone === ahead.zone ? plan : null;
        mode = 'free';
        zone = ahead.zone;
        zoneGraph = graph;
        hold = undefined;
        candidate = null;
        gapCap = false;
        target = reversing ? null : taken?.target ?? null;
        approach = taken ? taken.entry.heading : result.heading;
        route = null;
        routeIndex = 0;
        intentUsed = !!target?.byIntent;
        manual = false;
        handback = 0;
        lastPose = result;
        cap = undefined;
        if (target) route = taken?.route ?? replan(graph, ahead.zone, target.exit, result);
        if (taken?.route) zoneCap = taken.cap;
        cap = target && Math.abs(target.turn) > TURN_MIN ? zoneCap : undefined;
        if (route && target && Math.abs(target.turn) > TURN_MIN) showArrow(route);
        else arrowOn = false;
        emit?.('target', { turn: target?.turn ?? null, byIntent: target ? (target.byIntent ? 1 : 0) : null, intent });
      }
      return result;
    },

    observe(pose, speed, dt, graph) {
      if (!active || mode !== 'free' || !zone) return;
      lastPose = pose;
      if (graph !== zoneGraph) {
        // The graph was rebuilt (a tile loaded): find the zone again by its center.
        let same: Zone | null = null;
        let nearest = REBIND_DISTANCE;
        for (const z of graph.zones) {
          const d = Math.hypot(z.x - zone.x, z.z - zone.z);
          if (d < nearest) { nearest = d; same = z; }
        }
        if (!same) { // gone: snap to the nearest road, easing in
          emit?.('zoneGone', { zoneX: zone.x, zoneZ: zone.z, zoneR: zone.radius });
          const hit = nearestRoad(graph.segments, pose);
          if (hit) lockOnto(trackOf(hit.segment, Math.sin(pose.heading) * (hit.segment.bx - hit.segment.ax) + Math.cos(pose.heading) * (hit.segment.bz - hit.segment.az) >= 0 ? 1 : -1, hit.t), pose, SNAP_EASE);
          else clearZone();
          return;
        }
        if (target) { // the same exit in the new zone: same branch of the same member, same direction
          const old = target.exit;
          const found = same.exits.find(e => e.from.x === old.from.x && e.from.z === old.from.z && Math.abs(wrap(e.heading - old.heading)) < 1e-3);
          target = found && found.segment !== undefined && found.edgePoint ? { ...target, exit: found } : pickTarget(same, approach, intent);
          route = target ? replan(graph, same, target.exit, pose) : null;
        }
        zone = same;
        zoneGraph = graph;
      }

      const travel = speed >= 0 ? pose.heading : pose.heading + Math.PI;
      candidate = candidateExit(zone, travel);

      // Auto-steer hands the wheel back 0.4 s after the player lets go, toward the exit the car now points at.
      if (!manual && handback > 0) {
        handback -= dt;
        if (handback <= 0) {
          handback = 0;
          target = candidate ? { exit: candidate, turn: wrap(candidate.heading - approach), byIntent: false } : null;
          route = target ? replan(graph, zone, target.exit, pose) : null;
        }
      }
      const auto = target !== null && !manual && handback <= 0 && speed >= 0;
      const turning = target !== null && Math.abs(target.turn) > TURN_MIN;
      cap = turning ? zoneCap : undefined;
      if (auto && turning && route) showArrow(route);
      else arrowOn = false;

      // The exit to lock onto: the target if the car heads toward it, else the one closest to the direction of travel.
      const aimed = auto && Math.abs(wrap(target!.exit.heading - travel)) < EXIT_CONE;
      const chosen = aimed ? target!.exit : candidate;
      hold = chosen ? undefined : { x: zone.x, z: zone.z, radius: zone.radius + EXIT_MARGIN };

      const dx = pose.x - zone.x, dz = pose.z - zone.z;
      const movingAway = dx * Math.sin(travel) + dz * Math.cos(travel) > 0;
      if (!chosen || Math.hypot(dx, dz) <= zone.radius + EXIT_MARGIN || !movingAway) return;

      // Out: lock onto the exit's road, at the point where it crosses the zone edge. Reversing out faces the zone.
      const segment = graph.segments[chosen.segment!];
      const edge = chosen.edgePoint!;
      const nearest = graph.nearestOnSegment(chosen.segment!, edge.x, edge.z);
      const dir: 1 | -1 = speed >= 0 ? chosen.dir! : (-chosen.dir! as 1 | -1);
      const left = zone, taken = chosen, spent = intentUsed; // lockOnto clears them
      lastZone = { x: left.x, z: left.z, radius: left.radius };
      lockOnto(trackOf(segment, dir, nearest.t), pose, SNAP_EASE);
      if (spent) intent = null;
      // A zone close behind keeps the turn speed through the gap.
      const next = speed >= 0 ? zoneAhead(graph, false) : null;
      const nextIsLeft = next && Math.hypot(next.zone.x - left.x, next.zone.z - left.z) < 0.5;
      gapCap = !!next && !nextIsLeft && next.enter <= GAP_CAP_DISTANCE;
      cap = gapCap ? GAP_SPEED : undefined;
      plan = null;
      emit?.('exit', {
        zoneX: left.x, zoneZ: left.z, zoneR: left.radius, out: Math.hypot(dx, dz), speed,
        travel, candHeading: taken.heading, candFlow: taken.flow, snapDistance: Math.hypot(offX, offZ),
        gapCap: gapCap ? 1 : 0,
      });
    },
  };
}
