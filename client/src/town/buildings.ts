import * as THREE from 'three';
import type { Position } from 'geojson';
import type { BuildingFeature, Town, TownFeature } from '@town-navigator/shared';
import { createApartmentFacades, MIN_FACADE_FLOORS } from './apartmentFacade.ts';
import { floorCount } from './facadeKit.ts';
import { createHouseGeometry, houseMaterials, houseFloors } from './houseModel.ts';
import { createSchoolFacades } from './schoolFacade.ts';
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

export type Appearance = 'realistic' | 'plain';

interface AppearanceSwap {
  mesh: THREE.Mesh;
  plain: { geometry: THREE.BufferGeometry; material: THREE.Material[] };
  realistic: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] };
}

export interface Buildings {
  obstacles: Obstacle[];
  tallestBuilding: number;
  pickTargets: Map<THREE.Object3D, BuildingFeature>;
  /** Switches every realistic model to flat colored blocks, or back, without rebuilding anything. */
  setAppearance(appearance: Appearance): void;
}

export function addBuildings(scene: THREE.Scene, town: Town): Buildings {
  // Deterministic random so the town looks the same on every reload
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const obstacles: Obstacle[] = [];
  let tallestBuilding = 0;
  const pickTargets = new Map<THREE.Object3D, BuildingFeature>();
  const facades = createApartmentFacades();
  const schools = createSchoolFacades();
  const realisticParts = new THREE.Group(); // every facade part, hidden as one in the plain view
  scene.add(realisticParts);
  const swaps: AppearanceSwap[] = [];

  for (const feature of town.features.filter(isBuilding)) {
    const [outer, ...holes] = feature.geometry.coordinates;
    const height = buildingHeight(feature.properties);
    const ring = outer.slice(0, -1).map(([x, y]): Point2 => [x, -y]);
    const houseFloorCount = houseFloors(feature);
    const house = houseFloorCount !== null;
    const shape = new THREE.Shape(ringPoints(outer));
    shape.holes = holes.map(hole => new THREE.Path(ringPoints(hole)));

    // Extrusion runs along +z; rotating it upright also maps y to -z.
    const plainGeometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    plainGeometry.rotateX(-Math.PI / 2);
    const geometry = house ? createHouseGeometry(ring, height, houseFloorCount) : plainGeometry;

    const group = buildingGroup(feature.properties);
    const shade = group === 'unknown' ? UNKNOWN_SHADES[Math.floor(rand() * UNKNOWN_SHADES.length)] : 1;
    const color = new THREE.Color(GROUP_COLORS[group]).multiplyScalar(shade);
    const [roof, wall] = materialsFor(color);
    const floors = floorCount(feature.properties, height);
    const hasFacade = feature.properties.building === 'apartments' && floors >= MIN_FACADE_FLOORS;
    const isSchool = feature.properties.building === 'school';
    const wallMaterial = isSchool ? schools.wallMaterial : hasFacade ? facades.wallMaterial : wall;
    const realisticMaterial = house
      ? houseMaterials(String(feature.id ?? feature.properties['@id'] ?? ''), houseFloorCount > 1 ? 'duplex' : 'house')
      : [roof, wallMaterial];
    const mesh = new THREE.Mesh(geometry, realisticMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
    pickTargets.set(mesh, feature);
    if (house) {
      swaps.push({ mesh, plain: { geometry: plainGeometry, material: [roof, wall] }, realistic: { geometry, material: realisticMaterial } });
    } else {
      if (wallMaterial !== wall) {
        swaps.push({ mesh, plain: { geometry: plainGeometry, material: [roof, wall] }, realistic: { geometry, material: realisticMaterial } });
      }
    }

    const featureId = String(feature.id ?? feature.properties['@id'] ?? '');
    if (hasFacade) facades.add(featureId, ring, height, floors);
    if (isSchool) schools.add(featureId, ring, height, floors);
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
  facades.finish(realisticParts);
  schools.finish(realisticParts);

  function setAppearance(appearance: Appearance): void {
    const realistic = appearance === 'realistic';
    realisticParts.visible = realistic;
    for (const { mesh, plain, realistic: model } of swaps) {
      const choice = realistic ? model : plain;
      mesh.geometry = choice.geometry;
      mesh.material = choice.material;
    }
  }

  return { obstacles, tallestBuilding, pickTargets, setAppearance };
}
