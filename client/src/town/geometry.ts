import * as THREE from 'three';

/** A world position on the ground: GeoJSON [x east, y north] maps to world [x, -y]. */
export type Point2 = [x: number, z: number];

export function pointAlong(points: Point2[], distance: number): Point2 {
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1];
    const length = Math.hypot(bx - ax, bz - az);
    if (distance <= length && length > 0) {
      return [ax + (bx - ax) * distance / length, az + (bz - az) * distance / length];
    }
    distance -= length;
  }
  return points[points.length - 1];
}

export function pointInRing(x: number, z: number, ring: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[j];
    if ((az > z) !== (bz > z) && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

export function distanceToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
  return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
}
