import * as THREE from 'three';

const PIVOT_HEIGHT = 1.6;      // meters above the car: the camera slides toward this point
const WALL_CLEARANCE = 0.7;    // meters kept in front of a wall; covers the 0.5 m near plane
const SIDE_RAY_OFFSET = 0.6;   // meters to each side, for walls beside the line
const RETURN_SPEED = 4;        // meters per second back out to the usual distance

export interface CameraCollision {
  /** Moves the camera toward the car when a building is in the way. */
  apply(camera: THREE.Camera, carPosition: THREE.Vector3, dt: number): void;
  /** Forgets any pull-in, e.g. while in top-down view. */
  reset(): void;
}

export function createCameraCollision(occluders: THREE.Object3D[]): CameraCollision {
  const raycaster = new THREE.Raycaster();
  const pivot = new THREE.Vector3(), direction = new THREE.Vector3();
  const side = new THREE.Vector3(), origin = new THREE.Vector3();
  let reach = Infinity;

  return {
    apply(camera, carPosition, dt) {
      pivot.copy(carPosition).setY(carPosition.y + PIVOT_HEIGHT);
      direction.subVectors(camera.position, pivot);
      const length = direction.length();
      if (length < 1e-3) return;
      direction.divideScalar(length);
      side.set(-direction.z, 0, direction.x).normalize().multiplyScalar(SIDE_RAY_OFFSET);

      let clear = length;
      for (const offset of [0, 1, -1]) {
        origin.copy(pivot).addScaledVector(side, offset);
        raycaster.set(origin, direction);
        raycaster.far = length + WALL_CLEARANCE;
        const hit = raycaster.intersectObjects(occluders, false)[0];
        if (hit) clear = Math.min(clear, hit.distance - WALL_CLEARANCE);
      }
      clear = Math.max(clear, 0);

      // In at once, out gradually.
      reach = clear < reach ? clear : Math.min(clear, reach + RETURN_SPEED * dt);
      if (length > reach) camera.position.copy(pivot).addScaledVector(direction, reach);
    },
    reset() {
      reach = Infinity;
    },
  };
}
