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

function touchesRing(x: number, z: number, ring: Point2[]): boolean {
  return ring.some(([ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % ring.length];
    return distanceToSegment(x, z, ax, az, bx, bz) < CAR_RADIUS;
  });
}

export function hitsBuilding(obstacles: Obstacle[], x: number, z: number): boolean {
  return obstacles.some(b =>
    x > b.minX - CAR_RADIUS && x < b.maxX + CAR_RADIUS &&
    z > b.minZ - CAR_RADIUS && z < b.maxZ + CAR_RADIUS &&
    (pointInRing(x, z, b.ring) || touchesRing(x, z, b.ring)));
}

export function outsideTown([minX, minY, maxX, maxY]: TownBounds, x: number, z: number): boolean {
  return x < minX || x > maxX || z < -maxY || z > -minY;
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
