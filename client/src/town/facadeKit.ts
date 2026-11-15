import * as THREE from 'three';
import type { TownProperties } from '@town-navigator/shared';
import { LEVEL_HEIGHT } from './buildingStyles.ts';
import type { Point2 } from './geometry.ts';

/** A wall's local frame: start point, unit direction along it, outward normal and length. */
export interface Wall { ax: number; az: number; ux: number; uz: number; nx: number; nz: number; length: number; }

export interface FacadeStats {
  boxes: number;
  calls: number;
}

export interface PartDefinition {
  color?: number;
  map?: THREE.Texture;
  shadow?: boolean;
  opacity?: number;
  lift?: number;
}

/** The building:levels tag when valid, else the floors the height allows. */
export function floorCount(properties: TownProperties, height: number): number {
  const levels = parseInt(properties['building:levels'] ?? '', 10);
  return levels > 0 ? levels : Math.max(1, Math.round(height / LEVEL_HEIGHT));
}

// FNV-1a, so a building's variant depends only on its id, not on the order buildings load in.
export function hashId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}

export function signedArea(ring: Point2[]): number {
  return ring.reduce((sum, [ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % ring.length];
    return sum + ax * bz - bx * az;
  }, 0) / 2;
}

/** Rings can be wound either way. Wall normals expect a negative signed area. */
export function windOutward(ring: Point2[]): Point2[] {
  return signedArea(ring) > 0 ? [...ring].reverse() : ring;
}

// Expects a ring with negative signed area, so that (-uz, ux) points out of the building.
export function wallsOf(ring: Point2[]): Wall[] {
  return ring.map(([ax, az], i) => {
    const [bx, bz] = ring[(i + 1) % ring.length];
    const length = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / length, uz = (bz - az) / length;
    return { ax, az, ux, uz, nx: -uz, nz: ux, length };
  });
}

/** Collects unit boxes per part type, then turns each type into one instanced mesh. */
export function createPartStore<P extends string>(definitions: Record<P, PartDefinition>) {
  const names = Object.keys(definitions) as P[];
  const parts = Object.fromEntries(names.map(name => [name, [] as THREE.Matrix4[]])) as Record<P, THREE.Matrix4[]>;
  const matrix = new THREE.Matrix4(), u = new THREE.Vector3(), n = new THREE.Vector3(), size = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  return {
    /** A unit box sized and placed in the wall's frame: `along` the wall, at height `y`, `out` from its face. */
    place(part: P, w: Wall, along: number, y: number, out: number, sizeU: number, sizeV: number, sizeW: number): void {
      matrix.makeBasis(u.set(w.ux, 0, w.uz), UP, n.set(w.nx, 0, w.nz)).scale(size.set(sizeU, sizeV, sizeW));
      matrix.setPosition(w.ax + w.ux * along + w.nx * out, y, w.az + w.uz * along + w.nz * out);
      parts[part].push(matrix.clone());
    },

    /** Adds one instanced mesh per part type to the parent. */
    finish(parent: THREE.Object3D): FacadeStats {
      const box = new THREE.BoxGeometry(1, 1, 1);
      let boxes = 0, calls = 0;
      for (const name of names) {
        const def = definitions[name], list = parts[name];
        if (!list.length) continue;

        const material = new THREE.MeshLambertMaterial(def.map ? { map: def.map } : { color: def.color });
        if (def.opacity) Object.assign(material, { transparent: true, opacity: def.opacity, depthWrite: false });
        if (def.lift) {
          material.emissiveIntensity = def.lift;
          if (def.map) {
            material.emissive.set(0xffffff);
            material.emissiveMap = def.map;
          } else {
            material.emissive.set(def.color!);
          }
        }

        const mesh = new THREE.InstancedMesh(box, material, list.length);
        list.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.frustumCulled = false; // each mesh spans the town
        mesh.castShadow = Boolean(def.shadow);
        mesh.receiveShadow = !def.opacity;
        parent.add(mesh);
        boxes += list.length;
        calls++;
      }
      return { boxes, calls };
    },
  };
}
