// Stick to roads: while on, the car does not steer. It follows the drivable road graph, W/S set the speed,
// and the car sits in the right-hand lane of two-way roads (on the center line of one-way roads).
// At a junction it takes the road closest to straight ahead, preferring roads it may legally drive along,
// and at a dead end it stops.
//
// Pure code (types only from the town modules, no three.js), so `node --test` can load it. Positions are world
// meters: x east, z south. The car faces (sin heading, cos heading) in x, z.

import type { RoadGraph } from '../town/roadGraph.ts';
import type { StreetSegment } from '../town/roads.ts';

export interface Pose { x: number; z: number; heading: number }

/** What the car controller asks for each frame while the lock is on. */
export interface DriveGuide {
  readonly active: boolean;
  /** The next pose for a car moving at `speed` m/s (negative: reversing), and the speed it ends with. */
  step(pose: Pose, speed: number, dt: number): Pose & { speed: number };
}

export interface RoadLock {
  readonly active: boolean;
  /** Turns the lock on and snaps onto the closest drivable road. Null, and stays off, when the graph has no road. */
  engage(pose: Pose, graph: RoadGraph): Pose | null;
  disengage(): void;
  /** After a teleport: snaps onto the road closest to the new pose. Null when off or without a road. */
  reset(pose: Pose, graph: RoadGraph): Pose | null;
  step(pose: Pose, speed: number, dt: number, graph: RoadGraph): Pose & { speed: number };
}

export const LANE_OFFSET = 1.75; // m right of the center line, at most
export const EASE = 0.15;        // s: time constant of the heading and the lane offset
const SNAP_TIE = 1;              // m: roads this close to the nearest count as equally near, the better aligned wins
const MAX_HOPS = 64;             // segments crossed in one frame

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

export function createRoadLock(): RoadLock {
  let active = false;
  let track: Track | null = null;
  let heading = 0;  // eased
  let lateral = 0;  // eased, meters to the right

  /** Puts the car on the nearest road, facing the way it already faced, and jumps straight to its lane. */
  function seed(pose: Pose, graph: RoadGraph): Pose | null {
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

  return {
    get active() { return active; },

    engage(pose, graph) {
      const snapped = seed(pose, graph);
      active = snapped !== null;
      return snapped;
    },

    disengage() {
      active = false;
      track = null;
    },

    reset(pose, graph) {
      return active ? seed(pose, graph) : null;
    },

    step(pose, speed, dt, graph) {
      if (!active) return { ...pose, speed };
      if (!track && !seed(pose, graph)) return { ...pose, speed: 0 }; // no road loaded yet: wait
      let stopped = false;
      if (speed !== 0 && dt > 0) stopped = advance(graph, track!.dir * speed * dt, speed < 0);
      const k = 1 - Math.exp(-dt / EASE);
      heading += wrap(facingOf(track!) - heading) * k;
      lateral += (laneOf(track!) - lateral) * k;
      return { ...placed(track!, heading, lateral), speed: stopped ? 0 : speed };
    },
  };
}
