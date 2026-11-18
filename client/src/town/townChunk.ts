import * as THREE from 'three';
import type { BuildingFeature, TownFeature } from '@town-navigator/shared';
import { createApartmentFacadeKit, type ApartmentFacadeKit } from './apartmentFacade.ts';
import { addBuildings, type Appearance } from './buildings.ts';
import type { Obstacle } from './collision.ts';
import { addRoads, createRoadKit, type RoadKit, type StreetSegment } from './roads.ts';
import { createSchoolFacadeKit, type SchoolFacadeKit } from './schoolFacade.ts';
import { createLabelKit, type LabelKit } from './streetLabels.ts';

/** Textures and materials that every chunk reuses. Built once. */
export interface TownKit {
  renderer: THREE.WebGLRenderer;
  apartments: ApartmentFacadeKit;
  schools: SchoolFacadeKit;
  roads: RoadKit;   // surface material per color, center line material
  labels: LabelKit; // label material per street name, shared plane
}

/** A set of features built into one group, with the data the game reads from it. Can be disposed. */
export interface TownChunk {
  group: THREE.Group;
  obstacles: Obstacle[];
  segments: StreetSegment[];
  pickTargets: Map<THREE.Object3D, BuildingFeature>;
  occluders: THREE.Mesh[]; // building meshes, for camera collision
  tallestBuilding: number;
  setAppearance(appearance: Appearance): void;
  updateLabels(heading: number): void;
  /** Removes the group from its parent and frees the chunk's geometries. Safe to call twice. */
  dispose(): void;
}

export function createTownKit(renderer: THREE.WebGLRenderer): TownKit {
  return {
    renderer,
    apartments: createApartmentFacadeKit(),
    schools: createSchoolFacadeKit(),
    roads: createRoadKit(),
    labels: createLabelKit(renderer),
  };
}

export function buildChunk(kit: TownKit, features: TownFeature[], appearance: Appearance): TownChunk {
  const group = new THREE.Group();
  const buildings = addBuildings(group, features, kit, appearance);
  const roads = addRoads(group, features, kit);
  let disposed = false;
  return {
    group,
    obstacles: buildings.obstacles,
    segments: roads.segments,
    pickTargets: buildings.pickTargets,
    occluders: [...buildings.pickTargets.keys()].filter(object => object instanceof THREE.Mesh),
    tallestBuilding: buildings.tallestBuilding,
    setAppearance: buildings.setAppearance,
    updateLabels: heading => roads.labels.update(heading),
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      buildings.dispose();
      roads.dispose();
    },
  };
}
