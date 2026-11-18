import * as THREE from 'three';
import { createPartMaterials, createPartStore, hashId, signedArea, wallsOf, windOutward, type FacadeBuilder, type PartDefinition, type Wall } from './facadeKit.ts';
import { pointInRing, type Point2 } from './geometry.ts';
import { blockStoneTexture, ribbonTexture, trioTexture } from './schoolTextures.ts';

type Finish = 'stone' | 'render' | 'green' | 'charcoal';
type PartName = Finish | 'ribbon' | 'trio';

interface Section { start: number; length: number; finish: Finish; }

const FINISH_CYCLE: Finish[] = ['stone', 'render', 'stone', 'green'];
const SECTION_TARGET = 17, MIN_SPLIT_WALL = 26, MAX_RECESS = 20; // meters
const SIDE_MARGIN = 0.9, MIN_WINDOW_RUN = 2.4, MIN_TRIO_RUN = 4.5, RIBBON_PITCH = 7.6, TRIO_PITCH = 6.2; // meters
const MIN_ROOF_UNIT_AREA = 300; // square meters
const ROOF_UNIT = { length: 4, height: 2.2, depth: 3 }; // meters
const STONE_LIFT = 0.45;

export interface SchoolFacadeKit {
  /** Wall material for the extruded mass of a school. */
  wallMaterial: THREE.MeshLambertMaterial;
  /** Starts the school parts of one chunk. */
  begin(): FacadeBuilder;
}

export function createSchoolFacadeKit(): SchoolFacadeKit {
  const stone = blockStoneTexture();
  const wallMaterial = new THREE.MeshLambertMaterial({
    map: stone, emissive: 0xfffaf0, emissiveMap: stone, emissiveIntensity: STONE_LIFT,
  });
  const definitions: Record<PartName, PartDefinition> = {
    stone:    { color: 0xf0ebdf, shadow: true, lift: STONE_LIFT },
    render:   { color: 0xdcdedb, shadow: true, lift: 0.34 },
    green:    { color: 0x1f8a45, lift: 0.14 },
    charcoal: { color: 0x565c60, lift: 0.14 },
    ribbon:   { map: ribbonTexture(), lift: 0.3 },
    trio:     { map: trioTexture(), lift: 0.3 },
  };
  const partMaterials = createPartMaterials(definitions);

  return {
    wallMaterial,

    begin() {
    const { place, finish } = createPartStore(partMaterials);

    // A wall with an inside corner at both ends is a recess. Other walls split into sections of about 17 m.
    function sectionsOf(w: Wall, recessed: boolean, order: { next: number }): Section[] {
      if (recessed && w.length <= MAX_RECESS) return [{ start: 0, length: w.length, finish: 'charcoal' }];
      const count = w.length < MIN_SPLIT_WALL ? 1 : Math.round(w.length / SECTION_TARGET);
      const length = w.length / count;
      return Array.from({ length: count }, (_, i) => ({
        start: i * length,
        length,
        finish: FINISH_CYCLE[order.next++ % FINISH_CYCLE.length],
      }));
    }

    function addWindows(w: Wall, s: Section, floorY: number, floorHeight: number): void {
      const run = s.length - SIDE_MARGIN * 2;
      const isGreen = s.finish === 'green';
      if (run < (isGreen ? MIN_TRIO_RUN : MIN_WINDOW_RUN)) return;

      const count = Math.max(1, Math.round(run / (isGreen ? TRIO_PITCH : RIBBON_PITCH)));
      const pitch = run / count;
      const bandHeight = floorHeight * 0.45;
      const y = floorY + floorHeight * 0.3 + bandHeight / 2;
      for (let i = 0; i < count; i++) {
        const along = s.start + SIDE_MARGIN + (i + 0.5) * pitch;
        place(isGreen ? 'trio' : 'ribbon', w, along, y, 0.06, isGreen ? pitch * 0.94 : pitch, bandHeight, 0.04);
      }
    }

    // Up to two pale boxes along the longest wall, skipped when a corner would overhang.
    function addRoofUnits(ring: Point2[], walls: Wall[], height: number): void {
      if (Math.abs(signedArea(ring)) < MIN_ROOF_UNIT_AREA) return;
      const longest = walls.reduce((best, w) => (w.length > best.length ? w : best), walls[0]);
      const cx = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
      const cz = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
      const { length, height: unitHeight, depth } = ROOF_UNIT;
      for (const share of [-0.22, 0.22]) {
        const offset = longest.length * share;
        const x = cx + longest.ux * offset, z = cz + longest.uz * offset;
        const fits = [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([a, b]) => pointInRing(
          x + longest.ux * a * length / 2 + longest.nx * b * depth / 2,
          z + longest.uz * a * length / 2 + longest.nz * b * depth / 2, ring));
        if (!fits) continue;
        place('render', { ...longest, ax: x, az: z }, 0, height + unitHeight / 2, 0, length, unitHeight, depth);
      }
    }

    return {
      add(id, footprint, height, floors) {
        const ring = windOutward(footprint);
        const walls = wallsOf(ring);
        const floorHeight = height / floors;
        const order = { next: hashId(id) % FINISH_CYCLE.length };
        const isConcave = (a: Wall, b: Wall) => a.ux * b.uz - a.uz * b.ux > 0;

        walls.forEach((w, i) => {
          const previous = walls[(i + walls.length - 1) % walls.length], next = walls[(i + 1) % walls.length];
          const recessed = isConcave(previous, w) && isConcave(w, next);
          for (const section of sectionsOf(w, recessed, order)) {
            if (section.finish !== 'stone') {
              place(section.finish, w, section.start + section.length / 2, height / 2, 0.02, section.length, height, 0.04);
            }
            for (let floor = 0; floor < floors; floor++) addWindows(w, section, floor * floorHeight, floorHeight);
          }
          place('stone', w, w.length / 2, 0.35, 0.05, w.length + 0.1, 0.7, 0.1);          // plinth
          place('stone', w, w.length / 2, height + 0.05, 0.05, w.length + 0.2, 0.3, 0.2); // cap
        });
        addRoofUnits(ring, walls, height);
      },

      finish,
    };
    },
  };
}
