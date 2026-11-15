import * as THREE from 'three';

// Material slots, in the order vehicleMaterials() returns them.
export const PAINT = 0, GLASS = 1, TRIM = 2, LIGHT = 3, TAIL = 4, ACCENT = 5, HUB = 6;
const SLOTS = HUB + 1;

/** [z forward, y up] */
export type ProfilePoint = [number, number];

export interface Part {
  material: number;
  geometry: THREE.BufferGeometry;
}

/** The shapes a vehicle's `build` function composes. Everything is centered on x = 0, z = 0, with y up from the road. */
export interface Kit {
  readonly parts: Part[];
  /** Side profile extruded across `width` and centered on x. */
  profile(material: number, points: ProfilePoint[], width: number, x?: number): void;
  box(material: number, w: number, h: number, l: number, x: number, y: number, z: number, tilt?: number): void;
  /** Top half of a cylinder lying across the car, e.g. a fender over a wheel. */
  fender(material: number, radius: number, width: number, x: number, y: number, z: number): void;
  /** A cylinder whose axis runs front to back, e.g. a spare wheel. */
  disc(material: number, radius: number, length: number, x: number, y: number, z: number): void;
  /** A headlight and a tail light for each x. */
  lights(xs: number[], front: number, rear: number, y: number, size?: [number, number]): void;
}

export function createKit(): Kit {
  const parts: Part[] = [];
  const add = (material: number, geometry: THREE.BufferGeometry) => parts.push({ material, geometry });
  const kit: Kit = {
    parts,
    profile(material, points, width, x = 0) {
      const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
      const bevel = Math.min(0.05, width / 10);
      const depth = width - bevel * 2;
      const geometry = new THREE.ExtrudeGeometry(shape, {
        depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.6, bevelSegments: 1, curveSegments: 4,
      });
      geometry.rotateY(-Math.PI / 2); // shape x becomes forward (z), extrusion runs along -x
      geometry.translate(x + depth / 2, 0, 0);
      add(material, geometry);
    },
    box(material, w, h, l, x, y, z, tilt = 0) {
      const geometry = new THREE.BoxGeometry(w, h, l);
      if (tilt) geometry.rotateX(tilt);
      geometry.translate(x, y, z);
      add(material, geometry);
    },
    fender(material, radius, width, x, y, z) {
      const geometry = new THREE.CylinderGeometry(radius, radius, width, 8, 1, false, 0, Math.PI);
      geometry.rotateZ(Math.PI / 2);
      geometry.translate(x, y, z);
      add(material, geometry);
    },
    disc(material, radius, length, x, y, z) {
      const geometry = new THREE.CylinderGeometry(radius, radius, length, 12);
      geometry.rotateX(Math.PI / 2);
      geometry.translate(x, y, z);
      add(material, geometry);
    },
    lights(xs, front, rear, y, size = [0.36, 0.16]) {
      for (const x of xs) {
        kit.box(LIGHT, size[0], size[1], 0.05, x, y, front + 0.02);
        kit.box(TAIL, size[0], size[1], 0.05, x, y, rear - 0.02);
      }
    },
  };
  return kit;
}

/** One geometry with one group per material slot, so a body is a single mesh. */
export function mergeByMaterial(parts: Part[]): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [];
  const merged = new THREE.BufferGeometry();
  for (let slot = 0; slot < SLOTS; slot++) {
    const start = positions.length / 3;
    for (const { material, geometry } of parts) {
      if (material !== slot) continue;
      const flat = geometry.index ? geometry.toNonIndexed() : geometry;
      const position = flat.attributes.position.array, normal = flat.attributes.normal.array;
      for (let i = 0; i < position.length; i++) { positions.push(position[i]); normals.push(normal[i]); }
    }
    const count = positions.length / 3 - start;
    if (count) merged.addGroup(start, count, slot);
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  parts.forEach(part => part.geometry.dispose());
  return merged;
}

/** A tire with a hub, or just a tire with `plain`. The axis is x, so rotation.x rolls it. */
export function wheelGeometry(radius: number, width: number, plain = false): THREE.BufferGeometry {
  const tire = new THREE.CylinderGeometry(radius, radius, width, plain ? 14 : 12);
  tire.rotateZ(Math.PI / 2);
  const parts: Part[] = [{ material: TRIM, geometry: tire }];
  if (!plain) {
    const hub = new THREE.CylinderGeometry(radius * 0.55, radius * 0.55, width + 0.02, 8);
    hub.rotateZ(Math.PI / 2);
    parts.push({ material: HUB, geometry: hub });
  }
  return mergeByMaterial(parts);
}

export interface PaintSpec {
  id: string;
  paint: number;
  accent?: number;
}

const materialSets = new Map<string, THREE.Material[]>(); // shared per vehicle

/** One material per slot. Cached, so swapping vehicles doesn't dispose them. */
export function vehicleMaterials(spec: PaintSpec): THREE.Material[] {
  let set = materialSets.get(spec.id);
  if (!set) {
    set = [
      new THREE.MeshLambertMaterial({ color: spec.paint }),
      new THREE.MeshLambertMaterial({ color: 0x24313d, emissive: 0x3a5872, emissiveIntensity: 0.35 }),
      new THREE.MeshLambertMaterial({ color: 0x1d1f22 }),
      new THREE.MeshBasicMaterial({ color: 0xfff3b0 }),
      new THREE.MeshBasicMaterial({ color: 0xc81d25 }),
      new THREE.MeshLambertMaterial({ color: spec.accent ?? 0xf1f1ec }),
      new THREE.MeshLambertMaterial({ color: 0xb9bec4 }),
    ];
    materialSets.set(spec.id, set);
  }
  return set;
}
