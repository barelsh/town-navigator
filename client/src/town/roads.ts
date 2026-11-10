import * as THREE from 'three';
import type { RoadFeature, Town, TownFeature } from '@town-navigator/shared';
import type { Point2 } from './geometry.ts';
import { MIN_DRIVABLE_LAYER, roadStyle, type RoadStyle } from './roadStyles.ts';
import { createStreetLabels, type StreetLabels } from './streetLabels.ts';

const ROAD_BASE_Y = 0.05;
const ROAD_LAYER_GAP = 0.008;
const LINE_WIDTH = 0.25;
const DASH_LENGTH = 2.2;
const DASH_SPACING = 5;
const JOINT_SEGMENTS = 12;

export interface StreetSegment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  halfWidth: number;
  name: string | undefined;
  drivable: boolean;
}

export interface StartPosition {
  x: number;
  z: number;
  heading: number;
}

export interface RoadNetwork {
  segments: StreetSegment[];
  labels: StreetLabels;
}

interface SurfaceBucket {
  layer: number;
  color: number;
  positions: number[];
}

function addQuad(out: number[], ax: number, az: number, bx: number, bz: number, halfWidth: number): void {
  const length = Math.hypot(bx - ax, bz - az);
  const sx = (bz - az) / length * halfWidth;
  const sz = -(bx - ax) / length * halfWidth;
  out.push(
    ax + sx, 0, az + sz, ax - sx, 0, az - sz, bx - sx, 0, bz - sz,
    ax + sx, 0, az + sz, bx - sx, 0, bz - sz, bx + sx, 0, bz + sz
  );
}

function addDisc(out: number[], x: number, z: number, radius: number): void {
  const point = (i: number) => {
    const angle = (i / JOINT_SEGMENTS) * Math.PI * 2;
    return [x + Math.cos(angle) * radius, 0, z + Math.sin(angle) * radius];
  };
  for (let i = 0; i < JOINT_SEGMENTS; i++) out.push(x, 0, z, ...point(i + 1), ...point(i));
}

function addDashes(out: number[], ax: number, az: number, bx: number, bz: number, length: number, travelled: number): void {
  const ux = (bx - ax) / length, uz = (bz - az) / length;
  const end = travelled + length;
  for (let dash = Math.floor(travelled / DASH_SPACING) * DASH_SPACING; dash < end; dash += DASH_SPACING) {
    const from = Math.max(dash, travelled) - travelled;
    const to = Math.min(dash + DASH_LENGTH, end) - travelled;
    if (to > from) {
      addQuad(out, ax + ux * from, az + uz * from, ax + ux * to, az + uz * to, LINE_WIDTH / 2);
    }
  }
}

function flatMesh(positions: number[], material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

export interface StartMatch extends StartPosition {
  name: string | undefined;
  distance: number;
}

/** The point on a drivable road closest to the target, heading along the road. */
export function findStart(segments: StreetSegment[], target: { x: number; z: number }): StartMatch {
  let best: StartMatch = { x: target.x, z: target.z, heading: 0, name: undefined, distance: 0 }; // no drivable road
  let closest = Infinity;
  for (const { ax, az, bx, bz, drivable, name } of segments) {
    if (!drivable) continue;
    const dx = bx - ax, dz = bz - az;
    const t = THREE.MathUtils.clamp(((target.x - ax) * dx + (target.z - az) * dz) / (dx * dx + dz * dz), 0, 1);
    const x = ax + t * dx, z = az + t * dz;
    const distance = Math.hypot(x - target.x, z - target.z);
    if (distance < closest) {
      closest = distance;
      best = { x, z, heading: Math.atan2(dx, dz), name, distance };
    }
  }
  return best;
}

const isRoad = (feature: TownFeature): feature is RoadFeature =>
  Boolean(feature.properties.highway) && feature.geometry.type === 'LineString';

/** Draws all roads merged into one mesh per layer and color. */
export function addRoads(scene: THREE.Scene, renderer: THREE.WebGLRenderer, town: Town): RoadNetwork {
  const labels = createStreetLabels(scene, renderer);
  const segments: StreetSegment[] = [];
  const buckets = new Map<string, SurfaceBucket>();
  const linePositions: number[] = [];

  function surfacePositions({ layer, color }: RoadStyle): number[] {
    const key = `${layer}:${color}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { layer, color, positions: [] };
      buckets.set(key, bucket);
    }
    return bucket.positions;
  }

  for (const road of town.features.filter(isRoad)) {
    const style = roadStyle(road.properties);
    if (!style) continue;

    const points = road.geometry.coordinates.map(([x, y]): Point2 => [x, -y]);
    const positions = surfacePositions(style);
    let travelled = 0;

    points.forEach(([x, z]) => addDisc(positions, x, z, style.width / 2));
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i], [bx, bz] = points[i + 1];
      const length = Math.hypot(bx - ax, bz - az);
      if (length === 0) continue;
      addQuad(positions, ax, az, bx, bz, style.width / 2);
      segments.push({
        ax, az, bx, bz,
        halfWidth: style.width / 2,
        name: road.properties.name,
        drivable: style.layer >= MIN_DRIVABLE_LAYER,
      });
      if (style.line) addDashes(linePositions, ax, az, bx, bz, length, travelled);
      travelled += length;
    }

    if (road.properties.name && travelled > 0) labels.add(road.properties.name, points, travelled, style.width);
  }

  // Each bucket gets its own height so overlapping road surfaces don't flicker.
  const sortedBuckets = [...buckets.values()].sort((a, b) => a.layer - b.layer || a.color - b.color);
  sortedBuckets.forEach(({ color, positions }, i) => {
    const surface = flatMesh(positions, new THREE.MeshLambertMaterial({ color }));
    surface.position.y = ROAD_BASE_Y + i * ROAD_LAYER_GAP;
    surface.receiveShadow = true;
    scene.add(surface);
  });

  const centerLines = flatMesh(linePositions, new THREE.MeshBasicMaterial({ color: 0xf5f1d0 }));
  centerLines.position.y = ROAD_BASE_Y + sortedBuckets.length * ROAD_LAYER_GAP;
  scene.add(centerLines);
  labels.setHeight(centerLines.position.y + ROAD_LAYER_GAP);

  return { segments, labels };
}
