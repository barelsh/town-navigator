import * as THREE from 'three';
import { createCameraCollision } from './cameraCollision.ts';

const CHASE = 0, TOP_DOWN = 1;
const CAMERA_MODES = 2;
const TOP_DOWN_CLEARANCE = 30; // meters above the tallest building
const CHASE_DISTANCE = 10;     // meters behind the car
const CHASE_HEIGHT = 5;        // meters above the car

export interface FollowCamera {
  update(dt: number, carPosition: THREE.Vector3, heading: number): void;
}

export function createFollowCamera(
  camera: THREE.PerspectiveCamera,
  startPosition: THREE.Vector3,
  tallestBuilding: number,
  occluders: THREE.Object3D[]
): FollowCamera {
  const collision = createCameraCollision(occluders);
  let mode = CHASE;
  addEventListener('keydown', e => {
    if (e.code === 'KeyC') mode = (mode + 1) % CAMERA_MODES;
  });

  const target = startPosition.clone();
  camera.position.set(startPosition.x - 10, 6, startPosition.z - 10);

  return {
    update(dt, carPosition, heading) {
      const offset = mode === TOP_DOWN
        ? new THREE.Vector3(0, tallestBuilding + TOP_DOWN_CLEARANCE, 0)
        : new THREE.Vector3(-Math.sin(heading) * CHASE_DISTANCE, CHASE_HEIGHT, -Math.cos(heading) * CHASE_DISTANCE);
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
