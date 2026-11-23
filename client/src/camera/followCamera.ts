import * as THREE from 'three';
import type { ChaseOffset } from '../car/vehicles.ts';
import { createCameraCollision } from './cameraCollision.ts';

const CHASE = 0, TOP_DOWN = 1;
const CAMERA_MODES = 2;
const TOP_DOWN_CLEARANCE = 30; // meters above the tallest building
const TOP_DOWN_MIN_HEIGHT = 100; // meters; the top-down view never sits lower than this

export interface FollowCamera {
  update(dt: number, carPosition: THREE.Vector3, heading: number): void;
  /** Turns the camera-switch key on or off. */
  setInputEnabled(enabled: boolean): void;
  /** Sets how far behind and above the car the chase camera sits, for the current vehicle. */
  setChaseOffset(offset: ChaseOffset): void;
  /** Snaps to the car instead of gliding there. */
  jumpTo(carPosition: THREE.Vector3, heading: number): void;
  /** Raises the top-down height to clear a taller building. It never lowers, so the camera doesn't bob down. */
  setTallestBuilding(height: number): void;
}

export function createFollowCamera(
  camera: THREE.PerspectiveCamera,
  startPosition: THREE.Vector3,
  initialTallestBuilding: number,
  occluders: THREE.Object3D[]
): FollowCamera {
  let tallestBuilding = initialTallestBuilding;
  const topDownHeight = () => Math.max(tallestBuilding + TOP_DOWN_CLEARANCE, TOP_DOWN_MIN_HEIGHT);
  const collision = createCameraCollision(occluders);
  let mode = CHASE;
  let inputEnabled = true;
  let chase: ChaseOffset = { distance: 10, height: 5, pivotHeight: 1.6 }; // for a 4.5 m, 1.45 m car
  addEventListener('keydown', e => {
    if (inputEnabled && e.code === 'KeyC') mode = (mode + 1) % CAMERA_MODES;
  });

  const target = startPosition.clone();
  camera.position.set(startPosition.x - 10, 6, startPosition.z - 10);

  return {
    setInputEnabled(enabled) {
      inputEnabled = enabled;
    },
    setTallestBuilding(height) {
      tallestBuilding = Math.max(tallestBuilding, height);
    },
    setChaseOffset(offset) {
      chase = offset;
      collision.setPivotHeight(offset.pivotHeight);
    },
    jumpTo(carPosition, heading) {
      target.copy(carPosition).setY(1);
      if (mode === TOP_DOWN) {
        camera.position.set(carPosition.x, topDownHeight(), carPosition.z);
        camera.up.set(Math.sin(heading), 0, Math.cos(heading));
      } else {
        camera.position.set(
          carPosition.x - Math.sin(heading) * chase.distance, carPosition.y + chase.height,
          carPosition.z - Math.cos(heading) * chase.distance);
        camera.up.set(0, 1, 0);
      }
      camera.lookAt(target);
      collision.reset();
    },
    update(dt, carPosition, heading) {
      const offset = mode === TOP_DOWN
        ? new THREE.Vector3(0, topDownHeight(), 0)
        : new THREE.Vector3(-Math.sin(heading) * chase.distance, chase.height, -Math.cos(heading) * chase.distance);
      // Top-down, screen up follows the car, so the map turns around it.
      const up = mode === TOP_DOWN
        ? new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading))
        : new THREE.Vector3(0, 1, 0);
      camera.position.lerp(carPosition.clone().add(offset), 1 - Math.exp(-dt * 5));
      if (mode === CHASE) collision.apply(camera, carPosition, dt);
      else collision.reset();
      camera.up.lerp(up, 1 - Math.exp(-dt * 5)).normalize();
      target.lerp(carPosition.clone().setY(1), 1 - Math.exp(-dt * 8));
      camera.lookAt(target);
    },
  };
}
