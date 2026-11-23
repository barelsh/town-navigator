import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREA, ROUNDABOUT, SERVICE_T, graphOf, junctionsOf, segmentsOf, type Road } from './roadFixtures.ts';
import { createRoadGraph, toWorldJunctions, type Zone } from './roadGraph.ts';

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

test('every exit knows the segment where it leaves the zone', () => {
  const graph = graphOf(AREA);
  for (const corner of [[-54, 33], [0, 0], [12, 22]] as [number, number][]) { // roundabout, crossing, T-junction
    const zone = zoneWith(graph.zones, corner);
    for (const exit of zone.exits) {
      assert.ok(exit.segment !== undefined && exit.dir !== undefined && exit.edgePoint, 'exit data is missing');
      const { x, z } = exit.edgePoint;
      // On the zone circle, and on its segment.
      assert.ok(Math.abs(Math.hypot(x - zone.x, z - zone.z) - zone.radius) < 1e-6, 'not on the circle');
      const onSegment = graph.nearestOnSegment(exit.segment, x, z);
      assert.ok(Math.hypot(onSegment.x - x, onSegment.z - z) < 1e-6, 'not on the segment');
      // Running along `dir` leads away from the zone's center.
      const s = graph.segments[exit.segment];
      assert.ok(((s.bx - s.ax) * exit.dir) * (x - zone.x) + ((s.bz - s.az) * exit.dir) * (z - zone.z) > 0, 'dir points into the zone');
    }
  }
});

test('nearestOnSegment gives the closest point and its distance from a, clamped to the segment', () => {
  const graph = graphOf([{ highway: 'tertiary', coords: [[0, 0], [0, 100]] }]); // z from 0 down to -100
  const mid = graph.nearestOnSegment(0, 5, -30);
  assert.ok(Math.abs(mid.x) < 1e-9 && Math.abs(mid.z + 30) < 1e-9 && Math.abs(mid.t - 30) < 1e-9);
  assert.equal(graph.nearestOnSegment(0, 3, 40).t, 0);
  assert.equal(graph.nearestOnSegment(0, 3, -500).t, 100);
});
