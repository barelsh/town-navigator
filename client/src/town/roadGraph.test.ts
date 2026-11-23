import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Junction, JunctionBranch } from '@town-navigator/shared';
import { createRoadGraph, toWorldJunctions, type Zone } from './roadGraph.ts';
import type { StreetSegment } from './roads.ts';

// Fixtures: polylines copied from rosh_haayin around E 21.5, N -95.8, relative to that point,
// [x east, y north] in meters. o: 1 = oneway=yes.
interface Road { name?: string; highway: string; oneway?: boolean; coords: [number, number][] }

const MOSHE_DAYAN: Road = { name: 'משה דיין', highway: 'tertiary', coords: [[-75, 228], [-66, 207], [-50, 169], [-40, 144], [-39, 140], [-37, 128], [-39, 98], [-40, 88], [-40, 83], [-45, 63], [-49, 55]] };
const SERVICE_NORTH: Road = { highway: 'service', coords: [[-5, -7], [0, 0], [9, 15], [12, 22], [14, 26], [17, 35], [19, 47], [20, 57], [20, 71], [19, 84], [17, 100], [14, 116], [11, 125], [7, 133], [-5, 150], [-17, 164], [-26, 166]] };
const JABOTINSKY_EAST: Road = { name: "ז'בוטינסקי", highway: 'tertiary', oneway: true, coords: [[-54, 33], [-45, 26], [-22, 7], [-16, 2], [-9, -4], [-5, -7], [-2, -9], [4, -14], [11, -20], [18, -25], [22, -28], [24, -30], [31, -35], [38, -40], [44, -44], [106, -82], [131, -98]] };
const JABOTINSKY_WEST: Road = { name: "ז'בוטינסקי", highway: 'tertiary', oneway: true, coords: [[138, -89], [113, -73], [63, -45], [48, -36], [31, -26], [0, 0], [-17, 15], [-38, 31], [-41, 36], [-42, 41]] };
const SERVICE_LOOP: Road = { highway: 'service', coords: [[-40, 88], [-29, 96], [-29, 122], [-30, 130], [-39, 140]] };
const SERVICE_T: Road = { highway: 'service', coords: [[12, 22], [19, 20], [23, 16], [25, -2]] };
const ROUNDABOUT: Road = { highway: 'tertiary', oneway: true, coords: [[-41, 44], [-41, 46], [-42, 48], [-42, 49], [-43, 51], [-44, 52], [-46, 53], [-47, 54], [-49, 55], [-50, 55], [-52, 55], [-54, 55], [-56, 55], [-57, 54], [-59, 53], [-60, 52], [-61, 51], [-62, 49], [-63, 48], [-63, 46], [-63, 44], [-63, 43], [-63, 41], [-62, 39], [-61, 38], [-60, 37], [-59, 35], [-57, 35], [-56, 34], [-54, 33], [-52, 33], [-50, 33], [-49, 34], [-47, 35], [-46, 35], [-44, 37], [-43, 38], [-42, 39], [-42, 41], [-41, 43], [-41, 44]] };
const JABOTINSKY_NW: Road = { name: "ז'בוטינסקי", highway: 'tertiary', coords: [[-63, 48], [-84, 61], [-102, 76], [-201, 174]] };

const AREA = [MOSHE_DAYAN, SERVICE_NORTH, JABOTINSKY_EAST, JABOTINSKY_WEST, SERVICE_LOOP, SERVICE_T, ROUNDABOUT, JABOTINSKY_NW];

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The tiler's coordinate-fallback junction logic (data/scripts/tile_town.js), on the fixture roads. */
function junctionsOf(roads: Road[]): Junction[] {
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
function segmentsOf(roads: Road[]): StreetSegment[] {
  return roads.flatMap(road => road.coords.slice(1).map(([bx, by], i) => {
    const [ax, ay] = road.coords[i];
    return { ax, az: -ay, bx, bz: -by, halfWidth: road.highway === 'service' ? 2 : 4, name: road.name, drivable: true };
  }));
}

function graphOf(roads: Road[]) {
  return createRoadGraph(segmentsOf(roads), toWorldJunctions(junctionsOf(roads)));
}

/** The zone holding the member at [x east, y north]. */
function zoneWith(zones: Zone[], [x, y]: [number, number]): Zone {
  const zone = zones.find(z => z.members.some(m => m.x === x && m.z === -y));
  assert.ok(zone, `no zone has a member at ${x}, ${y}`);
  return zone;
}

test('a road cut at a tile edge is one continuous road', () => {
  // Cut the roundabout ring between two members, as the tiler does at a grid line: both pieces end at the same point.
  const cut = 15; // [-56, 55], between members [-49, 55] and [-63, 48]
  const pieces: Road[] = [
    { ...ROUNDABOUT, coords: ROUNDABOUT.coords.slice(0, cut) },
    { ...ROUNDABOUT, coords: ROUNDABOUT.coords.slice(cut - 1) },
  ];
  const roads = [...AREA.filter(r => r !== ROUNDABOUT), ...pieces];
  // The tiler builds junctions over the whole town, before cutting, so they come from the uncut roads.
  const graph = createRoadGraph(segmentsOf(roads), toWorldJunctions(junctionsOf(AREA)));
  const [x, y] = ROUNDABOUT.coords[cut - 1];
  const here = graph.at(x, -y);
  assert.equal(here.length, 2);
  assert.notEqual(here[0][0], here[1][0]); // two different segments meet at the cut
  // Tracing goes through the cut, so the ring between members stays internal.
  assert.equal(zoneWith(graph.zones, [-49, 55]).exits.length, 4);
});

test('roundabout junctions merge into one zone with 4 exits', () => {
  const zone = zoneWith(graphOf(AREA).zones, [-54, 33]);
  assert.equal(zone.members.length, 4);
  assert.ok(Math.abs(zone.x - -52) < 2 && Math.abs(zone.z - -44) < 2, `center ${zone.x}, ${zone.z}`);
  assert.ok(Math.abs(zone.radius - 19) < 1.5, `radius ${zone.radius}`);
  assert.equal(zone.exits.length, 4);
  assert.equal(zone.kind, 'junction');
});

test('dual-carriageway crossing merges into one zone with 5 exits', () => {
  const zone = zoneWith(graphOf(AREA).zones, [0, 0]);
  assert.deepEqual(zone.members.map(m => [m.x, -m.z]).sort(), [[-5, -7], [0, 0]].sort());
  assert.equal(zone.exits.length, 5);
});

test('a T-junction 25 m away stays its own zone', () => {
  const zones = graphOf(AREA).zones;
  const t = zoneWith(zones, [12, 22]);
  assert.equal(t.members.length, 1);
  assert.notEqual(t, zoneWith(zones, [0, 0]));
  assert.equal(t.exits.length, 3);
});

test('dead ends never merge', () => {
  // A stub ending 3 m from the T-junction's node, well inside merge distance.
  const stub: Road = { highway: 'service', coords: [[14, 26], [16, 28]] };
  const zones = graphOf([...AREA, stub]).zones;
  const deadEnds = zones.filter(z => z.members.some(m => m.kind === 'dead_end'));
  assert.ok(deadEnds.length >= 4);
  for (const zone of deadEnds) {
    assert.equal(zone.members.length, 1);
    assert.equal(zone.kind, 'dead_end');
  }
  assert.equal(zoneWith(zones, [16, 28]).kind, 'dead_end');
});

test('one-way-in branches are kept but marked flow "in"', () => {
  const zone = zoneWith(graphOf(AREA).zones, [0, 0]);
  const arriving = zone.exits.filter(e => e.flow === 'in');
  assert.equal(arriving.length, 2); // one per Jabotinsky carriageway
  assert.equal(zone.exits.filter(e => e.flow === 'out').length, 2);
  assert.equal(zone.exits.filter(e => e.flow === 'both').length, 1); // the service road north
  for (const exit of arriving) assert.equal(exit.name, "ז'בוטינסקי");
});

test('zonesAt finds a zone by its circle, grown by extra meters', () => {
  const graph = graphOf(AREA);
  const zone = zoneWith(graph.zones, [12, 22]);
  assert.ok(graph.zonesAt(zone.x, zone.z).includes(zone));
  assert.ok(!graph.zonesAt(zone.x + zone.radius + 1, zone.z).includes(zone));
  assert.ok(graph.zonesAt(zone.x + zone.radius + 1, zone.z, 2).includes(zone));
});
