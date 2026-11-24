import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Maneuver, Route, RouteRequest } from '@town-navigator/shared';
import { createNavigation, type NavView, type Pose } from './navigation.ts';
import { formatDistance, formatDuration, nextManeuvers, project, toWorldRoute, type WorldRoute } from './routeProgress.ts';

// The centre → library route's shown maneuvers (TN-38), laid along a straight road east from (0, 0): 2,802 m.
const LIBRARY: [number, Maneuver['turn'], number?][] = [
  [147.1, 'roundabout', 2], [561.9, 'slight_right'], [601, 'roundabout', 3], [1064.6, 'roundabout', 1],
  [1569.5, 'roundabout', 2], [2134.2, 'roundabout', 1], [2285.7, 'roundabout', 3], [2757.2, 'left'],
];
const maneuver = (along: number, turn: Maneuver['turn'], exit?: number, extra: Partial<Maneuver> = {}): Maneuver => ({
  nodes: [Math.round(along)], x: along, y: 0, along, inBearing: 90, outBearing: 90, angle: 0, turn,
  ...(exit ? { exit } : {}), road: `Road ${Math.round(along)}`, ...extra,
});
function straightRoute(length = 2802, maneuvers: Maneuver[] = LIBRARY.map(([a, t, e]) => maneuver(a, t, e))): Route {
  const points: [number, number][] = [];
  for (let x = 0; x <= length; x += 100) points.push([x, 0]);
  if (points.at(-1)![0] !== length) points.push([length, 0]);
  return {
    distance: length, points, stretches: [{ start: 0, highway: 'residential', oneway: false }],
    start: { x: 0, y: 0 }, destination: { x: length, y: 0 }, maneuvers,
  };
}
const EAST = Math.PI / 2; // heading of a car facing east (+x)
const flush = () => new Promise(resolve => setImmediate(resolve));

/** A fake server: each request waits until the test answers it. */
function fakeServer() {
  const calls: { body: RouteRequest; signal: AbortSignal; resolve(r: Route): void; reject(e: unknown): void }[] = [];
  const requestRoute = (body: RouteRequest, signal: AbortSignal) => new Promise<Route>((resolve, reject) => {
    calls.push({ body, signal, resolve, reject });
  });
  return { calls, requestRoute };
}
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

async function navigating(route = straightRoute()) {
  const server = fakeServer();
  let car: Pose = { x: 0, z: 0, heading: EAST };
  const nav = createNavigation({ requestRoute: server.requestRoute, pose: () => car });
  nav.start({ id: 'lib', name: 'Library', x: route.destination.x, y: route.destination.y });
  server.calls[0].resolve(route);
  await flush();
  const drive = (x: number, opts: { z?: number; heading?: number; speed?: number; seconds?: number } = {}) => {
    const { z = 0, heading = EAST, speed = 10, seconds = 0.1 } = opts;
    car = { x, z, heading };
    for (let t = 0; t < seconds - 1e-9; t += 0.1) nav.update(0.1, car, speed, 22);
  };
  return { nav, server, drive, setCar: (p: Pose) => { car = p; } };
}

test('toWorldRoute flips y to z and bearings to headings (0° north → heading π)', () => {
  const r = toWorldRoute({ ...straightRoute(200, [maneuver(100, 'left', undefined, { y: 30, inBearing: 0, outBearing: 270 })]), points: [[0, 0], [0, 200]] });
  assert.deepEqual(r.points, [{ x: 0, z: -0 }, { x: 0, z: -200 }]);
  assert.equal(r.cum[1], 200);
  assert.equal(r.maneuvers[0].wz, -30);
  assert.equal(r.maneuvers[0].inHeading, Math.PI);           // north: -z
  assert.ok(Math.abs(r.maneuvers[0].outHeading - (Math.PI - 1.5 * Math.PI)) < 1e-12); // west
});

test('project moves forward along the route and never jumps to a far parallel segment', () => {
  // 700 m east in 10 m segments, 10 m north, then back west: the way back runs 10 m north of the way out.
  const points: [number, number][] = [];
  for (let x = 0; x <= 700; x += 10) points.push([x, 0]);
  for (let x = 700; x >= 0; x -= 10) points.push([x, 10]);
  const r: WorldRoute = toWorldRoute({ ...straightRoute(), points, distance: 1410 });
  const out = project(r, 300, -6, 28);                        // 6 m north of the way out, 4 m south of the way back
  assert.equal(out.index, 29);                                 // segment 30 starts at x = 300; 29 ends there, found first
  assert.equal(out.along, 300);
  assert.equal(out.offset, 6);
  const back = project(r, 300, -6, 110);                      // already on the way back
  assert.ok(back.index >= 110);
  assert.ok(Math.abs(back.along - 1110) < 1e-9);
  assert.equal(back.offset, 4);
});

test('nextManeuver skips plain straights and keeps ambiguous ones', () => {
  const r = toWorldRoute(straightRoute(1000, [maneuver(100, 'straight'), maneuver(300, 'straight', undefined, { ambiguous: true }), maneuver(600, 'left')]));
  assert.equal(nextManeuvers(r, 0).next!.along, 300);
  assert.equal(nextManeuvers(r, 0).after!.along, 600);
  assert.equal(nextManeuvers(r, 303).next!.along, 300);       // within 5 m past it: still the current one
  assert.equal(nextManeuvers(r, 306).next!.along, 600);
  assert.equal(nextManeuvers(r, 700).next, undefined);
});

test('formatDistance: 25 → Now, 84 → 80 m, 562 → 550 m, 1065 → 1.1 km', () => {
  assert.deepEqual([25, 84, 562, 1065].map(formatDistance), ['Now', '80 m', '550 m', '1.1 km']);
  assert.deepEqual([30, 3600, 3900].map(formatDuration), ['< 1 min', '1 h 00 min', '1 h 05 min']);
  assert.equal(formatDuration(361), '7 min');
});

test('then-line only when the following maneuver is within 80 m (562 → 601 on the library route)', async () => {
  const { nav, drive } = await navigating();
  drive(40);
  let view = nav.view() as Extract<NavView, { kind: 'turn' }>;
  assert.equal(view.text, 'Roundabout, 2nd exit');
  assert.equal(view.road, 'Road 147');
  assert.ok(Math.abs(view.distance - 107.1) < 1e-6);
  assert.equal(view.then, undefined);
  assert.equal(view.destination, 'Library');
  assert.equal(view.left, 2762);
  drive(520);
  view = nav.view() as Extract<NavView, { kind: 'turn' }>;
  assert.equal(view.text, 'Slight right');
  assert.deepEqual(view.then, { glyph: '⟲', text: 'Roundabout, 3rd exit' });
  for (let x = 520; x <= 1300; x += 50) drive(x);              // forward: the projection only looks a little back
  view = nav.view() as Extract<NavView, { kind: 'turn' }>;
  assert.equal(view.text, 'Roundabout, 2nd exit');             // 1,569.5 m; the next is 565 m later: no then-line
  assert.equal(view.then, undefined);
  for (let x = 1300; x <= 2700; x += 50) drive(x);
  view = nav.view() as Extract<NavView, { kind: 'turn' }>;
  assert.equal(view.text, 'Turn left');
  assert.deepEqual(view.then, { glyph: '⚑', text: 'Arrive at Library' }); // the destination is 45 m after the turn
});

test('the arrival follows the last maneuver, and the time left uses the 20 km/h floor', async () => {
  const { nav, drive } = await navigating();
  for (let x = 0; x <= 2750; x += 50) drive(x, { speed: 0 }); // placed along the route without driving: no average speed
  drive(2770, { speed: 0, seconds: 1 });
  const view = nav.view() as Extract<NavView, { kind: 'turn' }>;
  assert.equal(view.text, 'Arrive at Library');
  assert.equal(view.glyph, '⚑');
  assert.ok(Math.abs(view.eta - 32 / (20 / 3.6)) < 1e-6);
});

test('off route after 2 s beyond 20 m; not while reversing or stopped', async () => {
  const { nav, server, drive } = await navigating();
  for (let x = 0; x <= 300; x += 50) drive(x);
  drive(300, { z: 30, speed: -5, seconds: 5 });                // reversing
  drive(300, { z: 30, speed: 0, seconds: 5 });                 // stopped
  assert.equal(server.calls.length, 1);
  drive(300, { z: 30, speed: 10, seconds: 1.9 });
  assert.equal(nav.state, 'active');
  drive(300, { z: 30, speed: 10, seconds: 0.3 });
  assert.equal(nav.state, 'rerouting');
  assert.equal(server.calls.length, 2);
  assert.deepEqual(server.calls[1].body.from, { x: 300, y: -30, bearing: 90 });
  assert.deepEqual(nav.view(), { kind: 'message', glyph: '⟳', text: 'Rerouting…', error: false });
  assert.ok(nav.route);                                        // the old route stays until the new one arrives
});

test('wrong way after 3 s against the route above 2 m/s', async () => {
  const { nav, server, drive } = await navigating();
  for (let x = 0; x <= 400; x += 50) drive(x);
  drive(400, { heading: -EAST, speed: 1.5, seconds: 5 });      // slow: not counted
  assert.equal(server.calls.length, 1);
  drive(400, { heading: -EAST, speed: 5, seconds: 3.2 });
  assert.equal(nav.state, 'rerouting');
});

test('reroutes at most every 3 s and keeps the old route until the new arrives', async () => {
  const { nav, server, drive } = await navigating();
  drive(300, { z: 30, seconds: 2.2 });
  assert.equal(server.calls.length, 2);
  const old = nav.route;
  server.calls[1].reject(httpError(503, 'down'));             // a failed reroute keeps the old route
  await flush();
  assert.equal(nav.state, 'active');
  assert.equal(nav.route, old);
  drive(300, { z: 30, seconds: 0.5 });                         // off route again, but within 3 s of the last try
  assert.equal(server.calls.length, 2);
  drive(300, { z: 30, seconds: 2.5 });
  assert.equal(server.calls.length, 3);
  server.calls[2].resolve(straightRoute(500, []));
  await flush();
  assert.equal(nav.state, 'active');
  assert.equal(nav.route!.distance, 500);
});

test('arrives within 20 m of the destination and clears after 4 s', async () => {
  const { nav, drive } = await navigating();
  for (let x = 0; x <= 2700; x += 50) drive(x);
  drive(2700, { seconds: 1 });
  assert.equal(nav.state, 'active');
  drive(2785);
  assert.equal(nav.state, 'arrived');
  assert.deepEqual(nav.view(), { kind: 'message', glyph: '⚑', text: 'Arrived at Library', error: false });
  assert.equal(nav.route, null);
  drive(2785, { seconds: 3.9 });
  assert.equal(nav.state, 'arrived');
  drive(2785, { seconds: 0.2 });
  assert.equal(nav.state, 'idle');
  assert.deepEqual(nav.view(), { kind: 'hidden' });
});

test('422 shows the message and stops; 5xx retries 3 times then errors', async () => {
  const server = fakeServer();
  const nav = createNavigation({ requestRoute: server.requestRoute, pose: () => ({ x: 0, z: 0, heading: 0 }) });
  const tick = (seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 0.1) nav.update(0.1, { x: 0, z: 0, heading: 0 }, 0, 22); };
  nav.start({ id: 'far', name: 'Far away', x: 5000, y: 5000 });
  assert.deepEqual(nav.view(), { kind: 'message', glyph: '⟳', text: 'Calculating route to Far away…', error: false });
  server.calls[0].reject(httpError(422, 'No road leads near this place.'));
  await flush();
  assert.deepEqual(nav.view(), { kind: 'message', glyph: '!', text: 'No road leads near this place.', error: true });
  tick(6.1);
  assert.equal(nav.state, 'idle');

  nav.start({ id: 'lib', name: 'Library', x: 1, y: 1 });
  for (const wait of [2, 4, 8]) {
    server.calls.at(-1)!.reject(httpError(500, 'boom'));
    await flush();
    assert.deepEqual(nav.view(), { kind: 'message', glyph: '⟳', text: 'Can’t reach the server, retrying…', error: false });
    const before = server.calls.length;
    tick(wait - 0.2);
    assert.equal(server.calls.length, before);
    tick(0.3);
    assert.equal(server.calls.length, before + 1);
  }
  server.calls.at(-1)!.reject(new TypeError('Failed to fetch'));
  await flush();
  assert.deepEqual(nav.view(), { kind: 'message', glyph: '!', text: 'Couldn’t reach the server.', error: true });
});

test('starting a new destination aborts the pending request', async () => {
  const server = fakeServer();
  const nav = createNavigation({ requestRoute: server.requestRoute, pose: () => ({ x: 0, z: 0, heading: 0 }) });
  nav.start({ id: 'a', name: 'A', x: 100, y: 0 });
  nav.start({ id: 'b', name: 'B', x: 2802, y: 0 });
  assert.equal(server.calls[0].signal.aborted, true);
  server.calls[0].resolve(straightRoute(100, []));            // a late answer for A is ignored
  server.calls[1].resolve(straightRoute());
  await flush();
  assert.equal(nav.destination!.name, 'B');
  assert.equal(nav.route!.distance, 2802);
  nav.stop();
  assert.equal(nav.state, 'idle');
  assert.equal(nav.route, null);
});
