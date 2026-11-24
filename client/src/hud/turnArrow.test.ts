import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARROW_TAIL, arrowPath, buildArrowArrays, HEAD, SAMPLES } from './turnArrow.ts';

// A zone of radius 10 at the origin; x east, z south. The car comes in from the south heading north (heading PI faces
// (0, -1)) and its lane is on its right, east of the center line.
const NORTH = Math.PI, EAST = Math.PI / 2, WEST = -Math.PI / 2;
const entry = { x: 1.75, z: 10, heading: NORTH };
const eastExit = { x: 10, z: 1.75, heading: EAST };   // lane right of an east-facing car is south of the center line
const westExit = { x: -10, z: -1.75, heading: WEST };

const centerDistance = (p: { x: number; z: number }) => Math.hypot(p.x, p.z);

test('arrowPath starts at the entry lane point and ends 2.6 m past the exit lane point', () => {
  for (const exit of [eastExit, westExit]) {
    const path = arrowPath(entry, exit);
    assert.equal(path.length, SAMPLES + 2);
    assert.deepEqual([path[0].x, path[0].z], [entry.x, entry.z]);
    const bend = path[SAMPLES];
    assert.ok(Math.hypot(bend.x - exit.x, bend.z - exit.z) < 1e-9, 'the curve ends on the exit lane point');
    const tail = path[SAMPLES + 1];
    assert.ok(Math.abs(Math.hypot(tail.x - exit.x, tail.z - exit.z) - ARROW_TAIL) < 1e-9);
    assert.ok(Math.abs(tail.x - (exit.x + Math.sin(exit.heading) * ARROW_TAIL)) < 1e-9);
  }
});

test('arrowPath bends inside the corner for a right turn and wide, through the middle, for a left turn', () => {
  const right = arrowPath(entry, eastExit).slice(0, SAMPLES + 1);
  const left = arrowPath(entry, westExit).slice(0, SAMPLES + 1);
  // The lane lines of a right turn cross at (1.75, 1.75), the corner of the junction: the curve stays inside it.
  assert.ok(right.every(p => p.x >= 1.75 - 1e-9 && p.z >= 1.75 - 1e-9), 'right turn stays on the near side of the corner');
  assert.ok(centerDistance(right[SAMPLES / 2]) > 4, `${centerDistance(right[SAMPLES / 2])} m from the center`);
  // The left turn's lines cross at (1.75, -1.75), beyond the middle: the curve swings wide through it.
  assert.ok(centerDistance(left[SAMPLES / 2]) < 2.5, `${centerDistance(left[SAMPLES / 2])} m from the center`);
  assert.ok(left.some(p => p.z < 0) && left.every(p => p.x <= 1.75 + 1e-9));
});

test('arrowPath falls back to a cubic when the lane lines do not cross ahead', () => {
  // Straight on: the lines are parallel and never cross.
  const straight = arrowPath(entry, { x: 1.75, z: -10, heading: NORTH });
  assert.equal(straight.length, SAMPLES + 2);
  assert.ok(straight.every(p => Math.abs(p.x - 1.75) < 1e-9), 'a straight line');
  // A U-turn: back along the other lane. The lines are parallel again; the cubic keeps the curve a smooth, finite loop.
  const uTurn = arrowPath(entry, { x: -1.75, z: 10, heading: 0 });
  assert.ok(uTurn.every(p => Number.isFinite(p.x) && Number.isFinite(p.z)));
  assert.ok(Math.min(...uTurn.map(p => p.z)) < 10, 'it goes into the junction and comes back');
  // The lines cross, but behind the entry: an exit that is not ahead of the car.
  const behind = arrowPath({ x: 0, z: 0, heading: NORTH }, { x: 0, z: 5, heading: EAST });
  assert.ok(behind.every(p => Number.isFinite(p.x) && Number.isFinite(p.z)));
});

test('buildArrowArrays makes one mesh: three ribbons and a double head, all arrays the same length', () => {
  const path = arrowPath(entry, eastExit);
  const arrays = buildArrowArrays(path, EAST, 0.1);
  const vertices = path.length * 2 * 3 + 6;
  assert.equal(arrays.along.length, vertices);
  assert.equal(arrays.core.length, vertices);
  assert.equal(arrays.positions.length, vertices * 3);
  assert.equal(arrays.colors.length, vertices * 4);
  assert.equal(arrays.indices.length, (path.length - 1) * 6 * 3 + 6);
  assert.ok(arrays.indices.every(i => i >= 0 && i < vertices));
  // Only the thin white layer is the flowing core.
  assert.equal(arrays.core.filter(v => v === 1).length, path.length * 2);
  // Everything sits at the given height, and the head tip is 2.4 m past the path's end along the exit.
  assert.ok(arrays.positions.filter((_, i) => i % 3 === 1).every(y => y === 0.1));
  const end = path[path.length - 1];
  const tip = arrays.positions.slice(-6, -3); // the solid head's tip vertex
  assert.ok(Math.abs(tip[0] - (end.x + HEAD.length)) < 1e-9 && Math.abs(tip[2] - end.z) < 1e-9);
  // The along distance grows along the ribbon.
  const body = arrays.along.slice(0, path.length * 2);
  assert.ok(body.every((v, i) => i < 2 || v >= body[i - 2]));
});
