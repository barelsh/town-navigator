// The road graph the car can drive on: tile junctions in world space, merged into zones
// (roundabouts and dual-carriageway crossings become one zone), the exits of each zone,
// and which drivable segment continues from which, across tile cuts.
//
// Pure code that imports types only (roadStyles.ts has no three.js), so `node --test` can load it.

import type { Junction, JunctionControl } from '@town-navigator/shared';
import { roadStyle } from './roadStyles.ts';
import type { StreetSegment } from './roads.ts';

export interface WorldBranch { heading: number; halfWidth: number; flow: 'both' | 'out' | 'in'; name?: string }
export interface WorldJunction {
  /** OSM node id, matched against a route's maneuver nodes (TN-40); null when the town has none. */
  id: number | null;
  x: number;
  z: number;
  kind: 'junction' | 'dead_end';
  control?: JunctionControl;
  branches: WorldBranch[];
}

/**
 * A branch that leaves a zone. `segment`, `dir` and `edgePoint` say where its road crosses the zone circle: the
 * index in `RoadGraph.segments`, which way the car runs along it going away from the zone (1: a to b), and the
 * crossing point. They are missing when no drivable segment matched the branch (a gap in the data).
 */
export type ZoneExit = WorldBranch & {
  from: WorldJunction;
  segment?: number;
  dir?: 1 | -1;
  edgePoint?: { x: number; z: number };
};

export interface Zone {
  x: number;
  z: number;
  radius: number;
  kind: 'junction' | 'dead_end';
  control?: JunctionControl;
  members: WorldJunction[];
  /** Branches that leave the zone; branches that lead to another member are internal and left out. */
  exits: ZoneExit[];
}

export interface RoadGraph {
  segments: StreetSegment[]; // drivable only
  zones: Zone[];
  /** Drivable segment ends at this point, as [segment index, which end: 0 = a, 1 = b]. */
  at(x: number, z: number): [number, 0 | 1][];
  /** Zones whose circle (grown by extra meters) contains the point. */
  zonesAt(x: number, z: number, extra?: number): Zone[];
  /** The point on segment `index` closest to (x, z), and its distance `t` in meters from the segment's a end. */
  nearestOnSegment(index: number, x: number, z: number): { x: number; z: number; t: number };
}

export const ZONE_MARGIN = 3; // m past the widest branch's edge
export const MERGE_GAP = 6;   // m: zones closer than this merge (roundabouts, dual carriageways)
const MERGE_CELL = 50;        // m: grid hash cell; larger than any merge distance
const BRANCH_TOLERANCE = 5 * Math.PI / 180; // a branch's first segment points within 5° of it
const MAX_TRACE_STEPS = 10_000;

// The car moves along (sin h, cos h) in x, z, and the scene's z points south (z = -y).
export const headingOf = (dx: number, dy: number) => Math.atan2(dx, -dy);

export function toWorldJunctions(junctions: Junction[] = []): WorldJunction[] {
  return junctions.map(j => ({
    id: j.id ?? null, x: j.x, z: -j.y, kind: j.kind, control: j.control,
    branches: j.branches.map(b => ({
      heading: headingOf(b.dx, b.dy),
      halfWidth: (roadStyle({ highway: b.highway, lanes: b.lanes })?.width ?? 6) / 2,
      flow: b.flow, name: b.name,
    })),
  }));
}

// Integer cell / point keys: number-keyed maps are much cheaper to build than string-keyed ones.
// Safe for coordinates within ±50 km (point keys) and any town (cell keys).
const pair = (a: number, b: number) => (a + 1e7) * 2e7 + (b + 1e7);

const baseRadius = (j: WorldJunction) =>
  j.branches.reduce((widest, b) => Math.max(widest, b.halfWidth), 0) + ZONE_MARGIN;

/** Merges junctions that nearly touch into zones. Dead ends never merge. Exits are left empty. */
export function buildZones(junctions: WorldJunction[]): Zone[] {
  const parent = junctions.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const cells = new Map<number, number[]>();
  const cellOf = (v: number) => Math.floor(v / MERGE_CELL);

  junctions.forEach((a, i) => {
    if (a.kind === 'dead_end') return;
    const cx = cellOf(a.x), cz = cellOf(a.z);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const k of cells.get(pair(cx + dx, cz + dz)) ?? []) {
          const b = junctions[k];
          if (Math.hypot(a.x - b.x, a.z - b.z) < baseRadius(a) + baseRadius(b) + MERGE_GAP) parent[find(i)] = find(k);
        }
      }
    }
    const cell = pair(cx, cz);
    (cells.get(cell) ?? cells.set(cell, []).get(cell)!).push(i);
  });

  const groups = new Map<number, WorldJunction[]>();
  junctions.forEach((j, i) => {
    const root = find(i);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(j);
  });

  return [...groups.values()].map(members => {
    const x = members.reduce((sum, m) => sum + m.x, 0) / members.length;
    const z = members.reduce((sum, m) => sum + m.z, 0) / members.length;
    const radius = Math.max(...members.map(m => Math.hypot(m.x - x, m.z - z) + baseRadius(m)));
    const control = members.find(m => m.control)?.control;
    return {
      x, z, radius,
      kind: members.length === 1 ? members[0].kind : 'junction',
      ...(control ? { control } : {}),
      members,
      exits: [],
    };
  });
}

const key = (x: number, z: number) => pair(Math.round(x * 100), Math.round(z * 100)); // tile cuts are rounded to 1 cm too
/** The key `RoadGraph.at` uses for a node: a position rounded to 1 cm. */
export const nodeKey = key;

const angleBetween = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export function createRoadGraph(all: StreetSegment[], junctions: WorldJunction[]): RoadGraph {
  const segments = all.filter(s => s.drivable);
  const ends = new Map<number, [number, 0 | 1][]>();
  segments.forEach((s, i) => {
    for (const [x, z, end] of [[s.ax, s.az, 0], [s.bx, s.bz, 1]] as const) {
      const k = key(x, z);
      (ends.get(k) ?? ends.set(k, []).get(k)!).push([i, end]);
    }
  });
  const none: [number, 0 | 1][] = [];
  const at = (x: number, z: number) => ends.get(key(x, z)) ?? none;
  const point = (i: number, end: 0 | 1): [number, number] =>
    end === 0 ? [segments[i].ax, segments[i].az] : [segments[i].bx, segments[i].bz];

  /** The drivable segment end at the node that leaves it along the heading. */
  function firstSegment(node: WorldJunction, heading: number): [number, 0 | 1] | null {
    let best: [number, 0 | 1] | null = null;
    let bestAngle = BRANCH_TOLERANCE;
    for (const [i, end] of at(node.x, node.z)) {
      const [fx, fz] = point(i, end === 0 ? 1 : 0);
      const angle = angleBetween(Math.atan2(fx - node.x, fz - node.z), heading);
      if (angle <= bestAngle) { bestAngle = angle; best = [i, end]; }
    }
    return best;
  }

  /** Where the segment, entered at `entered`, crosses the zone circle: from the near end, a fraction `u` of it. */
  function crossing(zone: Zone, i: number, entered: 0 | 1): { x: number; z: number } {
    const [nx, nz] = point(i, entered), [fx, fz] = point(i, entered === 0 ? 1 : 0);
    const dx = fx - nx, dz = fz - nz, ox = nx - zone.x, oz = nz - zone.z;
    const a = dx * dx + dz * dz, b = 2 * (dx * ox + dz * oz), c = ox * ox + oz * oz - zone.radius * zone.radius;
    const root = Math.sqrt(Math.max(0, b * b - 4 * a * c));
    const u = a === 0 ? 0 : Math.min(1, Math.max(0, (-b + root) / (2 * a)));
    return { x: nx + dx * u, z: nz + dz * u };
  }

  /**
   * Follows a branch while each point has exactly one continuation. 'internal' if it reaches another member,
   * otherwise the exit's own data: the segment where it leaves the circle, or the last one it reached.
   */
  function traceBranch(zone: Zone, from: WorldJunction, heading: number, members: Set<number>):
    'internal' | Pick<ZoneExit, 'segment' | 'dir' | 'edgePoint'> {
    let current = firstSegment(from, heading);
    let last: Pick<ZoneExit, 'segment' | 'dir' | 'edgePoint'> = {};
    for (let step = 0; current && step < MAX_TRACE_STEPS; step++) {
      const [i, entered] = current;
      const far: 0 | 1 = entered === 0 ? 1 : 0;
      const [x, z] = point(i, far);
      const k = key(x, z);
      if (members.has(k)) return 'internal';
      const dir: 1 | -1 = entered === 0 ? 1 : -1; // running away from the zone
      if (Math.hypot(x - zone.x, z - zone.z) > zone.radius) {
        return { segment: i, dir, edgePoint: crossing(zone, i, entered) }; // left the zone: an exit
      }
      last = { segment: i, dir, edgePoint: { x, z } };
      // Exactly one other segment end here: the road goes on. Any other count is a junction
      // outside the zone's members, or a gap in the data.
      const here = ends.get(k) ?? none;
      if (here.length !== 2) return last;
      current = here[0][0] === i && here[0][1] === far ? here[1] : here[0];
    }
    return last;
  }

  const zones = buildZones(junctions);
  for (const zone of zones) {
    const members = new Set(zone.members.map(m => key(m.x, m.z)));
    for (const m of zone.members) {
      for (const branch of m.branches) {
        const traced = traceBranch(zone, m, branch.heading, members);
        if (traced !== 'internal') zone.exits.push({ ...branch, from: m, ...traced });
      }
    }
  }

  return {
    segments,
    zones,
    at,
    zonesAt: (x, z, extra = 0) => zones.filter(zone => Math.hypot(x - zone.x, z - zone.z) <= zone.radius + extra),
    nearestOnSegment(index, x, z) {
      const s = segments[index];
      const length = Math.hypot(s.bx - s.ax, s.bz - s.az);
      if (length === 0) return { x: s.ax, z: s.az, t: 0 };
      const t = Math.min(length, Math.max(0, ((x - s.ax) * (s.bx - s.ax) + (z - s.az) * (s.bz - s.az)) / length));
      return { x: s.ax + (s.bx - s.ax) * t / length, z: s.az + (s.bz - s.az) * t / length, t };
    },
  };
}
