import * as THREE from 'three';
import { createPartStore, hashId, wallsOf, windOutward, type FacadeStats, type PartDefinition, type Wall } from './facadeKit.ts';
import { bayTexture, louvreTexture, punchedTexture, stoneTexture, woodTexture } from './facadeTextures.ts';
import { pointInRing, type Point2 } from './geometry.ts';

export const MIN_FACADE_FLOORS = 2;

const MODULE_WIDTH = 3.6, END_MARGIN = 0.5, MIN_WALL = 2.8; // meters
const BALCONY_LENGTH = 3.6, BALCONY_DEPTH = 1.4, RAIL_HEIGHT = 1.05, MIN_BALCONY_WALL = 4.5; // meters
const MAX_BALCONIES = 2;

// The game's lights are dim on vertical walls, so pale stone and panels get a small emissive lift.
const STONE_LIFT = 0.5, PANEL_LIFT = 0.28;

type Module = 'bay' | 'wood' | 'punched' | 'louvre';
type PartName = 'stone' | Module | 'railing';

const MODULE_MIN_PITCH: Record<Module, number> = { bay: 3, wood: 3.4, punched: 1.5, louvre: 1.5 };
const PATTERNS: Module[][] = [
  ['bay', 'punched', 'wood'],
  ['wood', 'punched', 'bay'],
  ['bay', 'wood', 'punched'],
];

interface Slot { module: Module; along: number; }

export interface ApartmentFacades {
  /** Wall material for the extruded mass of a building with a facade. */
  wallMaterial: THREE.MeshLambertMaterial;
  /** Adds facade parts for one building. `footprint` is its outer ring in world [x, z], without the repeated last point. */
  add(id: string, footprint: Point2[], height: number, floors: number): void;
  /** Adds one instanced mesh per part type to the scene. */
  finish(parent: THREE.Object3D): FacadeStats;
}

// Symmetric from both ends, like the photo. The same plan repeats on every floor.
function planWall(length: number, isLongest: boolean, hash: number): Slot[] {
  if (length < MIN_WALL) return [];
  const usable = length - END_MARGIN * 2;
  const count = Math.max(1, Math.floor(usable / MODULE_WIDTH));
  const pitch = usable / count;
  const pattern = PATTERNS[hash % PATTERNS.length];

  return Array.from({ length: count }, (_, i) => {
    let module = pattern[Math.min(i, count - 1 - i) % pattern.length];
    if (isLongest && count >= 3 && i === count >> 1) module = 'louvre';
    if (pitch < MODULE_MIN_PITCH[module]) module = 'punched';
    return { module, along: END_MARGIN + (i + 0.5) * pitch };
  });
}

export function createApartmentFacades(): ApartmentFacades {
  const stone = stoneTexture();
  const wallMaterial = new THREE.MeshLambertMaterial({
    map: stone, emissive: 0xfff6ea, emissiveMap: stone, emissiveIntensity: STONE_LIFT,
  });
  const definitions: Record<PartName, PartDefinition> = {
    stone:   { color: 0xf0e8d8, shadow: true, lift: STONE_LIFT },
    bay:     { map: bayTexture(), lift: PANEL_LIFT },
    punched: { map: punchedTexture(), lift: PANEL_LIFT },
    wood:    { map: woodTexture(), lift: PANEL_LIFT },
    louvre:  { map: louvreTexture(), lift: PANEL_LIFT },
    railing: { color: 0xd6edf3, opacity: 0.2 },
  };
  const { place, finish } = createPartStore(definitions);

  // Each takes the wall, the slot's center along it, the floor's base height and the floor height.
  const MODULES: Record<Module, (w: Wall, along: number, y: number, h: number) => void> = {
    bay(w, s, y, h) {
      const width = 2.4;
      place('bay', w, s, y + h / 2, 0.02, width, h, 0.04);
      place('stone', w, s, y + h - 0.12, 0.18, width + 0.3, 0.24, 0.36);
    },
    punched(w, s, y, h) {
      const bottom = y + h * 0.34, top = y + h * 0.85;
      place('punched', w, s, (bottom + top) / 2, 0.02, 1.15, top - bottom, 0.04);
    },
    wood(w, s, y, h) {
      const bottom = y + h * 0.34, top = y + h * 0.82;
      place('wood', w, s, (bottom + top) / 2, 0.02, 3.1, top - bottom, 0.04);
    },
    louvre(w, s, y, h) {
      place('louvre', w, s, y + h / 2, 0.05, 1.1, h, 0.1);
    },
  };

  function addBalcony(w: Wall, fromEnd: boolean, y: number): void {
    const along = fromEnd ? w.length - BALCONY_LENGTH / 2 : BALCONY_LENGTH / 2;
    const out = BALCONY_DEPTH / 2;
    place('stone', w, along, y, out, BALCONY_LENGTH, 0.22, BALCONY_DEPTH);
    place('railing', w, along, y + 0.11 + RAIL_HEIGHT / 2, BALCONY_DEPTH - 0.02, BALCONY_LENGTH, RAIL_HEIGHT, 0.03);
    const cap = fromEnd ? w.length - 0.02 : 0.02;
    place('railing', w, cap, y + 0.11 + RAIL_HEIGHT / 2, out, 0.03, RAIL_HEIGHT, BALCONY_DEPTH);
  }

  // Balconies sit at the end of a wall, on a convex corner, where they don't reach back over the building.
  function chooseBalconies(walls: Wall[], ring: Point2[]): number[] {
    const candidates: { index: number; score: number }[] = [];
    walls.forEach((w, i) => {
      const next = walls[(i + 1) % walls.length];
      const convex = w.ux * next.uz - w.uz * next.ux < 0;
      if (!convex || w.length < MIN_BALCONY_WALL || next.length < MIN_BALCONY_WALL) return;
      const startAlong = w.length - BALCONY_LENGTH;
      const clear = [startAlong, w.length].every(a =>
        !pointInRing(w.ax + w.ux * a + w.nx * BALCONY_DEPTH, w.az + w.uz * a + w.nz * BALCONY_DEPTH, ring));
      if (clear) candidates.push({ index: i, score: w.length + next.length });
    });
    candidates.sort((a, b) => b.score - a.score);

    const chosen: typeof candidates = [];
    for (const c of candidates) {
      if (chosen.length === MAX_BALCONIES) break;
      const adjacent = chosen.some(o =>
        Math.abs(o.index - c.index) <= 1 || Math.abs(o.index - c.index) === walls.length - 1);
      if (!adjacent) chosen.push(c);
    }
    return chosen.map(c => c.index);
  }

  return {
    wallMaterial,

    add(id, footprint, height, floors) {
      const ring = windOutward(footprint);
      const hash = hashId(id);
      const walls = wallsOf(ring);
      const longest = walls.reduce((best, w) => (w.length > best.length ? w : best), walls[0]);
      const floorHeight = height / floors;
      const hasPodium = floors >= 3;
      const balconies = chooseBalconies(walls, ring);

      walls.forEach((w, wallIndex) => {
        const hasBalcony = balconies.includes(wallIndex);
        // Windows stay clear of the stretch of wall behind a balcony.
        const slots = planWall(w.length, w === longest, hash + wallIndex)
          .filter(s => !hasBalcony || s.along < w.length - BALCONY_LENGTH - 0.6);
        for (let floor = hasPodium ? 1 : 0; floor < floors; floor++) {
          const y = floor * floorHeight;
          for (const { module, along } of slots) MODULES[module](w, along, y, floorHeight);
          if (hasBalcony && floor >= 1) addBalcony(w, true, y);
        }
        if (hasPodium) place('stone', w, w.length / 2, floorHeight - 0.175, 0.13, w.length + 0.26, 0.35, 0.26);
        place('stone', w, w.length / 2, height + 0.2, -0.15, w.length + 0.3, 0.4, 0.3);
        if (w.length >= 1.5) place('railing', w, w.length / 2, height + 0.4 + 0.5, -0.15, w.length, 1, 0.03);
      });
    },

    finish,
  };
}
