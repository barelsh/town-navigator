import type { TownBounds } from '@town-navigator/shared';
import { distanceToSegment, pointInRing, type Point2 } from './geometry.ts';
import type { StreetSegment } from './roads.ts';

const CAR_RADIUS = 1.1;
const OFF_ROAD_MARGIN = 3;        // meters past a road's edge that still count as on it
const NAMED_ROAD_PRIORITY = 1000; // named surfaces beat unnamed ones where roads overlap

export interface Obstacle {
  ring: Point2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function touchesRing(x: number, z: number, ring: Point2[], radius: number): boolean {
  return ring.some(([ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % ring.length];
    return distanceToSegment(x, z, ax, az, bx, bz) < radius;
  });
}

export function hitsBuilding(obstacles: Obstacle[], x: number, z: number, radius = CAR_RADIUS): boolean {
  return obstacles.some(b =>
    x > b.minX - radius && x < b.maxX + radius &&
    z > b.minZ - radius && z < b.maxZ + radius &&
    (pointInRing(x, z, b.ring) || touchesRing(x, z, b.ring, radius)));
}

/** Tests circles along the vehicle's center line, each [offset forward, radius], for a car at x, z facing `heading`. */
export function hitsVehicle(
  obstacles: Obstacle[], x: number, z: number, heading: number, circles: [along: number, radius: number][]
): boolean {
  const fx = Math.sin(heading), fz = Math.cos(heading);
  return circles.some(([along, radius]) => hitsBuilding(obstacles, x + fx * along, z + fz * along, radius));
}

/** How far into a building the circle reaches, in meters: 0 when clear, more the deeper it is. */
function circleOverlap(obstacles: Obstacle[], x: number, z: number, radius: number): number {
  let depth = 0;
  for (const b of obstacles) {
    if (x <= b.minX - radius || x >= b.maxX + radius || z <= b.minZ - radius || z >= b.maxZ + radius) continue;
    let edge = Infinity;
    b.ring.forEach(([ax, az], i) => {
      const [bx, bz] = b.ring[(i + 1) % b.ring.length];
      edge = Math.min(edge, distanceToSegment(x, z, ax, az, bx, bz));
    });
    const reach = pointInRing(x, z, b.ring) ? radius + edge : radius - edge;
    depth = Math.max(depth, reach);
  }
  return depth;
}

/** How far the vehicle's circles reach into buildings, added up; 0 when it is clear. Summing, not taking the deepest, keeps a
 * vehicle that is deep inside one building able to tell that backing out helps. */
export function vehicleOverlap(
  obstacles: Obstacle[], x: number, z: number, heading: number, circles: [along: number, radius: number][]
): number {
  const fx = Math.sin(heading), fz = Math.cos(heading);
  return circles.reduce((total, [along, radius]) =>
    total + circleOverlap(obstacles, x + fx * along, z + fz * along, radius), 0);
}

/** How far a point is beyond the town's edge; 0 inside it. */
export function outsideDepth([minX, minY, maxX, maxY]: TownBounds, x: number, z: number): number {
  const beyond = Math.max(minX - x, x - maxX, z - (-minY), -maxY - z, 0);
  return beyond > 0 ? beyond + 0.01 : 0;
}

/** The road whose surface the point is deepest inside; null when off-road or the road is unnamed. */
export function currentStreet(segments: StreetSegment[], x: number, z: number): string | null {
  let best: StreetSegment | null = null;
  let bestScore = OFF_ROAD_MARGIN;
  for (const s of segments) {
    const edgeDistance = distanceToSegment(x, z, s.ax, s.az, s.bx, s.bz) - s.halfWidth;
    const score = s.name && edgeDistance <= 0 ? edgeDistance - NAMED_ROAD_PRIORITY : edgeDistance;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best?.name ?? null;
}
