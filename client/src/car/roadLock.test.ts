import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREA, JABOTINSKY_EAST, JABOTINSKY_NW, JABOTINSKY_WEST, SERVICE_NORTH, SERVICE_T, graphOf as zonedGraphOf, junctionsOf, segmentsOf, type Road } from '../town/roadFixtures.ts';
import { createRoadGraph, toWorldJunctions, type RoadGraph } from '../town/roadGraph.ts';
import { onewayOf } from '../town/roadStyles.ts';
import { applyHold, createRoadLock, ENTER_LOOKAHEAD, EXIT_MARGIN, LANE_OFFSET, type Pose, type RoadLock } from './roadLock.ts';

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
