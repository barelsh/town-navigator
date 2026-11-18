import * as THREE from 'three';
import type { Position } from 'geojson';
import type { BuildingFeature, TownFeature } from '@town-navigator/shared';
import { MIN_FACADE_FLOORS, type ApartmentFacadeKit } from './apartmentFacade.ts';
import { floorCount, hashId } from './facadeKit.ts';
import { createHouseGeometry, houseMaterials, houseFloors } from './houseModel.ts';
import type { SchoolFacadeKit } from './schoolFacade.ts';
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

function addBuildingIcon(parent: THREE.Object3D, icon: string, x: number, z: number, roofHeight: number): THREE.Sprite {
  const sprite = new THREE.Sprite(iconMaterial(icon));
  sprite.scale.setScalar(ICON_SIZE);
  sprite.position.set(x, roofHeight + ICON_CLEARANCE + ICON_SIZE / 2, z);
  parent.add(sprite);
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
  /** Removes the buildings from their parent and frees their geometries. Kit materials and textures stay. */
  dispose(): void;
}

/** Adds the buildings among the features to the parent, in the given appearance. */
export function addBuildings(
  parent: THREE.Object3D,
  features: TownFeature[],
  kit: { apartments: ApartmentFacadeKit; schools: SchoolFacadeKit },
  appearance: Appearance,
): Buildings {
  const obstacles: Obstacle[] = [];
  let tallestBuilding = 0;
  const pickTargets = new Map<THREE.Object3D, BuildingFeature>();
  const facades = kit.apartments.begin();
  const schools = kit.schools.begin();
  const realisticParts = new THREE.Group(); // every facade part, hidden as one in the plain view
  parent.add(realisticParts);
  const swaps: AppearanceSwap[] = [];
  const geometries = new Set<THREE.BufferGeometry>(); // everything this call created, for dispose
  const objects: THREE.Object3D[] = [];
  let facadeMeshes: THREE.InstancedMesh[] = [];

  for (const feature of features.filter(isBuilding)) {
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
    geometries.add(plainGeometry).add(geometry);

    const featureId = String(feature.id ?? feature.properties['@id'] ?? '');
    const group = buildingGroup(feature.properties);
    // From the id alone, so a building keeps its shade whatever order buildings load in.
    const shade = group === 'unknown' ? UNKNOWN_SHADES[hashId(featureId) % UNKNOWN_SHADES.length] : 1;
    const color = new THREE.Color(GROUP_COLORS[group]).multiplyScalar(shade);
    const [roof, wall] = materialsFor(color);
    const floors = floorCount(feature.properties, height);
    const hasFacade = feature.properties.building === 'apartments' && floors >= MIN_FACADE_FLOORS;
    const isSchool = feature.properties.building === 'school';
    const wallMaterial = isSchool ? kit.schools.wallMaterial : hasFacade ? kit.apartments.wallMaterial : wall;
    const realisticMaterial = house
      ? houseMaterials(featureId, houseFloorCount > 1 ? 'duplex' : 'house')
      : [roof, wallMaterial];
    const mesh = new THREE.Mesh(geometry, realisticMaterial);
    mesh.castShadow = mesh.receiveShadow = true;
    parent.add(mesh);
    objects.push(mesh);
    pickTargets.set(mesh, feature);
    if (house) {
      swaps.push({ mesh, plain: { geometry: plainGeometry, material: [roof, wall] }, realistic: { geometry, material: realisticMaterial } });
    } else {
      if (wallMaterial !== wall) {
        swaps.push({ mesh, plain: { geometry: plainGeometry, material: [roof, wall] }, realistic: { geometry, material: realisticMaterial } });
      }
    }

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
      const sprite = addBuildingIcon(parent, icon, (bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2, height);
      objects.push(sprite);
      pickTargets.set(sprite, feature);
    }
  }
  facadeMeshes = [...facades.finish(realisticParts).meshes, ...schools.finish(realisticParts).meshes];

  function setAppearance(appearance: Appearance): void {
    const realistic = appearance === 'realistic';
    realisticParts.visible = realistic;
    for (const { mesh, plain, realistic: model } of swaps) {
      const choice = realistic ? model : plain;
      mesh.geometry = choice.geometry;
      mesh.material = choice.material;
    }
  }

  setAppearance(appearance); // before the first frame

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    realisticParts.removeFromParent();
    for (const object of objects) object.removeFromParent();
    for (const mesh of facadeMeshes) mesh.dispose(); // the shared unit box and the materials stay
    for (const geometry of geometries) geometry.dispose(); // both sides of each appearance swap
    pickTargets.clear();
  }

  return { obstacles, tallestBuilding, pickTargets, setAppearance, dispose };
}
