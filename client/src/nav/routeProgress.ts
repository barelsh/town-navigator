// The route in world space and the car's progress along it (TN-39). Pure code, so `node --test` can load it.
//
// World meters: x east, z south (z = −y of the map). A heading h faces (sin h, cos h) in x, z; the compass bearing
// is 180° − h, so a map bearing b (degrees clockwise from north) is the heading π − b.

import type { Maneuver, Route, RouteStretch, TurnKind } from '@town-navigator/shared';

export interface XZ { x: number; z: number }
export interface WorldManeuver extends Maneuver { wx: number; wz: number; inHeading: number; outHeading: number }

export interface WorldRoute {
  distance: number;
  points: XZ[];
  /** Meters along the route to each point. */
  cum: Float64Array;
  stretches: RouteStretch[];
  maneuvers: WorldManeuver[];
  start: XZ;
  destination: XZ;
}

export const toHeading = (bearingDeg: number) => Math.PI - (bearingDeg * Math.PI) / 180;
/** The compass bearing, 0..360, of a world heading. */
export const toBearing = (heading: number) => ((((180 - (heading * 180) / Math.PI) % 360) + 360) % 360);
export const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function toWorldRoute(route: Route): WorldRoute {
  const points = route.points.map(([x, y]) => ({ x, z: -y }));
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  return {
    distance: route.distance,
    points,
    cum,
    stretches: route.stretches,
    maneuvers: route.maneuvers.map(m => ({ ...m, wx: m.x, wz: -m.y, inHeading: toHeading(m.inBearing), outHeading: toHeading(m.outBearing) })),
    start: { x: route.start.x, z: -route.start.y },
    destination: { x: route.destination.x, z: -route.destination.y },
  };
}

export interface Progress {
  /** The route segment the car is on. */
  index: number;
  /** Meters along the route. */
  along: number;
  /** Meters from the route line. */
  offset: number;
  /** The route's direction there. */
  heading: number;
}

export const WINDOW_BACK = 2, WINDOW_AHEAD = 60; // segments searched around the last one

/** Windowed projection onto the route, from segment `from`: 2 back and 60 ahead, so it never jumps to a far part of the route. */
export function project(r: WorldRoute, x: number, z: number, from: number): Progress {
  let best: Progress = { index: from, along: r.cum[Math.min(from, r.cum.length - 1)], offset: Infinity, heading: 0 };
  for (let i = Math.max(0, from - WINDOW_BACK); i < Math.min(r.points.length - 1, from + WINDOW_AHEAD); i++) {
    const a = r.points[i], b = r.points[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.min(1, Math.max(0, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (d < best.offset) best = { index: i, along: r.cum[i] + t * Math.sqrt(l2), offset: d, heading: Math.atan2(dx, dz) };
  }
  return best;
}

/** Whether the card names a maneuver: a turn, a roundabout, or a straight that needs saying. */
export const isShown = (m: Maneuver) => m.turn !== 'straight' || m.ambiguous === true;

export const PASSED = 5; // m: a maneuver this far behind the car is done

/** The next shown maneuver ahead of `along`, and the one after it; undefined when only the arrival is left. */
export function nextManeuvers(r: WorldRoute, along: number): { next?: WorldManeuver; after?: WorldManeuver } {
  const ahead = r.maneuvers.filter(m => isShown(m) && m.along > along - PASSED);
  return { next: ahead[0], after: ahead[1] };
}

export const THEN_GAP = 80; // m between two maneuvers for the second to be named under the first

export const GLYPH: Record<TurnKind | 'arrive', string> = {
  straight: '↑', slight_left: '↖', left: '↰', sharp_left: '↲', slight_right: '↗', right: '↱', sharp_right: '↳',
  uturn: '⤺', roundabout: '⟲', arrive: '⚑',
};

const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;

export function turnText(m: Maneuver): string {
  if (m.turn === 'roundabout') return m.exit ? `Roundabout, ${ordinal(m.exit)} exit` : 'Roundabout';
  return {
    straight: 'Continue straight', slight_left: 'Slight left', left: 'Turn left', sharp_left: 'Sharp left',
    slight_right: 'Slight right', right: 'Turn right', sharp_right: 'Sharp right', uturn: 'Make a U-turn',
  }[m.turn];
}

export function formatDistance(m: number): string {
  if (m < 30) return 'Now';
  if (m < 100) return `${Math.round(m / 10) * 10} m`;
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

/** Kilometers with one decimal, or meters under 1 km, for distances left and straight-line distances. */
export const formatLength = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

export function formatDuration(seconds: number): string {
  if (seconds < 60) return '< 1 min';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
