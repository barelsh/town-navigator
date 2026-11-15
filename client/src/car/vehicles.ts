import * as THREE from 'three';
import {
  ACCENT, GLASS, LIGHT, PAINT, TAIL, TRIM,
  createKit, mergeByMaterial, vehicleMaterials, wheelGeometry, type Kit,
} from './vehicleKit.ts';

/** [x, z] of each wheel center. */
type WheelSpot = [number, number];

/** A circle along the vehicle's center line: [offset forward, radius], in meters. */
export type CollisionCircle = [along: number, radius: number];

export interface VehicleSpec {
  id: string;
  name: string;
  blurb: string;
  length: number;
  width: number;
  height: number;
  wheelRadius: number;
  wheelWidth?: number;
  paint: number;
  accent?: number;
  /** Replaces the circles worked out from the size. */
  collision?: CollisionCircle[];
  /** A tire without a hub, as on the original car. */
  plainWheels?: boolean;
  /** Adds the body to the kit and returns where the wheels go. */
  build(this: VehicleSpec, kit: Kit): WheelSpot[];
}

const axles = (spec: VehicleSpec, zs: number[]): WheelSpot[] => {
  const x = spec.width / 2 - (spec.wheelWidth ?? 0.22) / 2 + 0.03;
  return zs.flatMap((z): WheelSpot[] => [[-x, z], [x, z]]);
};

function sedanBody(k: Kit): void {
  k.profile(PAINT, [[-2.3, 0.28], [2.3, 0.28], [2.3, 0.6], [2.12, 0.78], [0.85, 0.88], [-1.4, 0.9], [-2.2, 0.86], [-2.3, 0.7]], 1.8);
  k.profile(GLASS, [[-1.42, 0.86], [0.86, 0.86], [0.12, 1.38], [-0.95, 1.38]], 1.56);
  k.profile(PAINT, [[-1.0, 1.36], [0.17, 1.36], [0.12, 1.45], [-0.95, 1.45]], 1.6);
  k.lights([-0.6, 0.6], 2.3, -2.3, 0.66);
}

export const VEHICLES: VehicleSpec[] = [
  {
    id: 'classic', name: 'Classic', blurb: 'The original box car', length: 4.5, width: 1.8, height: 1.45,
    wheelRadius: 0.33, paint: 0xd62828, accent: 0xf1faee, collision: [[0, 1.1]], plainWheels: true,
    build(k) {
      k.box(PAINT, 1.8, 0.65, 4.5, 0, 0.575, 0);
      k.box(ACCENT, 1.55, 0.55, 2.3, 0, 1.175, -0.3);
      for (const x of [-0.6, 0.6]) k.box(LIGHT, 0.4, 0.2, 0.05, x, 0.7, 2.25);
      return [[-0.79, 1.45], [0.79, 1.45], [-0.79, -1.45], [0.79, -1.45]];
    },
  },
  {
    id: 'sedan', name: 'Sedan', blurb: 'Family four-door', length: 4.6, width: 1.8, height: 1.45,
    wheelRadius: 0.33, paint: 0xc8202a,
    build(k) { sedanBody(k); return axles(this, [1.4, -1.4]); },
  },
  {
    id: 'hatchback', name: 'Hatchback', blurb: 'Small city car', length: 4.0, width: 1.75, height: 1.48,
    wheelRadius: 0.31, paint: 0x2f6fb5,
    build(k) {
      k.profile(PAINT, [[-2.0, 0.28], [2.0, 0.28], [2.0, 0.6], [1.85, 0.76], [0.75, 0.86], [-1.95, 0.9], [-2.0, 0.75]], 1.75);
      k.profile(GLASS, [[-1.95, 0.88], [0.76, 0.86], [0.0, 1.4], [-1.85, 1.4]], 1.52);
      k.profile(PAINT, [[-1.9, 1.38], [0.05, 1.38], [0.0, 1.48], [-1.85, 1.48]], 1.56);
      k.lights([-0.58, 0.58], 2.0, -2.0, 0.68);
      return axles(this, [1.25, -1.25]);
    },
  },
  {
    id: 'beetle', name: 'Beetle', blurb: 'Round and cheerful', length: 4.1, width: 1.6, height: 1.5,
    wheelRadius: 0.33, wheelWidth: 0.2, paint: 0x7cc3c8,
    build(k) {
      k.profile(PAINT, [[-2.0, 0.3], [2.0, 0.3], [2.08, 0.42], [2.05, 0.58], [1.9, 0.72], [1.6, 0.83], [1.2, 0.9],
        [-1.4, 0.95], [-1.8, 0.88], [-2.02, 0.72], [-2.08, 0.52], [-2.05, 0.38]], 1.42);
      const dome = (scale: number, from: number, to: number, steps: number): [number, number][] =>
        Array.from({ length: steps + 1 }, (_, i) => {
          const a = from + (to - from) * i / steps;
          return [-0.25 + Math.cos(a) * 1.3 * scale, 0.9 + Math.sin(a) * 0.62 * scale];
        });
      k.profile(GLASS, dome(1, 0, Math.PI, 12), 1.36);
      k.profile(PAINT, [...dome(1.04, 0.3 * Math.PI, 0.7 * Math.PI, 6), ...dome(0.96, 0.7 * Math.PI, 0.3 * Math.PI, 6)], 1.4);
      for (const z of [1.3, -1.3]) for (const x of [-0.72, 0.72]) k.fender(PAINT, 0.45, 0.32, x, 0.36, z);
      for (const x of [-0.72, 0.72]) {
        k.box(LIGHT, 0.2, 0.2, 0.05, x, 0.7, 1.72);
        k.box(TAIL, 0.14, 0.2, 0.05, x, 0.72, -1.72);
      }
      return [[-0.72, 1.3], [0.72, 1.3], [-0.72, -1.3], [0.72, -1.3]];
    },
  },
  {
    id: 'sports', name: 'Sports car', blurb: 'Low, wide, loud', length: 4.4, width: 1.9, height: 1.2,
    wheelRadius: 0.34, wheelWidth: 0.26, paint: 0xf08a0c,
    build(k) {
      k.profile(PAINT, [[-2.2, 0.25], [2.2, 0.25], [2.25, 0.42], [2.05, 0.6], [0.6, 0.8], [-1.7, 0.86], [-2.2, 0.8], [-2.25, 0.5]], 1.9);
      k.profile(GLASS, [[-1.5, 0.82], [0.62, 0.79], [-0.25, 1.17], [-0.95, 1.17]], 1.5);
      k.profile(PAINT, [[-1.0, 1.15], [-0.2, 1.15], [-0.25, 1.2], [-0.95, 1.2]], 1.52);
      k.box(TRIM, 1.7, 0.05, 0.28, 0, 1.02, -2.05);
      for (const x of [-0.6, 0.6]) k.box(TRIM, 0.06, 0.14, 0.1, x, 0.93, -2.05);
      k.lights([-0.65, 0.65], 2.2, -2.22, 0.5, [0.42, 0.1]);
      return axles(this, [1.35, -1.35]);
    },
  },
  {
    id: 'suv', name: 'SUV', blurb: 'Tall and boxy', length: 4.7, width: 1.9, height: 1.8,
    wheelRadius: 0.4, wheelWidth: 0.26, paint: 0x3f5d44,
    build(k) {
      k.profile(PAINT, [[-2.35, 0.42], [2.35, 0.42], [2.38, 0.95], [2.2, 1.08], [1.25, 1.12], [-2.35, 1.14]], 1.9);
      k.profile(GLASS, [[-2.3, 1.12], [1.27, 1.1], [0.45, 1.66], [-2.3, 1.66]], 1.7);
      k.profile(PAINT, [[-2.33, 1.64], [0.5, 1.64], [0.45, 1.74], [-2.33, 1.74]], 1.74);
      for (const x of [-0.75, 0.75]) k.box(TRIM, 0.05, 0.06, 2.4, x, 1.79, -0.9);
      for (const z of [2.42, -2.42]) k.box(TRIM, 1.9, 0.18, 0.12, 0, 0.5, z);
      k.disc(TRIM, 0.36, 0.22, 0, 0.95, -2.5);
      k.lights([-0.65, 0.65], 2.36, -2.36, 0.88);
      return axles(this, [1.45, -1.45]);
    },
  },
  {
    id: 'taxi', name: 'Taxi', blurb: 'Sedan with a roof sign', length: 4.6, width: 1.8, height: 1.62,
    wheelRadius: 0.33, paint: 0xf2c218,
    build(k) {
      sedanBody(k);
      k.box(ACCENT, 0.6, 0.16, 0.24, 0, 1.53, -0.4);
      return axles(this, [1.4, -1.4]);
    },
  },
  {
    id: 'pickup', name: 'Pickup', blurb: 'Cab and open bed', length: 5.3, width: 1.9, height: 1.8,
    wheelRadius: 0.4, wheelWidth: 0.26, paint: 0x2d5fb5,
    build(k) {
      k.profile(PAINT, [[-2.65, 0.45], [2.65, 0.45], [2.68, 0.95], [2.5, 1.08], [1.45, 1.12], [-0.4, 1.12], [-0.4, 0.8], [-2.65, 0.8]], 1.9);
      k.box(TRIM, 1.74, 0.02, 2.15, 0, 0.81, -1.53);
      for (const x of [-0.91, 0.91]) k.box(PAINT, 0.08, 0.32, 2.25, x, 0.96, -1.53);
      k.box(PAINT, 1.9, 0.32, 0.08, 0, 0.96, -2.61);
      k.profile(GLASS, [[-0.42, 1.1], [1.47, 1.1], [0.7, 1.7], [-0.42, 1.7]], 1.7);
      k.profile(PAINT, [[-0.44, 1.68], [0.75, 1.68], [0.7, 1.78], [-0.44, 1.78]], 1.74);
      k.lights([-0.68, 0.68], 2.66, -2.66, 0.86);
      return axles(this, [1.7, -1.6]);
    },
  },
  {
    id: 'truck', name: 'Truck', blurb: 'Box truck for deliveries', length: 7.2, width: 2.4, height: 3.4,
    wheelRadius: 0.5, wheelWidth: 0.3, paint: 0xeef0ee, accent: 0xc9cfd6,
    build(k) {
      k.box(TRIM, 1.0, 0.35, 6.9, 0, 0.7, -0.1);
      k.profile(PAINT, [[1.55, 0.6], [3.6, 0.6], [3.6, 1.3], [3.45, 2.5], [3.2, 2.75], [1.55, 2.75]], 2.35);
      k.box(GLASS, 2.1, 1.0, 0.04, 0, 1.95, 3.55, -0.12);
      for (const x of [-1.18, 1.18]) k.box(GLASS, 0.04, 0.7, 1.0, x, 2.1, 2.85);
      k.box(ACCENT, 2.45, 2.6, 5.0, 0, 2.1, -1.1);
      k.box(TRIM, 2.4, 0.3, 0.15, 0, 0.7, 3.62);
      for (const x of [-0.85, 0.85]) {
        k.box(LIGHT, 0.36, 0.2, 0.05, x, 0.98, 3.62);
        k.box(TAIL, 0.3, 0.2, 0.05, x, 1.0, -3.62);
      }
      return axles(this, [2.6, -2.5]);
    },
  },
  {
    id: 'bus', name: 'Bus', blurb: 'Twelve-meter city bus', length: 12, width: 2.55, height: 3.3,
    wheelRadius: 0.5, wheelWidth: 0.3, paint: 0x2f8a4e, accent: 0xf3f3ef,
    build(k) {
      k.box(PAINT, 2.55, 1.1, 12, 0, 0.95, 0);
      k.box(ACCENT, 2.55, 1.6, 12, 0, 2.3, 0);
      k.box(TRIM, 1.6, 0.25, 3, 0, 3.22, 0);
      for (const x of [-1.29, 1.29]) k.box(GLASS, 0.04, 1.05, 10.2, x, 2.15, -0.4);
      k.box(GLASS, 0.05, 2.1, 1.1, -1.29, 1.5, 5.2); // front door, on the right
      k.box(GLASS, 2.35, 1.8, 0.04, 0, 1.95, 6.01);
      k.box(GLASS, 2.1, 0.9, 0.04, 0, 2.4, -6.01);
      k.box(LIGHT, 1.9, 0.3, 0.04, 0, 2.95, 6.03);
      k.lights([-0.95, 0.95], 6.0, -6.0, 0.8, [0.34, 0.2]);
      return axles(this, [3.6, -3.2]);
    },
  },
];

export const DEFAULT_VEHICLE = 'sedan';

/** The vehicle with this id, or the default when it is unknown. */
export const vehicleById = (id: string): VehicleSpec =>
  VEHICLES.find(v => v.id === id) ?? VEHICLES.find(v => v.id === DEFAULT_VEHICLE)!;

/** Circles along the vehicle's length that must stay clear of buildings. */
export function collisionCircles(spec: VehicleSpec): CollisionCircle[] {
  if (spec.collision) return spec.collision;
  const radius = spec.width / 2 + 0.1;
  const count = Math.max(1, Math.round(spec.length / spec.width));
  const reach = Math.max(0, spec.length / 2 - radius);
  return Array.from({ length: count }, (_, i): CollisionCircle =>
    [count === 1 ? 0 : -reach + 2 * reach * i / (count - 1), radius]);
}

export interface ChaseOffset {
  distance: number; // meters behind
  height: number;   // meters above
  pivotHeight: number; // meters above the car that the camera slides toward when a wall is in the way
}

/** Chase camera framing, so long and tall vehicles stay in view. Today's values for a 4.5 m, 1.45 m car. */
export function chaseOffset(spec: VehicleSpec): ChaseOffset {
  return {
    distance: 10 + Math.max(0, spec.length - 4.5) * 0.6,
    height: 5 + Math.max(0, spec.height - 1.45),
    pivotHeight: spec.height + 0.15,
  };
}

export interface BuiltVehicle {
  group: THREE.Group;
  wheels: THREE.Mesh[];
  triangles: number;
}

export function buildVehicle(spec: VehicleSpec): BuiltVehicle {
  const kit = createKit();
  const wheelSpots = spec.build(kit);
  const body = new THREE.Mesh(mergeByMaterial(kit.parts), vehicleMaterials(spec));
  const group = new THREE.Group();
  group.add(body);
  const tire = wheelGeometry(spec.wheelRadius, spec.wheelWidth ?? 0.22, spec.plainWheels);
  const wheels = wheelSpots.map(([x, z]) => {
    const wheel = new THREE.Mesh(tire, vehicleMaterials(spec));
    wheel.position.set(x, spec.wheelRadius, z);
    group.add(wheel);
    return wheel;
  });
  group.traverse(object => {
    if (object instanceof THREE.Mesh) object.castShadow = true;
  });
  const triangles = (body.geometry.attributes.position.count + tire.attributes.position.count * wheels.length) / 3;
  return { group, wheels, triangles };
}
