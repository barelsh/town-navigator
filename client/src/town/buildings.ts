import * as THREE from 'three';
import type { Position } from 'geojson';
import type { BuildingFeature, Town, TownFeature } from '@town-navigator/shared';
import { buildingGroup, buildingHeight, buildingIcon, GROUP_COLORS, ROOF_SHADE, UNKNOWN_SHADES } from './buildingStyles.ts';
import type { Obstacle } from './collision.ts';
import type { Point2 } from './geometry.ts';

const ICON_SIZE = 10;       // meters
const ICON_CLEARANCE = 2;   // meters above the roof
const ICON_CANVAS = 128;    // pixels

type BuildingMaterials = [roof: THREE.MeshLambertMaterial, wall: THREE.MeshLambertMaterial];

const buildingMaterials = new Map<number, BuildingMaterials>(); // shared per color
const iconMaterials = new Map<string, THREE.SpriteMaterial>();  // shared per icon

function materialsFor(color: THREE.Color): BuildingMaterials {
  const key = color.getHex();
  let materials = buildingMaterials.get(key);
  if (!materials) {
    materials = [
      new THREE.MeshLambertMaterial({ color: color.clone().multiplyScalar(ROOF_SHADE) }),
      new THREE.MeshLambertMaterial({ color }),
    ];
    buildingMaterials.set(key, materials);
  }
  return materials;
}

function iconMaterial(icon: string): THREE.SpriteMaterial {
  let material = iconMaterials.get(icon);
  if (!material) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = ICON_CANVAS;
    const context = canvas.getContext('2d')!;
    const center = ICON_CANVAS / 2;
    context.beginPath();
    context.arc(center, center, center - 4, 0, Math.PI * 2);
    context.fillStyle = '#fff';
    context.fill();
    context.lineWidth = 6;
    context.strokeStyle = '#141820';
    context.stroke();
    context.font = `${ICON_CANVAS * 0.56}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#141820'; // for icons that have no color glyph
    context.fillText(icon, center, center + ICON_CANVAS * 0.03);

    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    material = new THREE.SpriteMaterial({ map });
    iconMaterials.set(icon, material);
  }
  return material;
}

function addBuildingIcon(scene: THREE.Scene, icon: string, x: number, z: number, roofHeight: number): THREE.Sprite {
  const sprite = new THREE.Sprite(iconMaterial(icon));
  sprite.scale.setScalar(ICON_SIZE);
  sprite.position.set(x, roofHeight + ICON_CLEARANCE + ICON_SIZE / 2, z);
  scene.add(sprite);
  return sprite;
}

// GeoJSON rings repeat their first point at the end; shapes don't need it.
const ringPoints = (ring: Position[]) => ring.slice(0, -1).map(([x, y]) => new THREE.Vector2(x, y));

const isBuilding = (feature: TownFeature): feature is BuildingFeature =>
  Boolean(feature.properties.building) && feature.geometry.type === 'Polygon';

export interface Buildings {
  obstacles: Obstacle[];
  tallestBuilding: number;
  pickTargets: Map<THREE.Object3D, BuildingFeature>;
}

export function addBuildings(scene: THREE.Scene, town: Town): Buildings {
  // Deterministic random so the town looks the same on every reload
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const obstacles: Obstacle[] = [];
  let tallestBuilding = 0;
  const pickTargets = new Map<THREE.Object3D, BuildingFeature>();

  for (const feature of town.features.filter(isBuilding)) {
    const [outer, ...holes] = feature.geometry.coordinates;
    const height = buildingHeight(feature.properties);
    const shape = new THREE.Shape(ringPoints(outer));
    shape.holes = holes.map(hole => new THREE.Path(ringPoints(hole)));

    // Extrusion runs along +z; rotating it upright also maps y to -z.
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geometry.rotateX(-Math.PI / 2);

    const group = buildingGroup(feature.properties);
    const shade = group === 'unknown' ? UNKNOWN_SHADES[Math.floor(rand() * UNKNOWN_SHADES.length)] : 1;
    const color = new THREE.Color(GROUP_COLORS[group]).multiplyScalar(shade);
    const mesh = new THREE.Mesh(geometry, materialsFor(color));
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    pickTargets.set(mesh, feature);

    const ring = outer.slice(0, -1).map(([x, y]): Point2 => [x, -y]);
    const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
    const bounds = {
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minZ: Math.min(...zs), maxZ: Math.max(...zs),
    };
    obstacles.push({ ring, ...bounds });
    tallestBuilding = Math.max(tallestBuilding, height);

    const icon = buildingIcon(feature.properties);
    if (icon) {
      const sprite = addBuildingIcon(scene, icon, (bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2, height);
      pickTargets.set(sprite, feature);
    }
  }

  return { obstacles, tallestBuilding, pickTargets };
}
