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

export interface Pose { x: number; z: number; heading: number }

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
}

export const LANE_OFFSET = 1.75;     // m right of the center line, at most
export const EASE = 0.15;            // s: time constant of the heading and the lane offset
export const ENTER_LOOKAHEAD = 0.3;  // s of speed added to a zone's radius when entering it
export const EXIT_MARGIN = 1;        // m past the radius before a free car counts as out
export const EXIT_CONE = (100 * Math.PI) / 180; // an exit must be within this of the direction of travel
export const SNAP_EASE = 0.3;        // s: time constant of a snap onto an exit's road ...
export const SNAP_EASE_PER_M = 0.05; // ... plus this per meter the car is off it
const EASE_DECAY = 0.8;              // s of time constant lost per second, back down to EASE
const REARM_DISTANCE = 2;            // m outside a zone it just left before it can capture the car again
const REBIND_DISTANCE = 2;           // m: a zone is the same one after a graph rebuild if its center is this close
const HORIZON = 80;                  // m of road looked at ahead for a zone
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
const laneOf = (track: Track) => (track.oneway ? 0 : Math.min(track.halfWidth / 2, LANE_OFFSET));

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

export function createRoadLock(): RoadLock {
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

  function clearZone(): void {
    mode = 'locked';
    zone = null;
    zoneGraph = null;
    hold = undefined;
    candidate = null;
  }

  /** Puts the car on the nearest road, facing the way it already faced, and jumps straight to its lane. */
  function seed(pose: Pose, graph: RoadGraph): Pose | null {
    clearZone();
    lastZone = null;
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

  /** The first zone the car's own road runs into, ahead in the direction it is moving. */
  function zoneAhead(graph: RoadGraph, reversing: boolean): Zone | null {
    const nodes = zoneNodes(graph);
    let current = track!;
    let travelled = 0;
    for (let hop = 0; hop < MAX_HOPS && travelled < HORIZON; hop++) {
      const toB = current.dir * (reversing ? -1 : 1) > 0;
      travelled += toB ? current.length - current.t : current.t;
      const px = toB ? current.bx : current.ax, pz = toB ? current.bz : current.az;
      const found = nodes.get(nodeKey(px, pz));
      if (found) return found;
      const next = choose(graph, current, px, pz, toB ? current.ux : -current.ux, toB ? current.uz : -current.uz, reversing);
      if (!next) return null;
      const moveDir = next.end === 0 ? 1 : -1;
      current = trackOf(next.segment, reversing ? -moveDir as 1 | -1 : moveDir as 1 | -1, next.end === 0 ? 0 : lengthOf(next.segment));
    }
    return null;
  }

  return {
    get active() { return active; },
    get mode() { return mode; },
    get hold() { return hold; },
    candidate: () => candidate,

    engage(pose, graph) {
      const snapped = seed(pose, graph);
      active = snapped !== null;
      return snapped;
    },

    disengage() {
      active = false;
      track = null;
      lastZone = null;
      offX = offZ = 0;
      ease = EASE;
      clearZone();
    },

    reset(pose, graph) {
      return active ? seed(pose, graph) : null;
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
      // Enter a zone only if this car's own road runs into it, once within its radius plus a lookahead,
      // so a fast car still has room to steer.
      const ahead = zoneAhead(graph, reversing);
      if (ahead && !(lastZone && Math.hypot(ahead.x - lastZone.x, ahead.z - lastZone.z) < 0.5)
        && Math.hypot(result.x - ahead.x, result.z - ahead.z) <= ahead.radius + Math.abs(speed) * ENTER_LOOKAHEAD) {
        mode = 'free';
        zone = ahead;
        zoneGraph = graph;
        hold = undefined;
        candidate = null;
      }
      return result;
    },

    observe(pose, speed, _dt, graph) {
      if (!active || mode !== 'free' || !zone) return;
      if (graph !== zoneGraph) {
        // The graph was rebuilt (a tile loaded): find the zone again by its center.
        let same: Zone | null = null;
        let nearest = REBIND_DISTANCE;
        for (const z of graph.zones) {
          const d = Math.hypot(z.x - zone.x, z.z - zone.z);
          if (d < nearest) { nearest = d; same = z; }
        }
        if (!same) { // gone: snap to the nearest road, easing in
          const hit = nearestRoad(graph.segments, pose);
          if (hit) lockOnto(trackOf(hit.segment, Math.sin(pose.heading) * (hit.segment.bx - hit.segment.ax) + Math.cos(pose.heading) * (hit.segment.bz - hit.segment.az) >= 0 ? 1 : -1, hit.t), pose, SNAP_EASE);
          else clearZone();
          return;
        }
        zone = same;
        zoneGraph = graph;
      }

      const travel = speed >= 0 ? pose.heading : pose.heading + Math.PI;
      candidate = candidateExit(zone, travel);
      hold = candidate ? undefined : { x: zone.x, z: zone.z, radius: zone.radius + EXIT_MARGIN };

      const dx = pose.x - zone.x, dz = pose.z - zone.z;
      const movingAway = dx * Math.sin(travel) + dz * Math.cos(travel) > 0;
      if (!candidate || Math.hypot(dx, dz) <= zone.radius + EXIT_MARGIN || !movingAway) return;

      // Out: lock onto the exit's road, at the point where it crosses the zone edge. Reversing out faces the zone.
      const segment = graph.segments[candidate.segment!];
      const edge = candidate.edgePoint!;
      const nearest = graph.nearestOnSegment(candidate.segment!, edge.x, edge.z);
      const dir: 1 | -1 = speed >= 0 ? candidate.dir! : (-candidate.dir! as 1 | -1);
      lastZone = { x: zone.x, z: zone.z, radius: zone.radius };
      lockOnto(trackOf(segment, dir, nearest.t), pose, SNAP_EASE);
    },
  };
}
