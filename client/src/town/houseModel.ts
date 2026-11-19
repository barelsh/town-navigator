import * as THREE from 'three';
import type { BuildingFeature } from '@town-navigator/shared';
import { ringArea } from './buildingInfo.ts';
import { buildingGroup, buildingHeight, buildingIcon, LEVEL_HEIGHT } from './buildingStyles.ts';
import { hashId, windOutward } from './facadeKit.ts';
import type { Point2 } from './geometry.ts';
import { planHipRoof, type HipRoofPlan } from './houseRoof.ts';

const MAX_HOUSE_FOOTPRINT = 450; // m²
const MAX_HOUSE_FLOORS = 3;      // taller untyped buildings are blocks, not houses

const OVERHANG = 0.45;       // meters the roof sticks out past the walls
const ROOF_SLOPE = 0.55;     // rise per meter, about 29 degrees
const MAX_ROOF_RISE = 3.2;   // meters, flattens the pitch on wide houses
const PARAPET = 0.4;         // meters, flat roofs only
const TILE_REPEAT = 2;       // meters of roof per texture repeat
const BAY_WIDTH = 3;         // meters of wall per window
const MIN_WINDOW_WALL = 2.2; // shorter walls stay plain plaster

const ROOF_COLORS = [0xe67a3c, 0xd96c32, 0xee8c4e, 0xcf6530];
const DUPLEX_ROOF_COLORS = [0x8a9096, 0x7b8187, 0x969ba0, 0x6f757b];
const WALL_COLORS = [0xf6f0e4, 0xefe6d6, 0xf8f5ee];
export const WALL_LIFT = 0.42; // the game's lights leave vertical walls dim
export const ROOF_LIFT = 0.2;  // keeps tiles orange rather than brown

const GROUP_ROOF = 0, GROUP_WINDOWS = 1, GROUP_PLASTER = 2;

/** Floors of a home or untyped building that gets a house model, else null. */
export function houseFloors({ properties, geometry }: BuildingFeature): number | null {
  const group = buildingGroup(properties);
  if (group !== 'house' && group !== 'unknown') return null;
  if (buildingIcon(properties) || geometry.coordinates.length > 1) return null;
  const levels = parseFloat(properties['building:levels'] ?? '');
  const floors = levels > 0 ? Math.round(levels) : Math.max(1, Math.round(buildingHeight(properties) / LEVEL_HEIGHT));
  if (floors < 1 || floors > MAX_HOUSE_FLOORS) return null;
  return ringArea(geometry.coordinates[0]) <= MAX_HOUSE_FOOTPRINT ? floors : null;
}

interface Vertex { p: [number, number, number]; uv: [number, number] }
type Triangle = (group: number, a: Vertex, b: Vertex, c: Vertex, faceUp: boolean) => void;

/** Walls and roof as one geometry with three material groups, in world coordinates. */
export function createHouseGeometry(footprint: Point2[], wallHeight: number, floors = 1): THREE.BufferGeometry {
  // per group: position (3), normal (3) and uv (2) per vertex
  const buckets: number[][] = [[], [], []];

  const triangle: Triangle = (group, a, b, c, faceUp) => {
    const [ax, ay, az] = a.p, [bx, by, bz] = b.p, [cx, cy, cz] = c.p;
    const e1 = [bx - ax, by - ay, bz - az], e2 = [cx - ax, cy - ay, cz - az];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-6) return; // a square rectangle's ridge has no length
    let points = [a, b, c];
    if ((ny > 0) !== faceUp) { points = [a, c, b]; nx = -nx; ny = -ny; nz = -nz; }
    for (const { p, uv } of points) buckets[group].push(...p, nx / length, ny / length, nz / length, ...uv);
  };

  const ring = windOutward(footprint);
  const plan = planHipRoof(ring);
  const wallTop = plan ? wallHeight : wallHeight + PARAPET;

  ring.forEach(([ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % ring.length];
    const length = Math.hypot(bx - ax, bz - az);
    if (length < 1e-3) return;
    const nx = -(bz - az) / length, nz = (bx - ax) / length;
    const hasWindows = length >= MIN_WINDOW_WALL && Boolean(plan);
    const group = hasWindows ? GROUP_WINDOWS : GROUP_PLASTER;
    const u1 = hasWindows ? Math.max(1, Math.round(length / BAY_WIDTH)) / 2 : length / BAY_WIDTH;
    const quad = [[ax, 0, az, 0, 0], [bx, 0, bz, u1, 0], [bx, wallTop, bz, u1, floors], [ax, wallTop, az, 0, floors]];
    for (const corners of [[0, 1, 2], [0, 2, 3]]) {
      for (const k of corners) {
        const [x, y, z, u, v] = quad[k];
        buckets[group].push(x, y, z, nx, 0, nz, u, v);
      }
    }
  });

  if (plan) addHipRoofs(plan, wallHeight, triangle);
  else addFlatRoof(ring, wallTop, triangle);

  const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
  const geometry = new THREE.BufferGeometry();
  buckets.forEach((bucket, group) => {
    const start = positions.length / 3;
    for (let i = 0; i < bucket.length; i += 8) {
      positions.push(bucket[i], bucket[i + 1], bucket[i + 2]);
      normals.push(bucket[i + 3], bucket[i + 4], bucket[i + 5]);
      uvs.push(bucket[i + 6], bucket[i + 7]);
    }
    geometry.addGroup(start, bucket.length / 8, group);
  });
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  return geometry;
}

function addHipRoofs({ ux, uz, rects }: HipRoofPlan, wallHeight: number, triangle: Triangle): void {
  const widest = Math.max(...rects.map(r =>
    Math.min(r.maxU - r.minU, r.maxV - r.minV) / 2 + OVERHANG));
  // One slope per house, so the faces of every rectangle meet in clean valleys.
  const slope = Math.min(ROOF_SLOPE, MAX_ROOF_RISE / widest);
  const eaveY = wallHeight - slope * OVERHANG;
  const slant = Math.hypot(1, slope) / slope; // roof distance per meter of height
  const world = (a: number, b: number, y: number): [number, number, number] =>
    [a * ux - b * uz, y, a * uz + b * ux];

  type Corner = [a: number, b: number, y: number];
  type Make = (a: number, b: number, y: number) => Vertex;

  for (const r of rects) {
    const a0 = r.minU - OVERHANG, a1 = r.maxU + OVERHANG;
    const b0 = r.minV - OVERHANG, b1 = r.maxV + OVERHANG;
    const half = Math.min(a1 - a0, b1 - b0) / 2;
    const ridgeY = eaveY + half * slope;
    const midA = (a0 + a1) / 2, midB = (b0 + b1) / 2;
    const alongA = a1 - a0 >= b1 - b0;
    const r0 = alongA ? [a0 + half, midB] : [midA, b0 + half];
    const r1 = alongA ? [a1 - half, midB] : [midA, b1 - half];

    // uv: along the eave, then up the slope, so overlapping faces line up exactly.
    const faceA: Make = (a, b, y) => ({ p: world(a, b, y), uv: [b / TILE_REPEAT, (y - eaveY) * slant / TILE_REPEAT] });
    const faceB: Make = (a, b, y) => ({ p: world(a, b, y), uv: [a / TILE_REPEAT, (y - eaveY) * slant / TILE_REPEAT] });
    const up = (make: Make, p: Corner, q: Corner, s: Corner) =>
      triangle(GROUP_ROOF, make(...p), make(...q), make(...s), true);

    const c00: Corner = [a0, b0, eaveY], c10: Corner = [a1, b0, eaveY];
    const c11: Corner = [a1, b1, eaveY], c01: Corner = [a0, b1, eaveY];
    const top0: Corner = [r0[0], r0[1], ridgeY], top1: Corner = [r1[0], r1[1], ridgeY];

    if (alongA) {
      up(faceB, c00, c10, top1); up(faceB, c00, top1, top0);
      up(faceB, c11, c01, top0); up(faceB, c11, top0, top1);
      up(faceA, c10, c11, top1);
      up(faceA, c01, c00, top0);
    } else {
      up(faceA, c10, c11, top1); up(faceA, c10, top1, top0);
      up(faceA, c01, c00, top0); up(faceA, c01, top0, top1);
      up(faceB, c11, c01, top1);
      up(faceB, c00, c10, top0);
    }

    // Underside of the overhang, seen from the street.
    const flat = (a: number, b: number): Vertex => ({ p: world(a, b, eaveY), uv: [0, 0] });
    triangle(GROUP_PLASTER, flat(a0, b0), flat(a1, b0), flat(a1, b1), false);
    triangle(GROUP_PLASTER, flat(a0, b0), flat(a1, b1), flat(a0, b1), false);
  }
}

function addFlatRoof(ring: Point2[], y: number, triangle: Triangle): void {
  const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
  const vertex = ([x, z]: Point2): Vertex => ({ p: [x, y, z], uv: [0, 0] });
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    triangle(GROUP_PLASTER, vertex(ring[a]), vertex(ring[b]), vertex(ring[c]), true);
  }
}

function canvasTexture(width: number, height: number,
    draw: (context: CanvasRenderingContext2D, width: number, height: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!, width, height);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

// Light staggered tile courses, tinted by the material color.
export function roofTexture(): THREE.CanvasTexture {
  return canvasTexture(512, 512, (c, s) => {
    let seed = 23;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const courses = 8, tile = s / 8, course = s / courses;
    for (let row = 0; row < courses; row++) {
      const shift = row % 2 ? tile / 2 : 0;
      for (let x = -tile + shift; x < s; x += tile) {
        const tone = 225 + Math.floor(rand() * 30);
        c.fillStyle = `rgb(${tone},${tone},${tone})`;
        c.fillRect(x, row * course, tile, course);
        c.fillStyle = 'rgba(70,40,25,0.2)';
        c.fillRect(x, row * course, 2, course);
      }
      c.fillStyle = 'rgba(60,32,20,0.32)';
      c.fillRect(0, row * course + course - 5, s, 5);
    }
  });
}

// Two bays side by side, 6 m wide and one wall high: one window open, one with its shutter half down.
export function windowTexture(floorLine: boolean): THREE.CanvasTexture {
  return canvasTexture(1024, 512, (c, w, h) => {
    c.fillStyle = '#fff';
    c.fillRect(0, 0, w, h);
    for (const [center, shutter] of [[0.25, 0.28], [0.75, 0.62]]) {
      const winW = w * 0.24, winH = h * 0.48, x = w * center - winW / 2, y = h * 0.2;
      c.fillStyle = '#d9d4ca';
      c.fillRect(x - 12, y - 12, winW + 24, winH + 28); // surround and sill
      c.fillStyle = '#44586a';
      c.fillRect(x, y, winW, winH);
      c.fillStyle = '#f4f2ec';
      c.fillRect(x + winW / 2 - 4, y, 8, winH);
      const shutterH = winH * shutter;
      c.fillStyle = '#c2c5c3';
      c.fillRect(x, y, winW, shutterH);
      c.fillStyle = '#9ea2a1';
      for (let s = 0; s < shutterH; s += 12) c.fillRect(x, y + s, winW, 3);
    }
    if (floorLine) {
      c.fillStyle = 'rgba(120,112,100,0.35)';
      c.fillRect(0, h - 10, w, 10); // the bottom edge of every row is a floor line
    }
  });
}

type HouseKind = 'house' | 'duplex';

/** Roof and wall colors of a house, from the id alone so a house keeps them whatever order tiles load in. */
export function houseColors(id: string, kind: HouseKind = 'house'): { roof: THREE.Color; wall: THREE.Color } {
  const hash = hashId(id);
  const roofColors = kind === 'duplex' ? DUPLEX_ROOF_COLORS : ROOF_COLORS;
  return {
    roof: new THREE.Color(roofColors[hash % roofColors.length]),
    wall: new THREE.Color(WALL_COLORS[(hash >>> 8) % WALL_COLORS.length]),
  };
}

export const duplexWindowTexture = () => windowTexture(true);
