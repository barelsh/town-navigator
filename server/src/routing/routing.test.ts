import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Town } from '@town-navigator/shared';
import { buildGraph, canMove, type RouteGraph } from './graph.ts';
import { planRoute } from './plan.ts';
import { findPath } from './search.ts';
import { U_TURN_PENALTY, snapGoal, snapStart } from './snap.ts';
import { CROSSING, ROUNDABOUT, X, restriction, townOf, way } from './testTowns.ts';

const route = (g: RouteGraph, from: [number, number, number], to: [number, number]) => {
  const result = planRoute(g, { from: { x: from[0], y: from[1], bearing: from[2] }, to: { x: to[0], y: to[1] } });
  assert.ok('route' in result, 'error' in result ? result.error : '');
  return result.route;
};
const near = (a: number, b: number, eps = 0.05) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

test('picks the shorter of two parallel routes', () => {
  const g = buildGraph(townOf([
    way(1, [[1, -50, 0], [2, 0, 0]]),
    way(2, [[2, 0, 0], [3, 50, 10], [4, 100, 0]]),   // short: 2 × 51.0 m
    way(3, [[2, 0, 0], [5, 50, 60], [4, 100, 0]]),   // long: 2 × 78.1 m
    way(4, [[4, 100, 0], [6, 150, 0]]),
  ]));
  const r = route(g, [-20, 0, 90], [130, 0]);
  near(r.distance, 20 + 2 * Math.hypot(50, 10) + 30);
  assert.ok(r.points.some(([x, y]) => x === 50 && y === 10));
});

test('never drives a one-way piece backwards; oneway=-1 runs b to a', () => {
  const ways = (tags: Record<string, string>, a: [number, number, number], b: [number, number, number]) => [
    way(1, [a, b], tags),                                      // the short way, one-way
    way(2, [[1, 0, 0], [3, 0, 100], [4, 100, 100], [2, 100, 0]]), // 300 m around
    way(3, [[5, -50, 0], [1, 0, 0]]),
    way(4, [[2, 100, 0], [6, 150, 0]]),
  ];
  const east = buildGraph(townOf(ways({ oneway: 'yes' }, [1, 0, 0], [2, 100, 0])));
  near(route(east, [-20, 0, 90], [130, 0]).distance, 20 + 100 + 30);  // with the flow
  near(route(east, [130, 0, 270], [-20, 0]).distance, 30 + 300 + 20);  // against it: the long way
  const reversed = buildGraph(townOf(ways({ oneway: '-1' }, [2, 100, 0], [1, 0, 0]))); // drawn west, runs east
  near(route(reversed, [-20, 0, 90], [130, 0]).distance, 20 + 100 + 30);
  near(route(reversed, [130, 0, 270], [-20, 0]).distance, 30 + 300 + 20);
});

test('no_left_turn forbids that move; only_straight_on allows only the to-way', () => {
  const from: [number, number, number] = [0, -50, 0], to: [number, number] = [-50, 0]; // north on 11, goal on 13 (left)
  near(route(buildGraph(townOf(CROSSING)), from, to).distance, 100);
  // no left from 11: straight over to the east arm's dead end, turn round there, and go straight on from 14 into 13
  near(route(buildGraph(townOf(CROSSING, [restriction('no_left_turn', 11, X[0], 13)])), from, to).distance, 50 + 100 + 100 + 50);
  // only straight on from 11: north, round the loop to the west arm's end, then 50 m east along 13
  near(route(buildGraph(townOf(CROSSING, [restriction('only_straight_on', 11, X[0], 12)])), from, to).distance, 400);
  // only_straight_on does not affect other from-ways: from the east arm, west is straight anyway
  near(route(buildGraph(townOf(CROSSING, [restriction('only_straight_on', 11, X[0], 12)])), [50, 0, 270], to).distance, 100);
});

test('no U-turn mid-road; a U-turn at a dead end is allowed', () => {
  const g = buildGraph(townOf(CROSSING));
  const x = [...g.nodeId].indexOf(X[0]);
  const intoX = [...g.edgeTo].findIndex((n, e) => n === x && g.pieces[g.edgePiece[e]].wayId === 11);
  const backOut = [...g.edgeFrom].findIndex((n, e) => n === x && g.pieces[g.edgePiece[e]].wayId === 11);
  assert.equal(canMove(g, intoX, backOut), false);
  const deadEnd = [...g.nodeId].indexOf(5); // the east arm's end
  const intoEnd = [...g.edgeTo].findIndex(n => n === deadEnd);
  const outOfEnd = [...g.edgeFrom].findIndex(n => n === deadEnd);
  assert.equal(canMove(g, intoEnd, outOfEnd), true);
});

test('start snapping prefers the piece direction aligned with the bearing; the other way costs 50 m', () => {
  const g = buildGraph(townOf(CROSSING));
  const north = snapStart(g, 3, -50, 10)!;   // 3 m off the south arm, facing north
  const aligned = north.seeds.find(s => s.penalty === 0)!, other = north.seeds.find(s => s.penalty > 0)!;
  assert.equal(g.edgeForward[aligned.edge], 1);   // way 11 runs south → north
  near(aligned.cost, 50);
  near(other.cost, 50 + U_TURN_PENALTY);
  // a goal behind the car: turn back (driven 30 m), the penalty is not driven distance
  const back = route(g, [0, -50, 0], [0, -80]);
  near(back.distance, 30);
  assert.ok(back.points.at(-1)![1] < back.points[0][1]);
  // ... and it starts with a U-turn where the car is
  assert.deepEqual(back.maneuvers.map(m => [m.turn, m.along, m.nodes.length, m.inBearing, m.outBearing]), [['uturn', 0, 0, 0, 180]]);
});

test('destination in the middle of a piece: the distance includes the offset', () => {
  const g = buildGraph(townOf(CROSSING));
  const goal = snapGoal(g, -30, 4)!;
  near(goal.x, -30);
  near(route(g, [0, -50, 0], [-30, 4]).distance, 80);
});

test('start and destination on the same piece', () => {
  const g = buildGraph(townOf(CROSSING));
  const r = route(g, [0, -80, 0], [0, -20]);
  near(r.distance, 60);
  assert.deepEqual(r.maneuvers, []);
  assert.deepEqual(r.points, [[0, -80], [0, -20]]);
});

test('roundabout: ring nodes group into one maneuver with the right exit number', () => {
  const g = buildGraph(townOf(ROUNDABOUT));
  const r = route(g, [0, -80, 0], [-80, 0]); // in from the south, out to the west: past east and north
  assert.equal(r.maneuvers.length, 1);
  const m = r.maneuvers[0];
  assert.equal(m.turn, 'roundabout');
  assert.equal(m.exit, 3);
  assert.equal(m.road, 'West');
  assert.deepEqual(m.nodes, [21, 22, 23, 24]);
  assert.equal(m.inBearing, 0);
  assert.equal(m.outBearing, 270);
  assert.equal(m.angle, -90);
  near(m.along, 60);
  assert.equal(route(g, [0, -80, 0], [80, 0]).maneuvers[0].exit, 1);
});

test('plain junction turns and an ambiguous straight', () => {
  const g = buildGraph(townOf(CROSSING));
  const left = route(g, [0, -50, 0], [-50, 0]).maneuvers;
  assert.deepEqual(left.map(m => [m.turn, m.angle, m.along]), [['left', -90, 50]]);
  // A fork: the route keeps 25° right, but the other branch is dead straight, so "straight" needs saying.
  const fork = buildGraph(townOf([
    way(1, [[1, 0, -100], [2, 0, 0]]),
    way(2, [[2, 0, 0], [3, 0, 100]]),
    way(3, [[2, 0, 0], [4, Math.sin(25 * Math.PI / 180) * 100, Math.cos(25 * Math.PI / 180) * 100]]),
  ]));
  const [m] = route(fork, [0, -50, 0], [Math.sin(25 * Math.PI / 180) * 80, Math.cos(25 * Math.PI / 180) * 80]).maneuvers;
  assert.equal(m.turn, 'straight');
  assert.equal(m.ambiguous, true);
});

test('errors: no road near either end, and no legal route', () => {
  const g = buildGraph(townOf(CROSSING));
  const plan = (from: [number, number, number], to: [number, number]) =>
    planRoute(g, { from: { x: from[0], y: from[1], bearing: from[2] }, to: { x: to[0], y: to[1] } });
  assert.deepEqual(plan([300, 300, 0], [0, 50]), { error: 'The car is not near a road.' });
  assert.deepEqual(plan([0, -50, 0], [300, 300]), { error: 'No road leads near this place.' });
  const island = buildGraph(townOf([...CROSSING, way(99, [[90, 300, 300], [91, 350, 300]])]));
  assert.deepEqual(planRoute(island, { from: { x: 0, y: -50, bearing: 0 }, to: { x: 320, y: 300 } }), { error: 'No legal route to this place.' });
  assert.deepEqual(planRoute(buildGraph(townOf([])), { from: { x: 0, y: 0, bearing: 0 }, to: { x: 1, y: 1 } }),
    { error: 'This town has no road graph. Re-export it with npm run normalize.' });
});

// Real data: skipped when the generated town file is missing.
const ROSH = path.resolve(import.meta.dirname, '../../../data/town_meters_rosh_haayin.geojson');
const real = existsSync(ROSH);
let roshGraph: RouteGraph | undefined;
const rosh = () => (roshGraph ??= buildGraph(JSON.parse(readFileSync(ROSH, 'utf8')) as Town));

test('rosh_haayin: graph has 2370 nodes and 4636 directed edges', { skip: !real }, () => {
  const { nodes, edges, restrictions, viaWaySkipped } = rosh().stats;
  assert.deepEqual({ nodes, edges, restrictions, viaWaySkipped }, { nodes: 2370, edges: 4636, restrictions: 50, viaWaySkipped: 6 });
});

test('rosh_haayin: A* equals Dijkstra on 50 seeded random pairs, each under 20 ms', { skip: !real }, () => {
  const g = rosh();
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const node = () => Math.floor(random() * g.nodeX.length);
  let found = 0;
  for (let i = 0; i < 50; i++) {
    const a = node(), b = node();
    const start = snapStart(g, g.nodeX[a], g.nodeY[a], random() * 360)!, goal = snapGoal(g, g.nodeX[b], g.nodeY[b])!;
    const t0 = performance.now();
    const fast = findPath(g, start, goal);
    const ms = performance.now() - t0;
    const slow = findPath(g, start, goal, { heuristic: false });
    assert.ok(ms < 20, `pair ${i}: ${ms.toFixed(1)} ms`);
    assert.equal(fast === null, slow === null, `pair ${i}`);
    if (fast && slow) { near(fast.distance, slow.distance, 1e-6); assert.ok(fast.settled <= slow.settled); found++; }
  }
  assert.ok(found >= 40, `only ${found} of 50 pairs have a route`);
});

test('rosh_haayin: centre to library is 2.8 km with 6 roundabouts (2,134 m: exit 1) and a final left', { skip: !real }, () => {
  const r = route(rosh(), [-18.3, -7.9, 0], [-2009, 609]);
  near(r.distance, 2802, 5);
  const shown = r.maneuvers.filter(m => m.turn !== 'straight' || m.ambiguous);
  assert.deepEqual(shown.map(m => [m.turn, m.exit ?? null]), [
    ['roundabout', 2], ['slight_right', null], ['roundabout', 3], ['roundabout', 1],
    ['roundabout', 2], ['roundabout', 1], ['roundabout', 3], ['left', null],
  ]);
  near(shown[5].along, 2134, 5);
  assert.deepEqual([shown[5].x, shown[5].y].map(Math.round), [-1564, 688]);
});

test('a car standing on a junction node gets the turn there measured along the road it came by', () => {
  // Facing south at X on the north arm's end of the crossing: the route east is a left turn here and now.
  const g = buildGraph(townOf(CROSSING));
  const [m] = route(g, [0, 0, 180], [50, 0]).maneuvers;
  assert.deepEqual([m.along, m.inBearing, m.outBearing, m.turn], [0, 180, 90, 'left']);
});

test('standing on a junction node facing the way out: no maneuver at the start', () => {
  const g = buildGraph(townOf(CROSSING));
  assert.deepEqual(route(g, [0, 0, 0], [0, 50]).maneuvers, []);
});
