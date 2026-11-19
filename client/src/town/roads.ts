import * as THREE from 'three';
import type { RoadFeature, TownFeature } from '@town-navigator/shared';
import type { Point2 } from './geometry.ts';
import { MIN_DRIVABLE_LAYER, ROAD_RANKS, roadRank, roadStyle, type RoadStyle } from './roadStyles.ts';
import { createStreetLabels, type LabelKit, type StreetLabels } from './streetLabels.ts';

const ROAD_BASE_Y = 0.05;
const ROAD_RANK_GAP = 0.004; // meters; fixed per (layer, color) so tiles line up
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
  /** Removes the roads from the scene and frees their geometries. Kit materials stay. */
  dispose(): void;
}

/** Built once: one surface material per color and the center line material, shared by every chunk. */
export interface RoadKit {
  surface(color: number): THREE.MeshLambertMaterial;
  line: THREE.MeshBasicMaterial;
}

export function createRoadKit(): RoadKit {
  const surfaces = new Map<number, THREE.MeshLambertMaterial>();
  return {
    surface(color) {
      let material = surfaces.get(color);
      if (!material) {
        material = new THREE.MeshLambertMaterial({ color });
        surfaces.set(color, material);
      }
      return material;
    },
    line: new THREE.MeshBasicMaterial({ color: 0xf5f1d0 }),
  };
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

/** Draws the roads among the features, merged into one mesh per layer and color, into the parent. */
export function addRoads(
  parent: THREE.Object3D,
  features: TownFeature[],
  kit: { roads: RoadKit; labels: LabelKit },
): RoadNetwork {
  const labels = createStreetLabels(parent, kit.labels);
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

  for (const road of features.filter(isRoad)) {
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

  // Each (layer, color) pair has a fixed height, so overlapping road surfaces don't flicker and tiles line up.
  const meshes: THREE.Mesh[] = [];
  for (const { layer, color, positions } of buckets.values()) {
    const surface = flatMesh(positions, kit.roads.surface(color));
    surface.position.y = ROAD_BASE_Y + roadRank({ layer, color }) * ROAD_RANK_GAP;
    surface.receiveShadow = true;
    parent.add(surface);
    meshes.push(surface);
  }

  const lineY = ROAD_BASE_Y + ROAD_RANKS * ROAD_RANK_GAP;
  if (linePositions.length) {
    const centerLines = flatMesh(linePositions, kit.roads.line);
    centerLines.position.y = lineY;
    parent.add(centerLines);
    meshes.push(centerLines);
  }
  labels.setHeight(lineY + ROAD_RANK_GAP);
  labels.finish();

  return {
    segments,
    labels,
    dispose() {
      labels.dispose();
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
      }
      meshes.length = 0;
    },
  };
}
