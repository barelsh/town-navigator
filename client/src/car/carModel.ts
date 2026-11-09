import * as THREE from 'three';

// Sedan dimensions, in meters
const CAR_LENGTH = 4.5, CAR_WIDTH = 1.8, CAR_HEIGHT = 1.45;
export const WHEEL_RADIUS = 0.33;

export interface CarModel {
  group: THREE.Group;
  wheels: THREE.Mesh[];
}

export function createCarModel(): CarModel {
  const group = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(CAR_WIDTH, 0.65, CAR_LENGTH), new THREE.MeshLambertMaterial({ color: 0xd62828 }));
  body.position.y = 0.575;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, CAR_HEIGHT - 0.9, 2.3), new THREE.MeshLambertMaterial({ color: 0xf1faee }));
  cabin.position.set(0, (CAR_HEIGHT + 0.9) / 2, -0.3);
  group.add(body, cabin);

  const wheelGeometry = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.22, 14);
  wheelGeometry.rotateZ(Math.PI / 2);
  const wheelMaterial = new THREE.MeshLambertMaterial({ color: 0x1b1b1b });
  const wheels: THREE.Mesh[] = [];
  for (const [x, z] of [[-0.79, 1.45], [0.79, 1.45], [-0.79, -1.45], [0.79, -1.45]]) {
    const wheel = new THREE.Mesh(wheelGeometry, wheelMaterial);
    wheel.position.set(x, WHEEL_RADIUS, z);
    group.add(wheel);
    wheels.push(wheel);
  }

  // Headlights
  for (const x of [-0.6, 0.6]) {
    const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.05), new THREE.MeshBasicMaterial({ color: 0xfff3b0 }));
    headlight.position.set(x, 0.7, CAR_LENGTH / 2);
    group.add(headlight);
  }

  group.traverse(object => {
    if (object instanceof THREE.Mesh) object.castShadow = true;
  });

  return { group, wheels };
}
