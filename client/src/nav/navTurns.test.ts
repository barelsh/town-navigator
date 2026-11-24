import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Maneuver, Route, RouteStretch } from '@town-navigator/shared';
import { exitLanePoint } from '../car/turnRoute.ts';
import { HEAD, LINE_LAYERS, RIM_GAP, RIM_HEAD } from '../hud/turnArrow.ts';
import { AREA, JABOTINSKY_NW, ROUNDABOUT, graphOf } from '../town/roadFixtures.ts';
import { lineSpans, matchManeuver, turnArrays, upcomingTurns, zoneOf, type NavTurn } from './navTurns.ts';
import { toWorldRoute } from './routeProgress.ts';

// A route on the fixture roads (rosh_haayin around E 21.5, N -95.8), [x east, y north]: south down Moshe Dayan past the
// service loop's two junctions, into the roundabout at (-49, 55), round its ring counterclockwise and out north-west
// on Jabotinsky at (-63, 48).
const COORDS: [number, number][] = [
  [-40, 144], [-39, 140], [-37, 128], [-39, 98], [-40, 88], [-40, 83], [-45, 63], [-49, 55], // 0..7 Moshe Dayan
  [-50, 55], [-52, 55], [-54, 55], [-56, 55], [-57, 54], [-59, 53], [-60, 52], [-61, 51], [-62, 49], [-63, 48], // 8..17 ring
  [-84, 61], [-102, 76], // 18..19 Jabotinsky NW
];
const STRETCHES: RouteStretch[] = [
  { start: 0, highway: 'tertiary', oneway: false, name: 'משה דיין' },
  { start: 7, highway: 'tertiary', oneway: true },
  { start: 17, highway: 'tertiary', oneway: false, name: "ז'בוטינסקי" },
];

const along = (at: number) => {
  let d = 0;
  for (let i = 1; i <= at; i++) d += Math.hypot(COORDS[i][0] - COORDS[i - 1][0], COORDS[i][1] - COORDS[i - 1][1]);
  return d;
};
const maneuver = (at: number, turn: Maneuver['turn'], extra: Partial<Maneuver> = {}): Maneuver => ({
  nodes: [1000 + at], x: COORDS[at][0], y: COORDS[at][1], along: along(at),
  inBearing: 0, outBearing: 0, angle: 0, turn, ...extra,
});

function routeOf(maneuvers: Maneuver[], coords = COORDS, stretches = STRETCHES) {
  const route: Route = {
    distance: along(coords.length - 1), points: coords, stretches,
    start: { x: coords[0][0], y: coords[0][1] }, destination: { x: coords.at(-1)![0], y: coords.at(-1)![1] }, maneuvers,
  };
  return toWorldRoute(route);
}

const STRAIGHT_AT_LOOP = maneuver(1, 'straight');                     // (-39, 140): straight on, nothing to say
const AMBIGUOUS_AT_LOOP = maneuver(4, 'straight', { ambiguous: true }); // (-40, 88): straight, but needs saying
const INTO_RING = maneuver(7, 'roundabout', { exit: 1 });
const OFF_RING = maneuver(17, 'slight_right');                          // the server's own maneuver, in the same client zone
const ALL = [STRAIGHT_AT_LOOP, AMBIGUOUS_AT_LOOP, INTO_RING, OFF_RING];

const graph = graphOf(AREA);
const ringPoint = (p: { x: number; z: number }) => Math.min(...ROUNDABOUT.coords.map(([x, y]) => Math.hypot(p.x - x, p.z + y)));

test('matchManeuver finds the zone by OSM node id, and by position when ids are missing', () => {
  const route = routeOf(ALL);
  // The fixture junctions have no ids: the zone around the maneuver's first node.
  const byPosition = matchManeuver(graph, route, 2)!;
  assert.ok(byPosition, 'matched by position');
  assert.ok(byPosition.zone.members.some(m => m.x === -49 && m.z === -55));
  // Give one ring member an id, and point the maneuver at it from far away: the id wins over the position.
  const idGraph = graphOf(AREA);
  const ring = zoneOf(idGraph, route.maneuvers[2])!;
  const member = ring.members.find(m => m.x === -63 && m.z === -48)!;
  member.id = 77;
  const moved = routeOf([{ ...INTO_RING, nodes: [77], x: 500, y: 500 }]);
  assert.equal(zoneOf(idGraph, moved.maneuvers[0]), ring);
  // No id and nothing there: no zone.
  assert.equal(zoneOf(graph, routeOf([{ ...INTO_RING, nodes: [5], x: 500, y: 500 }]).maneuvers[0]), null);
});

test('roundabout maneuver: exit is the one whose heading matches the polyline leaving the ring', () => {
  const route = routeOf(ALL);
  const turn = matchManeuver(graph, route, 2)!;
  // The route leaves the ring along Jabotinsky north-west, from the member at (-63, 48).
  assert.equal(turn.exit.from.x, -63);
  assert.equal(turn.exit.from.z, -48);
  const out = exitLanePoint(graph, turn.exit);
  const [ax, ay] = JABOTINSKY_NW.coords[0], [bx, by] = JABOTINSKY_NW.coords[1];
  const roadHeading = Math.atan2(bx - ax, -(by - ay));
  assert.ok(Math.abs(Math.atan2(Math.sin(out.heading - roadHeading), Math.cos(out.heading - roadHeading))) < 0.1);
  // The arrow starts at the zone's edge in the lane and runs round the ring, not across the island.
  const entry = turn.path[0];
  assert.ok(Math.abs(Math.hypot(entry.x - turn.zone.x, entry.z - turn.zone.z) - turn.zone.radius) < 2.5, 'starts at the edge');
  const middle = turn.path.slice(3, -3);
  assert.ok(middle.every(p => ringPoint(p) < 4 || Math.hypot(p.x - turn.zone.x, p.z - turn.zone.z) > 8), 'follows the ring');
  // It ends 2.6 m past the exit's lane point, and goes away once the car has left the circle.
  const tail = turn.path.at(-1)!;
  assert.ok(Math.abs(Math.hypot(tail.x - out.x, tail.z - out.z) - 2.6) < 1e-6);
  assert.ok(turn.leaveAlong > route.maneuvers[3].along && turn.leaveAlong < route.cum[19]);
});

test('two maneuvers in one client zone become one turn', () => {
  const route = routeOf([INTO_RING, OFF_RING]);
  const turns = upcomingTurns(graph, route, 0);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].index, 0);
  assert.equal(turns[0].last, 1);
});

test('upcomingTurns returns the next 2 non-straight or ambiguous maneuvers ahead of along', () => {
  const route = routeOf(ALL);
  const cache = new Map<number, NavTurn | null>();
  const first = upcomingTurns(graph, route, 0, 2, cache);
  assert.deepEqual(first.map(t => [t.index, t.last]), [[1, 1], [2, 3]], 'the plain straight is skipped');
  assert.deepEqual(upcomingTurns(graph, route, 0, 1, cache).map(t => t.index), [1]);
  // Past the loop junction's circle, only the roundabout is left; past the ring, nothing.
  assert.deepEqual(upcomingTurns(graph, route, first[0].leaveAlong + 1, 2, cache).map(t => t.index), [2]);
  assert.deepEqual(upcomingTurns(graph, route, first[1].leaveAlong + 1, 2, cache), []);
  // The cache holds what was matched, so the same objects come back.
  assert.equal(upcomingTurns(graph, route, 0, 2, cache)[1], first[1]);
});

test('a maneuver with no loaded zone gets no arrow, and appears once its tile loads', () => {
  const route = routeOf([INTO_RING]);
  const before = graphOf(AREA.filter(r => r !== ROUNDABOUT && r !== JABOTINSKY_NW)); // the roundabout's tile isn't in
  assert.equal(matchManeuver(before, route, 0), null);
  assert.deepEqual(upcomingTurns(before, route, 0, 2, new Map()), []);
  assert.equal(upcomingTurns(graph, route, 0, 2, new Map()).length, 1); // a new graph, a new cache
});

test('the start U-turn, on a road and not at a junction, gets no arrow', () => {
  const route = routeOf([{ ...maneuver(0, 'uturn'), nodes: [] }, INTO_RING]);
  assert.equal(matchManeuver(graph, route, 0), null);
  assert.deepEqual(upcomingTurns(graph, route, 0).map(t => t.index), [1]);
});

test('the on-route zone builds a rim along the given path instead of the full cyan arrow', () => {
  const route = routeOf(ALL);
  const turns = upcomingTurns(graph, route, 0);
  const full = (n: number) => n * 2 * 3 + 6;   // three layers and the double head
  const rim = (n: number) => n * 4 + 6;         // one layer in two strips, and the head's frame
  const plain = turnArrays(turns, null, 0.2);
  assert.equal(plain.along.length, full(turns[0].path.length) + full(turns[1].path.length));
  // TN-37's violet path through the roundabout (here a copy of the cyan one, shifted): the rim follows it, not the cyan path.
  const violet = turns[1].path.map(p => ({ x: p.x + 0.3, z: p.z }));
  const ridden = turnArrays(turns, { zone: turns[1].zone, path: violet }, 0.2);
  assert.equal(ridden.along.length, full(turns[0].path.length) + rim(violet.length));
  const rimStart = full(turns[0].path.length);
  const at = (v: number) => ({ x: ridden.positions[v * 3], z: ridden.positions[v * 3 + 2] });
  const fromViolet = (v: number) => Math.hypot(at(v).x - violet[0].x, at(v).z - violet[0].z);
  // Cyan, 45%; each strip runs from violet's body edge (0.6 m) out to 1.8 m, so the rim is 3.6 m wide and open in the middle.
  assert.deepEqual(ridden.colors.slice(rimStart * 4, rimStart * 4 + 4).map(v => +v.toFixed(3)), [0.133, 0.827, 0.933, 0.45]);
  const n = violet.length;
  assert.ok(Math.abs(fromViolet(rimStart) - 1.8) < 1e-6 && Math.abs(fromViolet(rimStart + 1) - RIM_GAP / 2) < 1e-6);
  assert.ok(Math.abs(fromViolet(rimStart + 2 * n) - 1.8) < 1e-6 && Math.abs(fromViolet(rimStart + 2 * n + 1) - RIM_GAP / 2) < 1e-6);
  assert.ok(Math.abs(Math.hypot(at(rimStart).x - at(rimStart + 2 * n).x, at(rimStart).z - at(rimStart + 2 * n).z) - 3.6) < 1e-6);
  // The head's frame: an outer tip 0.9 m past violet's, and violet's own tip inside.
  const end = violet.at(-1)!, last = ridden.along.length;
  const tipOut = at(last - 5), tipIn = at(last - 2);
  assert.ok(Math.abs(Math.hypot(tipOut.x - end.x, tipOut.z - end.z) - (HEAD.length + RIM_HEAD.grow)) < 1e-6);
  assert.ok(Math.abs(Math.hypot(tipIn.x - end.x, tipIn.z - end.z) - HEAD.length) < 1e-6);
  assert.ok(ridden.indices.every(i => i < ridden.along.length));
});

test('lineSpans starts at along, ends 500 m on, is cut at arrowed zones and offset into the lane', () => {
  // A straight two-way residential road east (lane: half of 3.25 m right of the center line, south in world z).
  const coords: [number, number][] = [[0, 0], [400, 0], [1000, 0]];
  const route = routeOf([], coords, [{ start: 0, highway: 'residential', oneway: false }]);
  const lane = 3.25 / 2;
  const [only] = lineSpans(route, 100, 500);
  assert.deepEqual([only[0].x, only[0].z], [100, lane]);
  assert.deepEqual([only.at(-1)!.x, only.at(-1)!.z], [600, lane]);
  assert.ok(only.some(p => p.x === 400), 'keeps the route vertex');
  const cut = lineSpans(route, 100, 500, [{ x: 300, z: 0, radius: 10 }, { x: 900, z: 0, radius: 10 }]);
  assert.equal(cut.length, 2);
  assert.ok(Math.abs(cut[0].at(-1)!.x - 290) < 1e-9 && Math.abs(cut[1][0].x - 310) < 1e-9);
  // Near the end the line stops at the destination; past it there is none.
  assert.equal(lineSpans(route, 800, 500)[0].at(-1)!.x, 1000);
  assert.deepEqual(lineSpans(route, 1000, 500), []);
  // A one-way road keeps the line on its center.
  const oneway = routeOf([], coords, [{ start: 0, highway: 'residential', oneway: true }]);
  assert.equal(lineSpans(oneway, 0, 50)[0][0].z, 0);
  // Going west the lane is on the other side.
  const west = routeOf([], [[1000, 0], [0, 0]], [{ start: 0, highway: 'residential', oneway: false }]);
  assert.equal(lineSpans(west, 0, 50)[0][0].z, -lane);
  assert.equal(LINE_LAYERS.length, 3);
});
