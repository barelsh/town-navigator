import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Route } from '@town-navigator/shared';
import { buildApp } from '../app.ts';

const real = existsSync(path.resolve(import.meta.dirname, '../../../data/town_meters_rosh_haayin.geojson'));
const app = await buildApp({ logger: false });
const post = (id: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/towns/${id}/route`, payload: payload as object });
const LIBRARY = { from: { x: -18.3, y: -7.9, bearing: 0 }, to: { x: -2009, y: 609 } };

test('400 for a missing or non-numeric field', async () => {
  for (const body of [{ from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }, { from: { x: 0, y: 0, bearing: 'north' }, to: { x: 1, y: 1 } }, {}]) {
    const res = await post('rosh_haayin', body);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), { message: 'Send from: { x, y, bearing } and to: { x, y } in meters.' });
  }
});

test('404 for an unknown or invalid town', async () => {
  for (const id of ['no_such_town', 'bad.id']) {
    const res = await post(id, LIBRARY);
    assert.equal(res.statusCode, 404);
    assert.match(res.json().message, /not found/);
  }
});

test('200 with the route, not cached', { skip: !real }, async () => {
  const res = await post('rosh_haayin', LIBRARY);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const route = res.json() as Route;
  assert.ok(Math.abs(route.distance - 2802) < 5);
  assert.equal(route.stretches[0].start, 0);
});

test('422 when no road leads near the destination', { skip: !real }, async () => {
  const res = await post('rosh_haayin', { ...LIBRARY, to: { x: 5000, y: 5000 } });
  assert.equal(res.statusCode, 422);
  assert.deepEqual(res.json(), { message: 'No road leads near this place.' });
});
