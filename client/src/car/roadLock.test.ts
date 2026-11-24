import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREA, JABOTINSKY_EAST, MOSHE_DAYAN, ROUNDABOUT, JABOTINSKY_NW, JABOTINSKY_WEST, SERVICE_NORTH, SERVICE_T, graphOf as zonedGraphOf, junctionsOf, segmentsOf, type Road } from '../town/roadFixtures.ts';
import { createRoadGraph, toWorldJunctions, type RoadGraph } from '../town/roadGraph.ts';
import { onewayOf } from '../town/roadStyles.ts';
import { averageRadius, pursue, routeSpeed, ROUTE_SPEED_MAX, ROUTE_SPEED_MIN, tightestRadius } from './turnRoute.ts';
import { applyHold, brakingDistance, CAP_BRAKE, createRoadLock, ENTER_LOOKAHEAD, EXIT_MARGIN, LANE_OFFSET, pickTarget, TURN_AROUND_CAP, type Pose, type RoadLock, type Side } from './roadLock.ts';

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

// The TN-35 tests below have no junction data (whole-town mode, tiles written before TN-33), so there are no
// zones and the car takes the straightest road at a junction. The zone tests further down use `zonedGraphOf`.
const graphOf = (roads: Road[]): RoadGraph => createRoadGraph(segmentsOf(roads), []);

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
  const rebuilt = createRoadGraph(segmentsOf(roads).reverse(), []);

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

// ---------------------------------------------------------------------------------------------
// TN-36: free steering inside junction zones. These use graphs with junction data (zonedGraphOf).

interface Phase { speed: number; steer?: number; seconds: number }
interface Frame { pose: Pose; speed: number; mode: 'locked' | 'free'; candidate: ReturnType<RoadLock['candidate']>; hold: boolean }

/**
 * Drives the lock the way carController does: locked cars are placed by `step`; free cars steer (today's model),
 * are held by `hold`, and then `observe`. Each phase holds a speed (the player's W and S) and a steer
 * (+1: A, left). A hold zeroes the speed for that frame, as in the app.
 */
function ride(lock: RoadLock, graphs: RoadGraph | ((frame: number) => RoadGraph), start: Pose, phases: Phase[]): Frame[] {
  const frames: Frame[] = [];
  let pose: Pose = { ...start };
  for (const phase of phases) {
    for (let t = 0; t < phase.seconds - 1e-9; t += DT) {
      const graph = typeof graphs === 'function' ? graphs(frames.length) : graphs;
      let speed = phase.speed;
      if (lock.mode === 'locked') {
        const next = lock.step(pose, speed, DT, graph);
        pose = { x: next.x, z: next.z, heading: next.heading };
        speed = next.speed;
      } else {
        const before = { x: pose.x, z: pose.z };
        pose = { ...pose, heading: pose.heading + (phase.steer ?? 0) * DT * 2.2 * Math.max(-1, Math.min(1, speed / 8)) };
        pose.x += Math.sin(pose.heading) * speed * DT;
        pose.z += Math.cos(pose.heading) * speed * DT;
        if (lock.hold) {
          const held = applyHold(lock.hold, before, pose);
          if (held.held) { pose.x = held.x; pose.z = held.z; speed = 0; }
        }
        lock.observe(pose, speed, DT, graph);
      }
      frames.push({ pose: { ...pose }, speed, mode: lock.mode, candidate: lock.candidate(), hold: lock.hold !== undefined });
    }
  }
  return frames;
}

const headingXY = (dx: number, dy: number) => Math.atan2(dx, -dy); // for a road direction [x east, y north]
const centerOf = (graph: RoadGraph, [x, y]: [number, number]) => {
  const zone = graph.zones.find(z => z.members.some(m => m.x === x && m.z === -y));
  assert.ok(zone, `no zone has a member at ${x}, ${y}`);
  return zone;
};
/** Meters to the right of a car facing `heading`, from the closest point of the road's center line. */
function rightOfRoad(pose: Pose, road: Road): number {
  let best: { d: number; right: number } | null = null;
  for (let i = 0; i < road.coords.length - 1; i++) {
    const [ax, ay] = road.coords[i], [bx, by] = road.coords[i + 1];
    const px = pose.x, py = -pose.z;
    const t = Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    const cx = ax + t * (bx - ax), cy = ay + t * (by - ay);
    const d = Math.hypot(px - cx, py - cy);
    // right of facing h is (-cos h, sin h) in x, z; in x, y (y = -z) that is (-cos h, -sin h)
    if (!best || d < best.d) best = { d, right: (px - cx) * -Math.cos(pose.heading) + (py - cy) * -Math.sin(pose.heading) };
  }
  return best!.right;
}
const firstFree = (frames: Frame[]) => frames.findIndex(f => f.mode === 'free');

test('enters a zone earlier at higher speed', () => {
  const graph = zonedGraphOf(AREA);
  const zone = centerOf(graph, [12, 22]); // a T-junction on the service road, 5 m radius
  const distances = [5, 20].map(speed => {
    const lock = createRoadLock();
    const start = lock.engage({ x: 19, z: -47, heading: headingXY(-7, -25) }, graph)!; // south along it
    const frames = ride(lock, graph, start, [{ speed, seconds: 5 }]);
    const at = frames[firstFree(frames)].pose;
    const distance = Math.hypot(at.x - zone.x, at.z - zone.z);
    const wanted = zone.radius + speed * ENTER_LOOKAHEAD;
    assert.ok(distance <= wanted + 1e-9 && distance > wanted - speed * DT - 0.05, `${speed} m/s entered at ${distance}, wanted about ${wanted}`);
    return distance;
  });
  assert.ok(distances[1] > distances[0] + 3);
});

test('a parallel carriageway passing near a zone does not enter it', () => {
  const graph = zonedGraphOf(AREA);
  const zone = centerOf(graph, [63, -45]); // on the westbound carriageway
  const lock = createRoadLock();
  const start = lock.engage({ x: 44, z: 44, heading: headingXY(62, -38) }, graph)!; // eastbound, on its own carriageway
  const frames = ride(lock, graph, start, [{ speed: 10, seconds: 8 }]);
  const closest = Math.min(...frames.map(f => Math.hypot(f.pose.x - zone.x, f.pose.z - zone.z)));
  assert.ok(closest < zone.radius + 10 * ENTER_LOOKAHEAD, `it only came within ${closest}: nothing to test`);
  assert.ok(frames.every(f => f.mode === 'locked'), 'it was caught in a zone of the other carriageway');
});

test('no steering through a 4-way exits straight on', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: 31, z: 26, heading: headingXY(-31, 26) }, graph)!; // west carriageway, toward the crossing
  const frames = ride(lock, graph, start, [{ speed: 10, seconds: 7 }]);
  assert.ok(firstFree(frames) > 0, 'it never entered the zone');
  const end = frames.at(-1)!;
  assert.equal(end.mode, 'locked');
  assert.ok(distanceToRoads(end.pose, [JABOTINSKY_WEST]) < 0.05, 'left the carriageway'); // a snap eases in, so a few mm off at first
  assert.ok(end.pose.x < -8);
});

test('steering 90° left in the zone locks onto the left exit with the lane on the right', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: 19, z: -47, heading: headingXY(-7, -25) }, graph)!; // south, into the T at (12, 22)
  const frames = ride(lock, graph, start, [{ speed: 4, seconds: 4 }, { speed: 4, steer: 1, seconds: 3 }, { speed: 4, seconds: 3 }]);
  const end = frames.at(-1)!;
  assert.equal(end.mode, 'locked');
  assert.ok(frames.some(f => f.candidate && Math.abs(f.candidate.heading - Math.PI * 74 / 180) < 0.05), 'the east exit was never the candidate');
  assert.ok(distanceToRoads(end.pose, [SERVICE_T]) < 1.2, 'not on the side road');
  assert.ok(distanceToRoads(end.pose, [SERVICE_NORTH]) > 5, 'still on the main road');
  near(rightOfRoad(end.pose, SERVICE_T), 1, 0.1); // a service road's lane is 1 m right of its center
});

test('never locks onto a one-way-in exit', () => {
  const graph = zonedGraphOf(AREA);
  const zone = centerOf(graph, [0, 0]); // the Jabotinsky crossing: two of its five exits are one-way in
  assert.equal(zone.exits.filter(e => e.flow === 'in').length, 2);
  let tempted = false;
  for (const steer of [-1, 0, 1]) {
    const lock = createRoadLock();
    const start = lock.engage({ x: 31, z: 26, heading: headingXY(-31, 26) }, graph)!;
    const frames = ride(lock, graph, start, [{ speed: 6, seconds: 6 }, { speed: 6, steer, seconds: 1.5 }, { speed: 6, seconds: 5 }]);
    for (const f of frames) {
      if (f.mode !== 'free') continue;
      assert.notEqual(f.candidate?.flow, 'in');
      // How often the closest exit by heading alone was a one-way-in one.
      const closest = zone.exits.reduce((best, e) => Math.abs(Math.atan2(Math.sin(e.heading - f.pose.heading), Math.cos(e.heading - f.pose.heading)))
        < Math.abs(Math.atan2(Math.sin(best.heading - f.pose.heading), Math.cos(best.heading - f.pose.heading))) ? e : best);
      if (closest.flow === 'in') tempted = true;
    }
    assert.equal(frames.at(-1)!.mode, 'locked');
  }
  assert.ok(tempted, 'the test never pointed the car at a one-way-in exit');
});

test('dead end: held at the zone edge, a U-turn exits the way it came', () => {
  const graph = zonedGraphOf(AREA);
  const zone = centerOf(graph, [25, -2]); // where the side road ends
  assert.equal(zone.kind, 'dead_end');
  const lock = createRoadLock();
  const start = lock.engage({ x: 23, z: -16, heading: headingXY(2, -18) }, graph)!; // south, toward the end
  const driven = ride(lock, graph, start, [{ speed: 6, seconds: 5 }]).at(-1)!;
  assert.equal(driven.mode, 'free');
  assert.equal(driven.speed, 0);
  assert.equal(driven.hold, true);
  near(Math.hypot(driven.pose.x - zone.x, driven.pose.z - zone.z), zone.radius + EXIT_MARGIN, 0.05); // stopped at the edge
  // Reverse a little, steer around and drive back out.
  const out = ride(lock, graph, driven.pose, [{ speed: -3, steer: 1, seconds: 1.5 }, { speed: 3, steer: 1, seconds: 4 }, { speed: 3, seconds: 3 }]);
  const end = out.at(-1)!;
  assert.equal(end.mode, 'locked');
  assert.ok(end.pose.z > driven.pose.z + 5 || -end.pose.z > -driven.pose.z + 5, 'it did not come back along the road');
  assert.ok(Math.abs(Math.atan2(Math.sin(end.pose.heading - (start.heading + Math.PI)), Math.cos(end.pose.heading - (start.heading + Math.PI)))) < 0.3,
    'it is not heading the other way');
  assert.ok(distanceToRoads(end.pose, [SERVICE_T]) < 1.2);
});

test('roundabout zone: steering around exits on the chosen road', () => {
  const graph = zonedGraphOf(AREA);
  const southOnMosheDayan = { x: -40, z: -83, heading: headingXY(-5, -20) };
  const leave = (steer: number, settle: number) => {
    const lock = createRoadLock();
    const start = lock.engage(southOnMosheDayan, graph)!;
    const frames = ride(lock, graph, start, [{ speed: 6, seconds: 6 }, { speed: 6, steer, seconds: 3 }, { speed: 6, seconds: settle }]);
    return frames.at(-1)!;
  };
  // Left: out onto the two-way Jabotinsky road to the north-west, in its right-hand lane.
  const left = leave(1, 8);
  assert.equal(left.mode, 'locked');
  near(distanceToRoads(left.pose, [JABOTINSKY_NW]), LANE_OFFSET, 0.1);
  near(rightOfRoad(left.pose, JABOTINSKY_NW), LANE_OFFSET, 0.1);
  // Right, or straight on: onto the one-way carriageway to the south-east, on its center line.
  for (const [steer, settle] of [[-1, 8], [0, 5]]) { // a long merge needs a few seconds to ease in; stop before the next zone
    const end = leave(steer, settle);
    assert.equal(end.mode, 'locked');
    assert.ok(distanceToRoads(end.pose, [JABOTINSKY_EAST]) < 0.05, `steer ${steer}: not on the carriageway`);
  }
});

test('reverse through a zone exits by the direction of travel', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  // South of the T at (12, 22), facing south, away from it: reversing runs north into it.
  const start = lock.engage({ x: 9, z: -15, heading: headingXY(-3, -7) }, graph)!;
  const frames = ride(lock, graph, start, [{ speed: -3, seconds: 2.5 }, { speed: -3, steer: 1, seconds: 2.5 }, { speed: -3, seconds: 6 }]);
  assert.ok(firstFree(frames) > 0, 'it never entered the zone');
  const end = frames.at(-1)!;
  assert.equal(end.mode, 'locked');
  assert.equal(end.speed, -3); // still reversing
  assert.ok(distanceToRoads(end.pose, [SERVICE_T]) < 1.2, 'not backed out onto the side road');
  assert.ok(distanceToRoads(end.pose, [SERVICE_NORTH]) > 5);
  // It faces in: the side road runs south here, and the car faces north, toward the junction.
  assert.ok(Math.cos(end.pose.heading) < -0.9, `facing ${end.pose.heading}`);
});

test('zones in a row each catch the car once', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: 19, z: -47, heading: headingXY(-7, -25) }, graph)!;
  const frames = ride(lock, graph, start, [{ speed: 3, seconds: 18 }]); // straight through the T and on into the crossing
  const entries = frames.filter((f, i) => f.mode === 'free' && (i === 0 || frames[i - 1].mode === 'locked'));
  assert.equal(entries.length, 2);
  const crossing = centerOf(graph, [0, 0]);
  assert.ok(Math.hypot(entries[1].pose.x - crossing.x, entries[1].pose.z - crossing.z) < crossing.radius + 3 * ENTER_LOOKAHEAD + 0.1);
});

test('a zone that was just left does not catch the car again until it is 2 m outside', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: 19, z: -47, heading: headingXY(-7, -25) }, graph)!;
  const frames = ride(lock, graph, start, [{ speed: 3, seconds: 10.8 }, { speed: -3, seconds: 8 }]); // out of the T, then straight back
  const left = frames.findIndex((f, i) => i > firstFree(frames) && f.mode === 'locked');
  assert.ok(left > 0 && left < 10.8 / DT, 'it had not left the zone yet');
  // Reversing straight back toward the zone it just left: still locked, not caught again.
  assert.ok(frames.slice(left).every(f => f.mode === 'locked'));

  // Once it is further out it is caught again as usual.
  const again = createRoadLock();
  const away = ride(again, graph, again.engage(start, graph)!, [{ speed: 3, seconds: 12 }, { speed: -3, seconds: 6 }]);
  assert.ok(away.slice(12 / DT).some(f => f.mode === 'free'));
});

test('keeps going when the graph is rebuilt inside a zone, and snaps to the road if the zone is gone', () => {
  const roads = AREA;
  const first = zonedGraphOf(roads);
  const rebuilt = createRoadGraph(segmentsOf(roads).reverse(), toWorldJunctions(junctionsOf(roads))); // indexes all change
  const start = { x: 19, z: -47, heading: headingXY(-7, -25) };
  const phases: Phase[] = [{ speed: 4, seconds: 4 }, { speed: 4, steer: 1, seconds: 3 }, { speed: 4, seconds: 5 }];

  const a = createRoadLock();
  const steady = ride(a, first, a.engage(start, first)!, phases);
  const b = createRoadLock();
  const inZone = firstFree(steady) + 10;
  const swapped = ride(b, i => (i < inZone ? first : rebuilt), b.engage(start, first)!, phases); // swap while free
  assert.equal(swapped[inZone].mode, 'free');
  assert.equal(swapped.length, steady.length);
  steady.forEach((f, i) => { near(f.pose.x, swapped[i].pose.x, 1e-9); near(f.pose.z, swapped[i].pose.z, 1e-9); });

  // No zone there any more: the car goes back to the nearest road at once, without a jump, and stays on it.
  const c = createRoadLock();
  const noZones = createRoadGraph(segmentsOf(roads), []);
  const gone = ride(c, i => (i < inZone ? first : noZones), c.engage(start, first)!, phases);
  assert.equal(gone[inZone].mode, 'locked');
  assert.ok(gone.slice(inZone).every(f => distanceToRoads(f.pose, roads) < 6));
  const jump = Math.hypot(gone[inZone].pose.x - gone[inZone - 1].pose.x, gone[inZone].pose.z - gone[inZone - 1].pose.z);
  assert.ok(jump < 4 * DT + 0.01, `jumped ${jump} m`);
});

test('applyHold keeps a car in its circle and stops it getting farther out', () => {
  const hold = { x: 0, z: 0, radius: 6 };
  assert.deepEqual(applyHold(hold, { x: 0, z: 0 }, { x: 3, z: 0 }), { x: 3, z: 0, held: false });
  const pulled = applyHold(hold, { x: 5.9, z: 0 }, { x: 7, z: 0 });
  assert.equal(pulled.held, true);
  near(pulled.x, 6);
  // Already outside (it came in from a few meters away): moving in is fine, moving out is stopped where it was.
  assert.equal(applyHold(hold, { x: 9, z: 0 }, { x: 8, z: 0 }).held, false);
  const pinned = applyHold(hold, { x: 9, z: 0 }, { x: 10, z: 0 });
  assert.equal(pinned.held, true);
  near(pinned.x, 9);
});

test('a road that leaves a zone and loops back does not catch the car while it drives away', () => {
  // A lollipop: a stem ends at N = (0, 30), and a loop starts and ends there, so N is a junction. The loop's
  // first leg runs away from N, but the road does come back to N 70 m later, which is within the 80 m the lock looks ahead.
  const stem: Road = { highway: 'service', coords: [[0, 0], [0, 30]] };
  const loop: Road = { highway: 'service', coords: [[0, 30], [10, 30], [10, 45], [-10, 45], [-10, 30], [0, 30]] };
  const graph = zonedGraphOf([stem, loop]);
  const zone = centerOf(graph, [0, 30]);
  const speed = 25;
  const lock = createRoadLock();
  const start = lock.engage({ x: 10, z: -32, heading: headingXY(0, 1) }, graph)!; // on the first leg, driving north, away from N
  assert.ok(Math.hypot(start.x - zone.x, start.z - zone.z) < zone.radius + speed * ENTER_LOOKAHEAD, 'not within the old capture distance: nothing to test');
  const frames = ride(lock, graph, start, [{ speed, seconds: 1 }]);
  assert.ok(frames.every(f => f.mode === 'locked'), 'a car driving away from the zone was caught by it');
});

test('the event hook reports zone captures and exits and changes nothing about the car', () => {
  const graph = zonedGraphOf(AREA);
  const start = { x: 19, z: -47, heading: headingXY(-7, -25) };
  const phases: Phase[] = [{ speed: 4, seconds: 4 }, { speed: 4, steer: 1, seconds: 3 }, { speed: 4, seconds: 3 }]; // through the T, out the left exit
  const quiet = createRoadLock();
  const plain = ride(quiet, graph, quiet.engage(start, graph)!, phases);

  const events: { kind: string; data: Record<string, number | string | null> }[] = [];
  const heard = createRoadLock({ onEvent: (kind, data) => events.push({ kind, data }) });
  const watched = ride(heard, graph, heard.engage(start, graph)!, phases);

  assert.deepEqual(events.map(e => e.kind), ['engage', 'capture', 'target', 'exit']);
  const [, capture, , exit] = events;
  assert.ok(Number(capture.data.carDist) <= Number(capture.data.zoneR) + Number(capture.data.lookahead));
  assert.ok(Number(exit.data.out) > Number(exit.data.zoneR));
  assert.ok(Math.abs(Number(exit.data.candHeading) - Math.PI * 74 / 180) < 0.1 && exit.data.candFlow === 'both');
  plain.forEach((f, i) => { near(f.pose.x, watched[i].pose.x, 1e-12); near(f.pose.z, watched[i].pose.z, 1e-12); });

  // inspect fills a reusable object with the lock's state, for the recorder.
  const view = { active: 0, mode: 0, hold: 0, candHeading: 0, candFlow: 0, zoneX: 0, zoneZ: 0, zoneR: 0, trackAx: 0, trackAz: 0,
    trackBx: 0, trackBz: 0, trackT: 0, trackDir: 0, heading: 0, lateral: 0, offLen: 0, ease: 0, lastZoneR: 0 };
  heard.inspect(view);
  assert.equal(view.active, 1);
  assert.equal(view.mode, 0);
  assert.ok(Number.isFinite(view.trackT));
  assert.equal(view.lastZoneR, 0); // well clear of the zone it left by now, so the just-left guard is off
});

// ---------------------------------------------------------------------------------------------
// TN-37: choosing the next turn before the junction.

interface TurnFrame { t: number; pose: Pose; speed: number; mode: 'locked' | 'free'; cap: number | undefined; arrow: boolean; intent: Side | null; auto: number | null; exitDeg: number | null }

/**
 * Drives the lock the way carController does with Stick to roads on: a cruise speed (the player's W), the speed cap
 * brakes at 6 m/s² and W can't push past it, and a free car steers by hand (`manual`, +1 is A) or lets auto-steer do it.
 * `on` runs before each frame, for key presses and taps.
 */
function rideTurn(lock: RoadLock, graph: RoadGraph, start: Pose, cruise: number, seconds: number,
  { on, manual }: { on?: (t: number, lock: RoadLock) => void; manual?: (t: number) => number } = {}): TurnFrame[] {
  const frames: TurnFrame[] = [];
  let pose: Pose = { ...start };
  let speed = cruise;
  for (let i = 0; i * DT < seconds - 1e-9; i++) {
    const t = i * DT;
    on?.(t, lock);
    let auto: number | null = null;
    const before = speed;
    speed = Math.min(cruise, speed + 14 * DT);
    const cap = lock.speedCap;
    if (cap !== undefined && speed > cap) speed = Math.max(cap, Math.min(speed, before - CAP_BRAKE * DT));
    if (lock.mode === 'locked') {
      const next = lock.step(pose, speed, DT, graph);
      pose = { x: next.x, z: next.z, heading: next.heading };
      speed = next.speed;
    } else {
      let steer = manual?.(t) ?? 0;
      lock.steerHeld(steer !== 0);
      if (steer === 0) { auto = lock.autoSteer(pose, speed); steer = auto ?? 0; }
      const before = { x: pose.x, z: pose.z };
      pose = { ...pose, heading: pose.heading + steer * DT * 2.2 * Math.max(-1, Math.min(1, speed / 8)) };
      pose.x += Math.sin(pose.heading) * speed * DT;
      pose.z += Math.cos(pose.heading) * speed * DT;
      if (lock.hold) {
        const held = applyHold(lock.hold, before, pose);
        if (held.held) { pose.x = held.x; pose.z = held.z; speed = 0; }
      }
      lock.observe(pose, speed, DT, graph);
    }
    const arrow = lock.arrow();
    frames.push({ t, pose: { ...pose }, speed, mode: lock.mode, cap: lock.speedCap, arrow: arrow !== null, intent: lock.intent, auto,
      exitDeg: arrow ? Math.round((arrow.heading * 180) / Math.PI) : null });
  }
  return frames;
}

const deg = (degrees: number) => (degrees * Math.PI) / 180;
const SOUTH_ON_SERVICE: Pose = { x: 19, z: -47, heading: headingXY(-7, -25) }; // on the service road, heading south toward the T and the crossing
/** The exit's heading in degrees, rounded: how the tests name an exit. */
const named = (target: ReturnType<typeof pickTarget>) => (target ? Math.round((target.exit.heading * 180) / Math.PI) : null);

test('left, right and none pick the expected exit at the crossing, and never a one-way-in exit', () => {
  const graph = zonedGraphOf(AREA);
  const zone = centerOf(graph, [0, 0]);
  const approach = headingXY(-9, -15); // down the service road from the north: exits at 56 deg (east) and -131 deg (south-west)
  assert.equal(named(pickTarget(zone, approach, 'left')), 56);
  assert.equal(named(pickTarget(zone, approach, 'right')), -131);
  // No straight exit, so with no turn asked for the smallest turn wins: 87 deg left against 100 deg right.
  assert.equal(named(pickTarget(zone, approach, null)), 56);
  for (const intent of ['left', 'right', null] as const) {
    for (const heading of [0, 1, 2, 3, -1, -2]) assert.notEqual(pickTarget(zone, heading, intent)?.exit.flow, 'in');
  }
  assert.equal(pickTarget(centerOf(graph, [25, -2]), 0, null), null); // a dead end has no target unless a turn is asked for
});

test('a T taken from its stem with no intent turns to the smallest-angle exit', () => {
  const graph = zonedGraphOf(AREA);
  const zone = centerOf(graph, [12, 22]);
  const fromTheSideRoad = headingXY(-7, 2); // heading west into the T from the service road to the east
  const target = pickTarget(zone, fromTheSideRoad, null)!;
  assert.equal(named(target), -23); // 83 deg left, against 101 deg right
  assert.equal(target.byIntent, false);
  // Straight on is taken when there is one.
  assert.equal(named(pickTarget(zone, headingXY(-3, -10), null)), -23);
});

test('the queued turn survives plain joins, goes to the next zone and clears when it is used', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  const frames = rideTurn(lock, graph, start, 8, 8, { on: (t, l) => { if (t === 0) l.press('left'); } });
  assert.equal(frames[0].intent, 'left');
  const entered = firstFree(frames as never);
  assert.ok(entered > 0 && frames[entered].intent === 'left', 'the intent is still queued when the T catches the car');
  const left = frames.findIndex((f, i) => i > entered && f.mode === 'locked');
  assert.ok(left > 0, 'the car left the T');
  assert.equal(frames[left].intent, null, 'used up by the T');
});

test('pressing the opposite key cancels the intent, the same key keeps it', () => {
  const lock = createRoadLock();
  const graph = zonedGraphOf(AREA);
  lock.engage(SOUTH_ON_SERVICE, graph);
  lock.press('left');
  assert.equal(lock.intent, 'left');
  lock.press('left');
  assert.equal(lock.intent, 'left');
  lock.press('right');
  assert.equal(lock.intent, null);
  lock.press('right');
  assert.equal(lock.intent, 'right');
  lock.disengage();
  assert.equal(lock.intent, null);
});

test('an intent with no exit on that side stays queued for the next zone', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  // The T has no exit on the right, so the car goes straight on; the turn waits for the crossing.
  const frames = rideTurn(lock, graph, start, 8, 6, { on: (t, l) => { if (t === 0) l.press('right'); } });
  const first = firstFree(frames as never);
  const out = frames.findIndex((f, i) => i > first && f.mode === 'locked');
  assert.ok(first > 0 && out > first);
  assert.equal(frames[out].intent, 'right');
  assert.ok(distanceToRoads(frames[out + 10].pose, [SERVICE_NORTH]) < 2.5 && frames[out + 10].pose.z > -22, 'went straight on, south along the service road');
  assert.equal(pickTarget(centerOf(graph, [12, 22]), headingXY(-3, -4), 'right')?.byIntent, false);
});

test('auto-steer leaves the zone on the target exit at the turn speed', () => {
  const graph = zonedGraphOf(AREA);
  for (const [side, road] of [['left', SERVICE_T]] as const) {
    const lock = createRoadLock();
    const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
    const frames = rideTurn(lock, graph, start, 14, 8, { on: (t, l) => { if (t === 0) l.press(side); } });
    const first = firstFree(frames as never);
    const out = frames.findIndex((f, i) => i > first && f.mode === 'locked');
    assert.ok(first > 0 && out > first, 'entered and left the zone');
    const turnSpeed = frames[first].cap!; // the speed of the route through the T
    assert.ok(turnSpeed >= ROUTE_SPEED_MIN && turnSpeed <= ROUTE_SPEED_MAX, `${turnSpeed * 3.6} km/h`);
    assert.ok(frames[first].speed <= turnSpeed + 0.25, `entered at ${frames[first].speed * 3.6} km/h`);
    assert.ok(frames[out].speed <= turnSpeed + 0.05, `left at ${frames[out].speed * 3.6} km/h`);
    // Out of the zone it is on the side road, in the right-hand lane.
    const later = frames[Math.min(frames.length - 1, out + 10)].pose;
    assert.ok(distanceToRoads(later, [road]) < 2.5, `${distanceToRoads(later, [road])} m from the side road`);
    assert.ok(Math.abs(rightOfRoad(later, road) - 1) < 0.35, `lane ${rightOfRoad(later, road)}`);
  }
});

test('the steer sign: a route curving left asks for +1 (A), curving right for -1 (D)', () => {
  // A car at the origin facing south (heading 0, forward is +z); east is to its left.
  const car = { x: 0, z: 0, heading: 0 };
  const left = pursue([{ x: 0, z: 0 }, { x: 0, z: 4 }, { x: 8, z: 8 }], car, 0, 5, 2.5);
  const right = pursue([{ x: 0, z: 0 }, { x: 0, z: 4 }, { x: -8, z: 8 }], car, 0, 5, 2.5);
  assert.ok(left.steer > 0 && right.steer < 0, `${left.steer} ${right.steer}`);
  assert.ok(Math.abs(left.steer) <= 1 && Math.abs(right.steer) <= 1);
  // Dead ahead is no steer at all.
  assert.ok(Math.abs(pursue([{ x: 0, z: 0 }, { x: 0, z: 20 }], car, 0, 5, 2.5).steer) < 1e-9);
});

test('steering by hand pauses auto-steer and hides the arrow, and it comes back 0.4 s after the keys are let go', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  let enteredAt = -1;
  const released = () => enteredAt + 0.7;
  const frames = rideTurn(lock, graph, start, 8, 6, {
    on: (t, l) => { if (t === 0) l.press('left'); if (l.mode === 'free' && enteredAt < 0) enteredAt = t; },
    manual: t => (enteredAt >= 0 && t >= enteredAt + 0.2 && t < released() ? -1 : 0), // D held from 0.2 s to 0.7 s into the zone
  });
  const inZone = frames.filter(f => f.mode === 'free');
  assert.ok(inZone.length > 20);
  // Before the keys: auto-steer is on and the arrow shows the left turn.
  assert.ok(frames.filter(f => f.mode === 'free' && f.t >= enteredAt && f.t < enteredAt + 0.2).every(f => f.auto !== null && f.arrow));
  // Held: no auto-steer, no arrow.
  const held = frames.filter(f => f.mode === 'free' && f.t >= enteredAt + 0.25 && f.t < released());
  assert.ok(held.length > 5 && held.every(f => f.auto === null && !f.arrow));
  // Let go: still manual for 0.4 s, then auto-steer is back.
  const wait = frames.filter(f => f.mode === 'free' && f.t > released() + DT && f.t < released() + 0.35);
  assert.ok(wait.length > 3 && wait.every(f => f.auto === null && !f.arrow), 'the wheel stays free for 0.4 s');
  const back = frames.find(f => f.mode === 'free' && f.t >= released() + 0.45);
  assert.ok(back && back.auto !== null, 'auto-steer is back');
  // Steering right for half a second turned the car about 54 degrees toward the straight road, which is now the exit it points at.
  const end = frames[frames.length - 1].pose;
  assert.ok(distanceToRoads(end, [SERVICE_NORTH]) < 2.5 && -end.z < 18, 'left the T on the straight road, not the side road');
  assert.equal(lock.intent, null);
});

test('a tap in the zone moves the target one exit left or right and stops at the ends', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  // The T's exits seen from the south-bound approach, sharpest left to sharpest right: 153 deg (back north), 74 deg
  // (east) and -23 deg (straight on, no arrow: it is under a 30 degree turn). With a left turn queued the target is 74.
  const taps: Side[] = ['left', 'left', 'right', 'right', 'right'];
  const tappedAt: number[] = [];
  let enteredAt = -1;
  const frames = rideTurn(lock, graph, start, 5, 8, {
    on: (t, l) => {
      if (t === 0) l.press('left');
      if (l.mode !== 'free') return;
      const frame = Math.round(t / DT);
      if (enteredAt < 0) enteredAt = frame;
      const k = (frame - enteredAt - 1) / 2;
      if (k >= 0 && Number.isInteger(k) && k < taps.length) { l.tap(taps[k]); tappedAt.push(frame); }
    },
  });
  assert.equal(tappedAt.length, taps.length);
  assert.equal(frames[enteredAt - 1 + 1].exitDeg, 74); // the target before any tap
  // Heading of the lane where the exit's road crosses the zone edge, a few degrees off the branch heading.
  const shown = tappedAt.map(i => frames[i].exitDeg);
  assert.deepEqual(shown.map(d => d === null ? null : Math.abs(d - 153) < 12 ? 153 : d), [153, 153, 74, null, null]);
  assert.ok(tappedAt.every(i => frames[i].mode === 'free'), 'still deciding in the zone through every tap');
});

test('with no keys the car passes the T straight on and takes the smallest turn at the crossing', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  const frames = rideTurn(lock, graph, start, 14, 12);
  const end = frames[frames.length - 1].pose;
  assert.ok(distanceToRoads(end, [JABOTINSKY_EAST]) < 2.5, `${distanceToRoads(end, [JABOTINSKY_EAST])} m from eastbound Jabotinsky`);
  assert.ok(Math.abs(rightOfRoad(end, JABOTINSKY_EAST)) < 0.4, 'on the center line of the one-way road');
});

test('tapping before the crossing picks the carriageway on that side, and never drives one against its direction', () => {
  const graph = zonedGraphOf(AREA);
  for (const [side, road, other] of [['right', JABOTINSKY_WEST, JABOTINSKY_EAST], ['left', JABOTINSKY_EAST, JABOTINSKY_WEST]] as const) {
    const lock = createRoadLock();
    const start = lock.engage({ x: 9, z: -14, heading: headingXY(-9, -15) }, graph)!; // on the service road, just before the crossing
    const frames = rideTurn(lock, graph, start, 12, 10, { on: (t, l) => { if (t === 0) l.press(side); } });
    const outAt = frames.findIndex((f, i) => i > firstFree(frames as never) && f.mode === 'locked');
    const onRoad = frames.slice(outAt).filter(f => distanceToRoads(f.pose, [road]) < 2.5 && distanceToRoads(f.pose, [other]) > 5);
    assert.ok(onRoad.length > 20, `${side}: drove along its carriageway (${onRoad.length} frames)`);
    assert.ok(frames.some(f => f.mode === 'free'), 'went through the crossing as a zone');
  }
});

test('leaving a zone runs the lookahead at once, and the turn speed stays through a gap under 40 m', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  // The T and the crossing are about 14 m apart along the service road.
  const frames = rideTurn(lock, graph, start, 14, 16);
  const out = frames.findIndex((f, i) => i > firstFree(frames as never) && f.mode === 'locked');
  assert.ok(out > 0);
  assert.equal(frames[out + 1].arrow, true, 'the crossing is already targeted a frame after the T');
  assert.ok(Math.abs(frames[out + 1].exitDeg! - 50) <= 1, `smallest turn at the crossing: east, ${frames[out + 1].exitDeg}`); // the lane heading where the carriageway crosses the zone edge
  assert.ok(frames[out].cap !== undefined && frames[out + 1].cap !== undefined, 'a cap goes on through the gap');
  assert.ok(frames[out + 6].speed < frames[out].speed, 'braking through the gap');
  const second = frames.findIndex((f, i) => i > out && f.mode === 'free');
  // Braking is gentle (6 m/s²), so a 14 m gap isn't enough to get from 50 to 25 km/h; the cap holds on through the crossing.
  assert.ok(second > out && frames[second].speed < frames[out].speed - 4, `${frames[second]?.speed * 3.6} km/h entering the crossing`);
  const done = frames.findIndex((f, i) => i > second && f.mode === 'locked');
  assert.ok(done > second && frames[done].speed <= frames[second].cap! + 0.05, `${frames[done]?.speed * 3.6} km/h leaving it`);
});

test('the cap lifts after a gap longer than 40 m, and the car speeds up again', () => {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: 9, z: -14, heading: headingXY(-9, -15) }, graph)!;
  const frames = rideTurn(lock, graph, start, 14, 8, { on: (t, l) => { if (t === 0) l.press('left'); } });
  const out = frames.findIndex((f, i) => i > firstFree(frames as never) && f.mode === 'locked');
  assert.ok(out > 0);
  assert.equal(frames[out + 1].cap, undefined);
  assert.ok(frames[frames.length - 1].speed > 13, `${frames[frames.length - 1].speed} m/s at the end`);
});

test('the turn speed is reached at the zone edge: braking starts at the braking distance', () => {
  const graph = zonedGraphOf(AREA);
  const zone = centerOf(graph, [12, 22]);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  const frames = rideTurn(lock, graph, start, 14, 6, { on: (t, l) => { if (t === 0) l.press('left'); } });
  assert.equal(frames[0].cap, undefined, 'far from the turn the car is not slowed');
  const braking = frames.findIndex(f => f.cap !== undefined);
  assert.ok(braking > 0);
  const f = frames[braking];
  const toEdge = Math.hypot(f.pose.x - zone.x, f.pose.z - zone.z) - zone.radius;
  const wanted = brakingDistance(f.speed, f.cap!) + 2;
  assert.ok(Math.abs(toEdge - wanted) < 3, `started ${toEdge} m from the edge, wanted about ${wanted}`);
  const entered = firstFree(frames as never);
  assert.ok(frames[entered].speed <= f.cap! + 0.3, `${frames[entered].speed * 3.6} km/h at the zone edge`);
});

// ---------------------------------------------------------------------------------------------
// The route through a roundabout follows the ring.

/** The path of the arrow the lock shows on the first frame it shows one, for a car coming down Moshe Dayan to the roundabout. */
function roundaboutArrow(intent: Side | null) {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage({ x: -40, z: -83, heading: headingXY(-5, -20) }, graph)!;
  let found: ReturnType<RoadLock['arrow']> = null;
  let path: { x: number; z: number }[] = [];
  rideTurn(lock, graph, start, 10, 3, {
    on: (t, l) => {
      if (t === 0 && intent) l.press(intent);
      const arrow = l.arrow();
      if (!found && arrow) { found = arrow; path = arrow.path; }
    },
  });
  assert.ok(found, 'the roundabout shows an arrow');
  return path;
}

test('the arrow through a roundabout follows the ring in its direction, not straight across the island', () => {
  for (const intent of ['left', 'right', null] as const) {
    const path = roundaboutArrow(intent);
    const first = path[0], last = path[path.length - 1];
    // Every point of the arrow is on the ring road, except the stretches that are still on the roads leading in and out.
    const off = path.filter(p => Math.hypot(p.x - first.x, p.z - first.z) > 8 && Math.hypot(p.x - last.x, p.z - last.z) > 8)
      .map(p => distanceToRoads({ x: p.x, z: p.z, heading: 0 }, [ROUNDABOUT]));
    assert.ok(Math.max(0, ...off) < 3.5, `${intent}: the arrow strays ${Math.max(0, ...off).toFixed(1)} m from the ring`);
  }
});

const centerOfNearest = (graph: RoadGraph, p: { x: number; z: number }) =>
  graph.zones.reduce((best, z) => (Math.hypot(z.x - p.x, z.z - p.z) - z.radius < Math.hypot(best.x - p.x, best.z - p.z) - best.radius ? z : best));

const distanceToPath = (p: { x: number; z: number }, path: { x: number; z: number }[]) => {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1], dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
    const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2));
    best = Math.min(best, Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t)));
  }
  return best;
};

test('the roundabout arrow runs around the ring the way its one-way traffic goes', () => {
  for (const intent of ['left', 'right', null] as const) {
    const path = roundaboutArrow(intent);
    const ring = ROUNDABOUT.coords.map(([x, y]) => ({ x, z: -y }));
    let ringMeters = 0;
    for (let i = 0; i < path.length - 1; i++) {
      const mid = { x: (path[i].x + path[i + 1].x) / 2, z: (path[i].z + path[i + 1].z) / 2 };
      // The ring segment under this stretch of the arrow, and whether the arrow runs along it.
      let best = Infinity, along = 0;
      for (let k = 0; k < ring.length - 1; k++) {
        const d = distanceToPath(mid, [ring[k], ring[k + 1]]);
        if (d < best) { best = d; along = (ring[k + 1].x - ring[k].x) * (path[i + 1].x - path[i].x) + (ring[k + 1].z - ring[k].z) * (path[i + 1].z - path[i].z); }
      }
      const atMember = [[-49, 55], [-63, 48], [-54, 33], [-42, 41]].some(([x, y]) => Math.hypot(mid.x - x, mid.z + y) < 4); // where the roads in and out join the ring
      if (best < 1.5 && !atMember) { ringMeters += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z); assert.ok(along > 0, `${intent}: runs against the ring at ${mid.x.toFixed(1)}, ${mid.z.toFixed(1)}`); }
    }
    assert.ok(ringMeters > 5, `${intent}: only ${ringMeters.toFixed(1)} m of the arrow is on the ring`);
  }
});

test('auto-steer drives the drawn arrow: the car stays on it through every turn and leaves on its exit', () => {
  const graph = zonedGraphOf(AREA);
  const cases: { name: string; start: Pose; intent: Side | null; exits: Road[] }[] = [
    { name: 'roundabout left', start: { x: -40, z: -83, heading: headingXY(-5, -20) }, intent: 'left', exits: [JABOTINSKY_EAST] },
    { name: 'roundabout right', start: { x: -40, z: -83, heading: headingXY(-5, -20) }, intent: 'right', exits: [JABOTINSKY_NW] },
    { name: 'roundabout straight on', start: { x: -40, z: -83, heading: headingXY(-5, -20) }, intent: null, exits: [JABOTINSKY_EAST, JABOTINSKY_NW, MOSHE_DAYAN] },
    { name: 'T left', start: SOUTH_ON_SERVICE, intent: 'left', exits: [SERVICE_T] },
    { name: 'crossing left', start: { x: 9, z: -14, heading: headingXY(-9, -15) }, intent: 'left', exits: [JABOTINSKY_EAST] },
    { name: 'crossing right', start: { x: 9, z: -14, heading: headingXY(-9, -15) }, intent: 'right', exits: [JABOTINSKY_WEST] },
  ];
  for (const c of cases) {
    const lock = createRoadLock();
    const start = lock.engage(c.start, graph)!;
    let drawn: { x: number; z: number }[] | null = null;
    const frames = rideTurn(lock, graph, start, 14, 30, {
      on: (t, l) => { if (t === 0 && c.intent) l.press(c.intent); if (l.mode === 'free' && !drawn && l.arrow()) drawn = [...l.arrow()!.path]; },
    });
    assert.ok(drawn, `${c.name}: an arrow was drawn`);
    const first = firstFree(frames as never), out = frames.findIndex((f, i) => i > first && f.mode === 'locked');
    const zoneOf = centerOfNearest(graph, frames[first].pose);
    const inZone = frames.slice(first, out).filter(f => Math.hypot(f.pose.x - zoneOf.x, f.pose.z - zoneOf.z) <= zoneOf.radius); // inside the first zone's circle
    let worst = 0;
    for (const f of inZone) worst = Math.max(worst, distanceToPath(f.pose, drawn!));
    assert.ok(worst < 1, `${c.name}: the car strays ${worst.toFixed(2)} m from the arrow`);
    assert.ok(out > first, `${c.name}: left the zone`);
    const later = frames[Math.min(frames.length - 1, out + 12)].pose;
    assert.ok(c.exits.some(r => distanceToRoads(later, [r]) < 2.5), `${c.name}: left on the wrong road`);
  }
});

// ---------------------------------------------------------------------------------------------
// U-turns at dead ends.

/** From the service road south into the T, left to the side road, which ends in a dead end; a turn is queued for each. */
function deadEndRide(second: Side | null, seconds = 22) {
  const graph = zonedGraphOf(AREA);
  const lock = createRoadLock();
  const start = lock.engage(SOUTH_ON_SERVICE, graph)!;
  let leftT = false, sawFree = false;
  let drawn: { x: number; z: number }[] | null = null;
  let zoneAt = { x: 0, z: 0, radius: 0 };
  const frames = rideTurn(lock, graph, start, 10, seconds, {
    on: (t, l) => {
      if (t === 0) l.press('left');
      if (l.mode === 'free') sawFree = true;
      if (l.mode === 'locked' && !leftT && sawFree) { leftT = true; if (second) l.press(second); } // out of the T: queue the turn for the dead end
      if (l.mode === 'free' && leftT && !drawn && l.arrow()) { drawn = [...l.arrow()!.path]; zoneAt = centerOfNearest(graph, { x: 25, z: 2 }); }
    },
  });
  return { frames, drawn: drawn as { x: number; z: number }[] | null, zoneAt, lock, graph };
}

test('a turn queued before a dead end draws a U and drives it, coming back out the way it went in', () => {
  for (const side of ['left', 'right'] as const) {
    const { frames, drawn, zoneAt } = deadEndRide(side);
    assert.ok(drawn, `${side}: an arrow is drawn at the dead end`);
    // The arrow goes in and comes back out: it ends heading the opposite way, in the lane on the other side of the road.
    const start = drawn![0], end = drawn![drawn!.length - 1];
    assert.ok(Math.hypot(end.x - start.x, end.z - start.z) < 8, `${side}: a U (${Math.hypot(end.x - start.x, end.z - start.z).toFixed(1)} m between its ends)`);
    const inside = frames.filter(f => Math.hypot(f.pose.x - zoneAt.x, f.pose.z - zoneAt.z) <= zoneAt.radius && f.mode === 'free');
    assert.ok(inside.length > 10);
    assert.ok(Math.max(...inside.map(f => f.speed)) <= TURN_AROUND_CAP + 0.35, `${side}: crawls through the U (${(Math.max(...inside.map(f => f.speed)) * 3.6).toFixed(0)} km/h)`);
    const worst = Math.max(...inside.map(f => distanceToPath(f.pose, drawn!)));
    assert.ok(worst < 1.1, `${side}: the car strays ${worst.toFixed(2)} m from the U`);
    // Out of the dead end the car is on the side road again, going back toward the T, in its right-hand lane.
    const out = frames.findIndex((f, i) => i > 0 && f.mode === 'locked' && frames[i - 1].mode === 'free' && Math.hypot(f.pose.x - zoneAt.x, f.pose.z - zoneAt.z) < 12 && f.t > 5);
    assert.ok(out > 0, `${side}: left the dead end`);
    const back = frames[Math.min(frames.length - 1, out + 20)].pose;
    assert.ok(distanceToRoads(back, [SERVICE_T]) < 2.5, `${side}: back on the side road`);
    assert.ok(Math.abs(Math.abs(rightOfRoad(back, SERVICE_T)) - 1) < 0.4, `${side}: in a lane of the side road (${rightOfRoad(back, SERVICE_T).toFixed(2)})`);
    assert.ok(Math.cos(back.heading) < 0, `${side}: heading back north toward the T`); // z shrinks going north
  }
});

test('without a turn queued the car still stops at the dead end, and a turn asked for with no way back leaves it queued', () => {
  const { frames } = deadEndRide(null, 20);
  const last = frames[frames.length - 1];
  assert.equal(last.mode, 'free');
  assert.equal(last.speed, 0);
  // The U-turn target only exists with an intent.
  const graph = zonedGraphOf(AREA);
  const deadEnd = centerOf(graph, [25, -2]);
  assert.equal(pickTarget(deadEnd, headingXY(2, -18), null), null);
  const target = pickTarget(deadEnd, headingXY(2, -18), 'left')!;
  assert.ok(target.byIntent && Math.abs(Math.abs(target.turn) - Math.PI) < 0.3, `turn ${target.turn}`);
  assert.equal(pickTarget(deadEnd, headingXY(2, -18), 'right')!.exit, target.exit);
});

// ---------------------------------------------------------------------------------------------
// Turn speed from the route's curvature.

const arc = (radius: number, degrees: number) => Array.from({ length: Math.round(degrees) + 1 }, (_, i) => {
  const a = (i * Math.PI) / 180;
  return { x: radius * Math.sin(a), z: radius * (1 - Math.cos(a)) };
});

test('the route speed comes from its average radius, held down by its tightest kink', () => {
  for (const radius of [25, 40]) { near(tightestRadius(arc(radius, 90)), radius, radius * 0.03); near(averageRadius(arc(radius, 90)), radius, radius * 0.05); }
  assert.equal(tightestRadius([{ x: 0, z: 0 }, { x: 0, z: 30 }]), Infinity);
  assert.equal(averageRadius([{ x: 0, z: 0 }, { x: 0, z: 30 }]), Infinity);
  near(routeSpeed(arc(25, 90)) * 3.6, Math.sqrt(6 * 25) * 3.6, 2);   // 44 km/h round a 25 m bend
  assert.ok(routeSpeed(arc(10, 90)) < routeSpeed(arc(25, 90)), 'tighter is slower');
  assert.equal(routeSpeed(arc(2, 90)), ROUTE_SPEED_MIN);             // tight: never below 15 km/h
  assert.equal(routeSpeed(arc(200, 40)), ROUTE_SPEED_MAX);           // wide open: 50 km/h
  assert.equal(routeSpeed([{ x: 0, z: 0 }, { x: 0, z: 30 }]), ROUTE_SPEED_MAX);
  // A gentle bend with one sharp kink in it is held down by the kink.
  const kinked = [...arc(60, 30), ...arc(6, 90).slice(1).map(p => ({ x: p.x + 30, z: p.z + 8 }))];
  assert.ok(routeSpeed(kinked) < Math.sqrt(6 * averageRadius(kinked)), 'the kink, not the average, sets the speed');
});

test('a wide roundabout is taken faster than a tight T, and a turn that is not one has no cap', () => {
  const graph = zonedGraphOf(AREA);
  const speedAt = (start: Pose, intent: Side | null, from: number) => {
    const lock = createRoadLock();
    const first = lock.engage(start, graph)!;
    const frames = rideTurn(lock, graph, first, 14, 8, { on: (t, l) => { if (t === 0 && intent) l.press(intent); } });
    return frames.slice(from).find(f => f.mode === 'free')?.cap;
  };
  const tight = speedAt(SOUTH_ON_SERVICE, 'left', 0);                                   // the T: 5 m radius zone
  const ring = speedAt({ x: -40, z: -83, heading: headingXY(-5, -20) }, 'right', 0);    // the 4-junction roundabout
  assert.ok(tight !== undefined && ring !== undefined);
  assert.ok(ring! >= tight!, `${ring! * 3.6} km/h round, ${tight! * 3.6} km/h at the T`);
  assert.equal(speedAt(SOUTH_ON_SERVICE, null, 0), undefined, 'straight on through the T: no cap');
});
