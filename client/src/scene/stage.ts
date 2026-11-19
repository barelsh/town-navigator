import * as THREE from 'three';
import type { TownBounds } from '@town-navigator/shared';
import { addLawnPatches, GRASS_TILE, grassDetailTexture } from './grassTexture.ts';

const SKY_COLOR = 0x9fd3ff;
const SUN_OFFSET = new THREE.Vector3(100, 150, 62);
const GROUND_MARGIN = 600;

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Keeps the shadow area around the given position. */
  moveSunTo(position: THREE.Vector3): void;
}

export function createStage(): Stage {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SKY_COLOR);
  scene.fog = new THREE.Fog(SKY_COLOR, 120, 450);

  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 700);

  scene.add(new THREE.HemisphereLight(0xdff1ff, 0x5a7a3a, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 150, bottom: -150, near: 1, far: 400 });
  scene.add(sun, sun.target);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  return {
    renderer,
    scene,
    camera,
    moveSunTo(position) {
      sun.target.position.copy(position);
      sun.position.copy(position).add(SUN_OFFSET);
    },
  };
}

export function addGround(
  scene: THREE.Scene, renderer: THREE.WebGLRenderer, [minX, minY, maxX, maxY]: TownBounds
): void {
  const width = maxX - minX + GROUND_MARGIN, depth = maxY - minY + GROUND_MARGIN;
  const centerX = (minX + maxX) / 2, centerZ = -(minY + maxY) / 2;
  const map = grassDetailTexture(renderer.capabilities.getMaxAnisotropy());
  map.repeat.set(width / GRASS_TILE, depth / GRASS_TILE);
  const material = new THREE.MeshLambertMaterial({ map });
  addLawnPatches(material);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(centerX, 0, centerZ);
  ground.receiveShadow = true;
  scene.add(ground);
}
