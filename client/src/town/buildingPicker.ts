import * as THREE from 'three';
import type { BuildingFeature } from '@town-navigator/shared';

const FOG_END = 450; // nothing past the fog is visible, so it can't be clicked

export interface BuildingHit {
  feature: BuildingFeature;
  point: THREE.Vector3;
}

export interface BuildingPicker {
  /** Returns the nearest building or icon at a screen position, if any. */
  pick(clientX: number, clientY: number, canvas: HTMLCanvasElement): BuildingHit | null;
}

export function createBuildingPicker(
  camera: THREE.PerspectiveCamera,
  targets: Map<THREE.Object3D, BuildingFeature> // read on every pick, since tiles come and go
): BuildingPicker {
  const raycaster = new THREE.Raycaster();
  raycaster.far = FOG_END;
  const pointer = new THREE.Vector2();

  return {
    pick(clientX, clientY, canvas) {
      const rect = canvas.getBoundingClientRect();
      pointer.set(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1
      );
      raycaster.setFromCamera(pointer, camera); // also sets the camera sprites need
      const hit = raycaster.intersectObjects([...targets.keys()], false)[0];
      return hit ? { feature: targets.get(hit.object)!, point: hit.point.clone() } : null;
    },
  };
}
