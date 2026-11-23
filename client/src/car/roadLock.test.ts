import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREA, JABOTINSKY_WEST, SERVICE_NORTH, graphOf, junctionsOf, segmentsOf, type Road } from '../town/roadFixtures.ts';
import { createRoadGraph, toWorldJunctions, type RoadGraph } from '../town/roadGraph.ts';
import { onewayOf } from '../town/roadStyles.ts';
import { createRoadLock, LANE_OFFSET, type Pose, type RoadLock } from './roadLock.ts';

// Roads are [x east, y north] meters; poses are world x east, z south (z = -y).
const NORTH = Math.PI; // facing north: forward is (sin h, cos h) = (0, -1) in x, z
const SOUTH = 0;
const DT = 0.05;

const near = (actual: number, expected: number, tolerance = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

/** Distance from the pose to the closest of the roads' center lines. */
function distanceToRoads(pose: Pose, roads: Road[]): number {
  let best = Infinity;
  for (const road of roads) {
    for (let i = 0; i < road.coords.length - 1; i++) {
      const [ax, ay] = road.coords[i], [bx, by] = road.coords[i + 1];
      const px = pose.x, py = -pose.z;
      const t = Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
      best = Math.min(best, Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay))));
    }
  }
  return best;
}

/** Steps the lock for `seconds`, returning every pose. */
function drive(lock: RoadLock, graph: RoadGraph, from: Pose, speed: number, seconds: number, dt = DT) {
  const poses: (Pose & { speed: number })[] = [];
  let pose: Pose = from;
  let current = speed;
  for (let t = 0; t < seconds - 1e-9; t += dt) {
    const next = lock.step(pose, current, dt, graph);
    poses.push(next);
    pose = next;
    current = next.speed;
  }
  return poses;
}

const straight: Road = { highway: 'tertiary', coords: [[0, 0], [0, 100]] };

test('follows a straight segment 1.75 m right of the center line', () => {
  const graph = graphOf([straight]);
  const lock = createRoadLock();
  const start = lock.engage({ x: 5, z: -50, heading: NORTH }, graph);
  assert.ok(start);
  near(start.x, LANE_OFFSET); // facing north, the right-hand side is east
  near(start.z, -50);
  const poses = drive(lock, graph, start, 10, 2);
  poses.forEach((p, i) => {
    near(p.x, LANE_OFFSET);
    near(p.z, -50 - 10 * DT * (i + 1));
    near(p.heading, NORTH);
    assert.equal(p.speed, 10);
  });
});

test('a service road is narrower: the lane is half its half width', () => {
  const graph = graphOf([{ highway: 'service', coords: [[0, 0], [0, 100]] }]); // half width 2
  const start = createRoadLock().engage({ x: 0, z: -50, heading: NORTH }, graph);
  near(start!.x, 1);
});

test('facing the other way, the lane is on the other side', () => {
  const graph = graphOf([straight]);
  const start = createRoadLock().engage({ x: 0, z: -50, heading: SOUTH }, graph)!;
  near(start.x, -LANE_OFFSET);
  near(start.heading, SOUTH);
});

test('engage with no drivable road stays off', () => {
  const lock = createRoadLock();
  const empty = createRoadGraph([], []);
  assert.equal(lock.engage({ x: 0, z: 0, heading: 0 }, empty), null);
  assert.equal(lock.active, false);
  const pose = { x: 3, z: 4, heading: 1 };
  assert.deepEqual(lock.step(pose, 7, DT, empty), { ...pose, speed: 7 }); // off: the pose passes through
});

test('a road cut at a tile edge is one continuous road', () => {
  const graph = graphOf([
    { highway: 'tertiary', coords: [[0, 0], [0, 100]] },
    { highway: 'tertiary', coords: [[0, 100], [0, 200]] }, // the other tile's piece
  ]);
  const lock = createRoadLock();
  const start = lock.engage({ x: 0, z: -90, heading: NORTH }, graph)!;
  const poses = drive(lock, graph, start, 10, 2); // 20 m: crosses the cut at z = -100
  assert.ok(poses[poses.length - 1].z < -105);
  for (const p of poses) {
    near(p.x, LANE_OFFSET);
    near(p.heading, NORTH);
    assert.equal(p.speed, 10);
  }
});

test('picks the straightest continuation at a T and a 4-way', () => {
  const graph = graphOf(AREA);
  // Service road north-east through the Jabotinsky crossing at (0, 0): straight on, not onto Jabotinsky.
  const lock = createRoadLock();
  const start = lock.engage({ x: -2.5, z: 3.5, heading: Math.atan2(5, -7) }, graph)!;
  const end = drive(lock, graph, start, 5, 3).at(-1)!; // 15 m: 4.3 m to the crossing, then 10.7 m on
  assert.ok(distanceToRoads(end, [SERVICE_NORTH]) < 1.2, 'stays on the service road');
  assert.ok(end.x > 4 && -end.z > 8, `at ${end.x}, ${-end.z}`);
  // North along the service road to the T at (12, 22): straight on to (14, 26), not onto (19, 20).
  const t = createRoadLock();
  const from = t.engage({ x: 9, z: -15, heading: Math.atan2(3, -7) }, graph)!;
  const past = drive(t, graph, from, 5, 3).at(-1)!;
  assert.ok(past.x < 16 && -past.z > 26, `at ${past.x}, ${-past.z}`);
});

test('keeps one-way rules when there is a legal choice', () => {
  const road = (coords: [number, number][], oneway = false): Road => ({ highway: 'service', oneway, coords });
  const along = road([[0, 0], [0, 50]]);
  const straightOn = road([[0, 100], [0, 50]], true); // one-way toward the junction: against it going north
  const side = road([[0, 50], [50, 50]]);

  // The straightest road is illegal, so the side road is taken.
  const withSide = graphOf([along, straightOn, side]);
  const lock = createRoadLock();
  const start = lock.engage({ x: 0, z: -45, heading: NORTH }, withSide)!;
  const end = drive(lock, withSide, start, 10, 2).at(-1)!; // 20 m: 5 to the junction, then 15 east
  near(end.x, 15, 1);
  near(end.z, -49, 0.3); // facing east, the lane is 1 m south of the center line

  // Nothing legal: the smallest angle overall wins.
  const without = graphOf([along, straightOn]);
  const again = createRoadLock();
  const from = again.engage({ x: 0, z: -45, heading: NORTH }, without)!;
  const through = drive(again, without, from, 10, 2).at(-1)!;
  near(through.z, -65, 0.5);
});

test('continues along Jabotinsky through the crossing at the origin', () => {
  const graph = graphOf(AREA);
  const lock = createRoadLock();
  // On the west carriageway at (31, -26), 40.5 m from the crossing, heading for it.
  const start = lock.engage({ x: 31, z: 26, heading: Math.atan2(-31, -26) }, graph)!;
  const poses = drive(lock, graph, start, 10, 6); // 60 m: through (0, 0) and 19.5 m on
  const end = poses.at(-1)!;
  assert.ok(distanceToRoads(end, [JABOTINSKY_WEST]) < 1e-6, 'still on the carriageway');
  assert.ok(end.x < -8, `at ${end.x}, ${-end.z}`);
});

test('one-way roads drive on the center line', () => {
  const graph = graphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: 88, z: 59, heading: Math.atan2(-50, -28) }, graph)!; // (88, -59), with the traffic
  assert.ok(distanceToRoads(start, [JABOTINSKY_WEST]) < 1e-6);
  for (const p of drive(lock, graph, start, 10, 8)) assert.ok(distanceToRoads(p, [JABOTINSKY_WEST]) < 1e-6);
});

test('a one-way road only has one way to face', () => {
  const graph = graphOf(AREA);
  // Facing against the west carriageway's traffic: it turns the car around.
  const start = createRoadLock().engage({ x: 88, z: 59, heading: Math.atan2(50, 28) }, graph)!;
  near(start.heading, Math.atan2(-50, -28), 1e-9);
});

test('stops at a dead end and reverses out', () => {
  const graph = graphOf([straight]);
  const lock = createRoadLock();
  const start = lock.engage({ x: 0, z: -90, heading: NORTH }, graph)!;
  const poses = drive(lock, graph, start, 10, 2);
  const stopped = poses.at(-1)!;
  near(stopped.z, -100);
  assert.equal(stopped.speed, 0);
  // Pushing on does not move it.
  const pushed = drive(lock, graph, stopped, 10, 1).at(-1)!;
  near(pushed.z, -100);
  assert.equal(pushed.speed, 0);
  // Reversing backs out along the road, still facing the same way.
  const backed = drive(lock, graph, pushed, -3, 1).at(-1)!;
  near(backed.z, -100 + 3, 1e-6);
  near(backed.heading, NORTH);
  assert.equal(backed.speed, -3);
});

test('reversing retraces the road through a junction', () => {
  const graph = graphOf(AREA);
  const lock = createRoadLock();
  const heading = Math.atan2(5, -7);
  const start = lock.engage({ x: -2.5, z: 3.5, heading }, graph)!;
  const out = drive(lock, graph, start, 5, 3); // through the crossing
  const back = drive(lock, graph, out.at(-1)!, -5, 3).at(-1)!;
  near(back.x, start.x, 0.1);
  near(back.z, start.z, 0.1);
  near(back.heading, heading, 0.01); // it never turned around
});

test('crosses many short segments and a junction in one big step', () => {
  const steps: [number, number][] = Array.from({ length: 61 }, (_, y) => [0, y]);
  const lock = createRoadLock();
  const graph = graphOf([{ highway: 'tertiary', coords: steps }]);
  const start = lock.engage({ x: 0, z: -1, heading: NORTH }, graph)!;
  const end = lock.step(start, 50 / 1.2, 1.2, graph); // 50 m at once
  near(end.z, -51, 1e-6);
  near(end.x, LANE_OFFSET, 1e-6);

  const crossing = graphOf(AREA);
  const big = createRoadLock();
  const from = big.engage({ x: 31, z: 26, heading: Math.atan2(-31, -26) }, crossing)!;
  const past = big.step(from, 60 / 1.2, 1.2, crossing); // 60 m: over the crossing in one step
  assert.ok(distanceToRoads(past, [JABOTINSKY_WEST]) < 1e-6);
  assert.ok(past.x < -8);
});

test('at 150 km/h the car never leaves the road', () => {
  const graph = graphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: 138, z: 89, heading: Math.atan2(-25, -16) }, graph)!;
  const poses = drive(lock, graph, start, 150 / 3.6, 15); // down Jabotinsky, over the crossing, around the roundabout
  assert.ok(poses.length > 200);
  for (const p of poses) assert.ok(distanceToRoads(p, AREA) < 1e-6, `left the roads at ${p.x}, ${-p.z}`);
});

test('keeps its place when the graph is rebuilt', () => {
  const roads = AREA;
  const first = graphOf(roads);
  // Same roads, different order and a new object: segment indexes all change.
  const rebuilt = createRoadGraph(segmentsOf(roads).reverse(), toWorldJunctions(junctionsOf(roads)));

  const start = { x: -2.5, z: 3.5, heading: Math.atan2(5, -7) };
  const steady = createRoadLock();
  const a = drive(steady, first, steady.engage(start, first)!, 5, 4);

  const swapped = createRoadLock();
  const head = drive(swapped, first, swapped.engage(start, first)!, 5, 1.5); // before the crossing
  const tail = drive(swapped, rebuilt, head.at(-1)!, 5, 2.5); // the graph changes while on the segment
  const b = [...head, ...tail];

  assert.equal(a.length, b.length);
  a.forEach((p, i) => { near(p.x, b[i].x, 1e-9); near(p.z, b[i].z, 1e-9); });
});

test('reset after a teleport lands on the new road and keeps the lock on', () => {
  const graph = graphOf(AREA);
  const lock = createRoadLock();
  lock.engage({ x: 0, z: 0, heading: 0 }, graph);
  const moved = lock.reset({ x: 20, z: -71, heading: SOUTH }, graph)!; // on the east end of the service road
  assert.equal(lock.active, true);
  assert.ok(distanceToRoads(moved, [SERVICE_NORTH]) < 1.01);
  assert.equal(createRoadLock().reset({ x: 0, z: 0, heading: 0 }, graph), null); // off: nothing to reset
});

test('onewayOf reads oneway tags and roundabouts', () => {
  assert.equal(onewayOf({ oneway: 'yes' }), 1);
  assert.equal(onewayOf({ oneway: '1' }), 1);
  assert.equal(onewayOf({ oneway: 'true' }), 1);
  assert.equal(onewayOf({ junction: 'roundabout' }), 1);
  assert.equal(onewayOf({ oneway: '-1' }), -1);
  assert.equal(onewayOf({ oneway: 'no' }), 0);
  assert.equal(onewayOf({}), 0);
});
