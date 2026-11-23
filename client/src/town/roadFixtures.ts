// Test fixtures shared by the road graph and road lock tests: polylines copied from rosh_haayin around
// E 21.5, N -95.8, relative to that point, [x east, y north] in meters, plus the tiler's junction logic.

import type { Junction, JunctionBranch } from '@town-navigator/shared';
import { createRoadGraph, toWorldJunctions, type RoadGraph } from './roadGraph.ts';
import type { StreetSegment } from './roads.ts';

/** oneway: traffic runs along the coordinates (oneway=yes). */
export interface Road { name?: string; highway: string; oneway?: boolean; coords: [number, number][] }

export const MOSHE_DAYAN: Road = { name: 'משה דיין', highway: 'tertiary', coords: [[-75, 228], [-66, 207], [-50, 169], [-40, 144], [-39, 140], [-37, 128], [-39, 98], [-40, 88], [-40, 83], [-45, 63], [-49, 55]] };
export const SERVICE_NORTH: Road = { highway: 'service', coords: [[-5, -7], [0, 0], [9, 15], [12, 22], [14, 26], [17, 35], [19, 47], [20, 57], [20, 71], [19, 84], [17, 100], [14, 116], [11, 125], [7, 133], [-5, 150], [-17, 164], [-26, 166]] };
export const JABOTINSKY_EAST: Road = { name: "ז'בוטינסקי", highway: 'tertiary', oneway: true, coords: [[-54, 33], [-45, 26], [-22, 7], [-16, 2], [-9, -4], [-5, -7], [-2, -9], [4, -14], [11, -20], [18, -25], [22, -28], [24, -30], [31, -35], [38, -40], [44, -44], [106, -82], [131, -98]] };
export const JABOTINSKY_WEST: Road = { name: "ז'בוטינסקי", highway: 'tertiary', oneway: true, coords: [[138, -89], [113, -73], [63, -45], [48, -36], [31, -26], [0, 0], [-17, 15], [-38, 31], [-41, 36], [-42, 41]] };
export const SERVICE_LOOP: Road = { highway: 'service', coords: [[-40, 88], [-29, 96], [-29, 122], [-30, 130], [-39, 140]] };
export const SERVICE_T: Road = { highway: 'service', coords: [[12, 22], [19, 20], [23, 16], [25, -2]] };
export const ROUNDABOUT: Road = { highway: 'tertiary', oneway: true, coords: [[-41, 44], [-41, 46], [-42, 48], [-42, 49], [-43, 51], [-44, 52], [-46, 53], [-47, 54], [-49, 55], [-50, 55], [-52, 55], [-54, 55], [-56, 55], [-57, 54], [-59, 53], [-60, 52], [-61, 51], [-62, 49], [-63, 48], [-63, 46], [-63, 44], [-63, 43], [-63, 41], [-62, 39], [-61, 38], [-60, 37], [-59, 35], [-57, 35], [-56, 34], [-54, 33], [-52, 33], [-50, 33], [-49, 34], [-47, 35], [-46, 35], [-44, 37], [-43, 38], [-42, 39], [-42, 41], [-41, 43], [-41, 44]] };
export const JABOTINSKY_NW: Road = { name: "ז'בוטינסקי", highway: 'tertiary', coords: [[-63, 48], [-84, 61], [-102, 76], [-201, 174]] };
export const SERVICE_EAST: Road = { highway: 'service', coords: [[63, -45], [60, -37], [60, -31], [61, -26], [64, -18], [65, -11], [65, -4], [65, -1], [60, 61], [42, 60], [46, -1], [48, -23]] };
export const SERVICE_CROSS: Road = { highway: 'service', coords: [[46, -1], [65, -1]] };

export const AREA = [MOSHE_DAYAN, SERVICE_NORTH, JABOTINSKY_EAST, JABOTINSKY_WEST, SERVICE_LOOP, SERVICE_T, ROUNDABOUT, JABOTINSKY_NW, SERVICE_EAST, SERVICE_CROSS];

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The tiler's coordinate-fallback junction logic (data/scripts/tile_town.js), on the fixture roads. */
export function junctionsOf(roads: Road[]): Junction[] {
  const nodes = new Map<string, { x: number; y: number; degree: number; branches: JunctionBranch[] }>();
  for (const road of roads) {
    const c = road.coords;
    c.forEach((pos, i) => {
      const k = `${pos[0]},${pos[1]}`;
      const node = nodes.get(k) ?? { x: pos[0], y: pos[1], degree: 0, branches: [] };
      node.degree += i === 0 || i === c.length - 1 ? 1 : 2;
      for (const [j, along] of [[i + 1, true], [i - 1, false]] as const) {
        if (j < 0 || j >= c.length) continue;
        const dx = c[j][0] - pos[0], dy = c[j][1] - pos[1], len = Math.hypot(dx, dy);
        if (len === 0) continue;
        const flow = road.oneway ? (along ? 'out' : 'in') : 'both';
        node.branches.push({ dx: r3(dx / len), dy: r3(dy / len), highway: road.highway, flow, ...(road.name ? { name: road.name } : {}) });
      }
      nodes.set(k, node);
    });
  }
  return [...nodes.values()]
    .filter(n => n.degree === 1 || n.degree >= 3)
    .map(n => ({ id: null, x: n.x, y: n.y, kind: n.degree === 1 ? 'dead_end' : 'junction', branches: n.branches }));
}

/** StreetSegments as roads.ts makes them: z = -y, one per point pair. */
export function segmentsOf(roads: Road[]): StreetSegment[] {
  return roads.flatMap(road => road.coords.slice(1).map(([bx, by], i) => {
    const [ax, ay] = road.coords[i];
    return { ax, az: -ay, bx, bz: -by, halfWidth: road.highway === 'service' ? 2 : 4, name: road.name, drivable: true, oneway: road.oneway ? 1 : 0 };
  }));
}

export function graphOf(roads: Road[]): RoadGraph {
  return createRoadGraph(segmentsOf(roads), toWorldJunctions(junctionsOf(roads)));
}

