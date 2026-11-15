import * as THREE from 'three';
import { DEFAULT_VEHICLE, buildVehicle, collisionCircles, vehicleById, type CollisionCircle, type VehicleSpec } from './vehicles.ts';

export interface CarModel {
  /** The outer group lives as long as the game; only what is inside it is swapped. */
  readonly group: THREE.Group;
  readonly spec: VehicleSpec;
  readonly wheels: THREE.Mesh[];
  readonly collision: CollisionCircle[];
  /** Replaces the vehicle in place. Unknown ids give the default. */
  setVehicle(id: string): void;
}

export function createCarModel(vehicleId: string = DEFAULT_VEHICLE): CarModel {
  const group = new THREE.Group();
  let spec = vehicleById(vehicleId);
  let wheels: THREE.Mesh[] = [];
  let collision: CollisionCircle[] = [];

  const model: CarModel = {
    group,
    get spec() { return spec; },
    get wheels() { return wheels; },
    get collision() { return collision; },
    setVehicle(id) {
      const next = vehicleById(id);
      const built = buildVehicle(next);
      for (const child of [...group.children]) {
        group.remove(child);
        if (child instanceof THREE.Mesh) child.geometry.dispose(); // materials are cached and shared
      }
      group.add(...built.group.children);
      spec = next;
      wheels = built.wheels;
      collision = collisionCircles(next);
    },
  };
  model.setVehicle(vehicleId);
  return model;
}
