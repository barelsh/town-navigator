import * as THREE from 'three';
import type { Position } from 'geojson';
import type { BuildingFeature, TownFeature } from '@town-navigator/shared';
import { MIN_FACADE_FLOORS, type ApartmentFacadeKit } from './apartmentFacade.ts';
import { floorCount, hashId } from './facadeKit.ts';
import { createBuildingBatch } from './buildingBatch.ts';
import type { BuildingMaterialKit } from './buildingMaterials.ts';
import { createHouseGeometry, houseColors, houseFloors } from './houseModel.ts';
import type { SchoolFacadeKit } from './schoolFacade.ts';
import { buildingGroup, buildingHeight, buildingIcon, GROUP_COLORS, ROOF_SHADE, UNKNOWN_SHADES } from './buildingStyles.ts';
import type { Obstacle } from './collision.ts';
import type { Point2 } from './geometry.ts';

const ICON_SIZE = 10;       // meters
const ICON_CLEARANCE = 2;   // meters above the roof
const ICON_CANVAS = 128;    // pixels

const iconMaterials = new Map<string, THREE.SpriteMaterial>();  // shared per icon
const PROXY_MATERIAL = new THREE.MeshBasicMaterial(); // never drawn: proxies are invisible and only raycast
const WHITE = new THREE.Color(1, 1, 1);

/** Roof and wall vertex colors of a plain block. */
function blockColors(color: THREE.Color): [roof: THREE.Color, wall: THREE.Color] {
  return [color.clone().multiplyScalar(ROOF_SHADE), color];
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

interface ProxySwap {
  proxy: THREE.Mesh;
  plain: THREE.BufferGeometry;
  realistic: THREE.BufferGeometry;
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
  kit: { apartments: ApartmentFacadeKit; schools: SchoolFacadeKit; buildings: BuildingMaterialKit },
  appearance: Appearance,
): Buildings {
  const obstacles: Obstacle[] = [];
  let tallestBuilding = 0;
  const pickTargets = new Map<THREE.Object3D, BuildingFeature>();
  const facades = kit.apartments.begin();
  const schools = kit.schools.begin();
  const realisticParts = new THREE.Group(); // every facade part, hidden as one in the plain view
  parent.add(realisticParts);
  const swaps: ProxySwap[] = [];
  // Merged meshes per material: always visible, realistic view only, plain view only.
  const shared = createBuildingBatch(), realisticBatch = createBuildingBatch(), plainBatch = createBuildingBatch();
  const realisticGroup = new THREE.Group(), plainGroup = new THREE.Group(), sharedGroup = new THREE.Group();
  parent.add(sharedGroup, realisticGroup, plainGroup);
  const mergedMeshes: THREE.Mesh[] = [];
  const mats = kit.buildings;
  const blockMaterials = [mats.blockRoof, mats.blockWall];
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
    const [roofColor, wallColor] = blockColors(color);
    const floors = floorCount(feature.properties, height);
    const hasFacade = feature.properties.building === 'apartments' && floors >= MIN_FACADE_FLOORS;
    const isSchool = feature.properties.building === 'school';
    const wallMaterial = isSchool ? kit.schools.wallMaterial : hasFacade ? kit.apartments.wallMaterial : null;
    if (house) {
      const c = houseColors(featureId, houseFloorCount > 1 ? 'duplex' : 'house');
      const windows = houseFloorCount > 1 ? mats.duplexWindows : mats.houseWindows;
      realisticBatch.add(geometry, [mats.houseRoof, windows, mats.housePlaster], [c.roof, c.wall, c.wall]);
      plainBatch.add(plainGeometry, blockMaterials, [roofColor, wallColor]);
    } else if (wallMaterial) {
      realisticBatch.add(plainGeometry, [mats.blockRoof, wallMaterial], [roofColor, WHITE]);
      plainBatch.add(plainGeometry, blockMaterials, [roofColor, wallColor]);
    } else {
      shared.add(plainGeometry, blockMaterials, [roofColor, wallColor]);
    }

    // Hidden stand-in for clicks and camera collision; three.js raycasts invisible meshes.
    const mesh = new THREE.Mesh(wallMaterial || house ? geometry : plainGeometry, PROXY_MATERIAL);
    mesh.visible = false;
    parent.add(mesh);
    objects.push(mesh);
    pickTargets.set(mesh, feature);
    if (house || wallMaterial) swaps.push({ proxy: mesh, plain: plainGeometry, realistic: geometry });

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
  mergedMeshes.push(...shared.finish(sharedGroup), ...realisticBatch.finish(realisticGroup), ...plainBatch.finish(plainGroup));
  facadeMeshes = [...facades.finish(realisticParts).meshes, ...schools.finish(realisticParts).meshes];

  function setAppearance(appearance: Appearance): void {
    const realistic = appearance === 'realistic';
    realisticParts.visible = realisticGroup.visible = realistic;
    plainGroup.visible = !realistic;
    for (const { proxy, plain, realistic: model } of swaps) proxy.geometry = realistic ? model : plain;
  }

  setAppearance(appearance); // before the first frame

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    realisticParts.removeFromParent();
    for (const group of [sharedGroup, realisticGroup, plainGroup]) group.removeFromParent();
    for (const mesh of mergedMeshes) mesh.geometry.dispose();
    for (const object of objects) object.removeFromParent();
    for (const mesh of facadeMeshes) mesh.dispose(); // the shared unit box and the materials stay
    for (const geometry of geometries) geometry.dispose(); // both sides of each appearance swap
    pickTargets.clear();
  }

  return { obstacles, tallestBuilding, pickTargets, setAppearance, dispose };
}
