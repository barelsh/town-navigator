import * as THREE from 'three';

const CHASE = 0, TOP_DOWN = 1;
const CAMERA_MODES = 2;
const TOP_DOWN_CLEARANCE = 30; // meters above the tallest building

export interface FollowCamera {
  update(dt: number, carPosition: THREE.Vector3, heading: number): void;
}

export function createFollowCamera(
  camera: THREE.PerspectiveCamera,
  startPosition: THREE.Vector3,
  tallestBuilding: number
): FollowCamera {
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
        : new THREE.Vector3(-Math.sin(heading) * 10, 5, -Math.cos(heading) * 10);
      // Top-down, screen up follows the car, so the map turns around it.
      const up = mode === TOP_DOWN
        ? new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading))
        : new THREE.Vector3(0, 1, 0);
      camera.position.lerp(carPosition.clone().add(offset), 1 - Math.exp(-dt * 5));
      camera.up.lerp(up, 1 - Math.exp(-dt * 5)).normalize();
      target.lerp(carPosition.clone().setY(1), 1 - Math.exp(-dt * 8));
      camera.lookAt(target);
    },
  };
}
