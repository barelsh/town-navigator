// The active navigation (TN-39): requesting the route, the car's progress along it, rerouting when the car leaves it,
// and the arrival. Guidance only: nothing here steers the car. Pure code (the route request is injected), so
// `node --test` can drive it with a fake server and frame times.

import type { Route, RouteRequest } from '@town-navigator/shared';
import type { Favorite } from '../settings/settingsStore.ts';
import {
  GLYPH, THEN_GAP, formatLength, nextManeuvers, project, toBearing, toWorldRoute, turnText, wrap, type WorldRoute,
} from './routeProgress.ts';

export const OFF_ROUTE_M = 20;     // m from the route line ...
export const OFF_ROUTE_S = 2;      // ... for this long is off route
export const WRONG_WAY_S = 3;      // s driving against the route
export const WRONG_WAY = (120 * Math.PI) / 180;
export const REROUTE_GAP_S = 3;    // s between reroutes, and before retrying a failed one
export const ARRIVE_M = 20;        // m from the destination
export const ARRIVE_END_M = 15;    // m before the route's end
export const ARRIVED_S = 4;        // s the arrival shows
export const ERROR_S = 6;          // s an error shows
export const RETRIES = [2, 4, 8];  // s before each retry of a first request that could not reach the server
export const SPEED_WINDOW_S = 30;  // s of driving the time left is averaged over
export const ETA_MIN_SPEED = 20 / 3.6;

export type NavState = 'idle' | 'routing' | 'active' | 'rerouting' | 'arrived' | 'error';

export interface Pose { x: number; z: number; heading: number }

/** The destination as it was when navigation started: renaming or removing the favorite doesn't change it. */
export type Destination = Pick<Favorite, 'id' | 'name' | 'x' | 'y'>;

/** What the card shows. */
export type NavView =
  | { kind: 'hidden' }
  | { kind: 'message'; glyph: string; text: string; error: boolean }
  | {
    kind: 'turn';
    /** Identifies the maneuver, so the card can pulse once per maneuver. */
    key: string;
    glyph: string; text: string; road?: string;
    /** Meters to the maneuver. */
    distance: number;
    then?: { glyph: string; text: string };
    destination: string;
    /** Meters left to the destination, and seconds at the average speed. */
    left: number; eta: number;
  };

export interface NavigationOptions {
  requestRoute(body: RouteRequest, signal: AbortSignal): Promise<Route>;
  /** The car now, for a route request. */
  pose(): Pose;
  onEvent?(kind: string, data: Record<string, number | string | null>): void;
}

export interface Navigation {
  readonly state: NavState;
  readonly destination: Destination | null;
  /** The route being followed (kept while rerouting); null when there is none. */
  readonly route: WorldRoute | null;
  /** Meters along the route. */
  readonly along: number;
  start(destination: Destination): void;
  stop(): void;
  /** Asks for a new route from where the car is now. A teleport passes `now` to skip the 3 s gap. */
  reroute(reason: string, now?: boolean): void;
  /** Once per frame. `speed` is the car's signed speed (negative: reversing), `limit` its top speed, in m/s. */
  update(dt: number, pose: Pose, speed: number, limit: number): void;
  view(): NavView;
}

/** An HTTP failure with a message meant for the user (4xx), as opposed to the server being unreachable or broken. */
const userError = (error: unknown): string | null => {
  const status = (error as { status?: number })?.status;
  return status !== undefined && status >= 400 && status < 500 && error instanceof Error ? error.message : null;
};
const isAbort = (error: unknown) => (error as { name?: string })?.name === 'AbortError';

export function createNavigation({ requestRoute, pose, onEvent }: NavigationOptions): Navigation {
  let state: NavState = 'idle';
  let destination: Destination | null = null;
  let route: WorldRoute | null = null;
  let progress = { index: 0, along: 0, offset: 0, heading: 0 };
  let clock = 0;               // s, advanced by update
  let stateUntil = Infinity;   // when an arrival or error message ends
  let message = '';
  let pending: AbortController | null = null;
  let retryAt = Infinity, attempt = 0;
  let lastReroute = -Infinity;
  let offTimer = 0, wrongTimer = 0;
  let samples: { t: number; meters: number }[] = [];
  let topSpeed = Infinity;

  const reset = () => {
    pending?.abort();
    pending = null;
    route = null;
    retryAt = Infinity;
    attempt = 0;
    offTimer = wrongTimer = 0;
    samples = [];
  };

  function request(rerouting: boolean): void {
    if (!destination) return;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    const p = pose();
    const body: RouteRequest = {
      from: { x: p.x, y: -p.z, bearing: toBearing(p.heading) },
      to: { x: destination.x, y: destination.y },
    };
    const started = clock, target = destination;
    const t0 = performance.now();
    requestRoute(body, controller.signal).then(
      result => {
        if (pending !== controller || destination !== target) return;
        pending = null;
        route = toWorldRoute(result);
        progress = { index: 0, along: 0, offset: 0, heading: 0 };
        offTimer = wrongTimer = 0;
        attempt = 0;
        state = 'active';
        onEvent?.('nav.route', { distance: result.distance, maneuvers: result.maneuvers.length, ms: Math.round(performance.now() - t0) });
      },
      (error: unknown) => {
        if (pending !== controller || isAbort(error)) return;
        pending = null;
        const text = userError(error);
        onEvent?.('nav.error', { message: error instanceof Error ? error.message : String(error), rerouting: rerouting ? 1 : 0 });
        if (rerouting && route) {        // keep following the old route; try again after the gap
          state = 'active';
          lastReroute = started;
          return;
        }
        if (text === null && attempt < RETRIES.length) {
          retryAt = clock + RETRIES[attempt++];
          message = 'Can’t reach the server, retrying…';
          return;
        }
        fail(text ?? 'Couldn’t reach the server.');
      },
    );
  }

  function fail(text: string): void {
    reset();
    state = 'error';
    message = text;
    stateUntil = clock + ERROR_S;
  }

  function averageSpeed(): number {
    const meters = samples.reduce((sum, s) => sum + s.meters, 0);
    const span = Math.min(SPEED_WINDOW_S, clock - (samples[0]?.t ?? clock));
    return span > 0 ? meters / span : 0;
  }

  const api: Navigation = {
    get state() { return state; },
    get destination() { return destination; },
    get route() { return route; },
    get along() { return progress.along; },

    start(target) {
      reset();
      destination = { id: target.id, name: target.name, x: target.x, y: target.y };
      state = 'routing';
      message = `Calculating route to ${target.name}…`;
      stateUntil = Infinity;
      onEvent?.('nav.start', { name: target.name, x: target.x, y: target.y });
      request(false);
    },

    stop() {
      if (state === 'idle') return;
      onEvent?.('nav.stop', { state });
      reset();
      destination = null;
      state = 'idle';
    },

    reroute(reason, now = false) {
      if (!destination || (state !== 'active' && state !== 'rerouting')) return;
      if (!now && clock - lastReroute < REROUTE_GAP_S) return;
      lastReroute = clock;
      state = 'rerouting';
      offTimer = wrongTimer = 0;
      onEvent?.('nav.reroute', { reason });
      request(true);
    },

    update(dt, p, speed, limit) {
      clock += dt;
      if ((state === 'arrived' || state === 'error') && clock >= stateUntil) {
        if (state === 'arrived') onEvent?.('nav.clear', {});
        state = 'idle';
        destination = null;
        return;
      }
      if (state === 'routing' && clock >= retryAt) {
        retryAt = Infinity;
        request(false);
      }
      if (!route || (state !== 'active' && state !== 'rerouting')) return;

      samples.push({ t: clock, meters: Math.max(0, speed) * dt });
      while (samples.length && samples[0].t < clock - SPEED_WINDOW_S) samples.shift();
      topSpeed = limit;

      progress = project(route, p.x, p.z, progress.index);
      const end = route.destination;
      if (Math.hypot(p.x - end.x, p.z - end.z) < ARRIVE_M || progress.along >= route.distance - ARRIVE_END_M) {
        onEvent?.('nav.arrive', { name: destination!.name });
        reset();
        state = 'arrived';
        message = `Arrived at ${destination!.name}`;
        stateUntil = clock + ARRIVED_S;
        return;
      }
      if (state !== 'active') return;
      offTimer = progress.offset > OFF_ROUTE_M && speed > 1 ? offTimer + dt : 0;
      const against = Math.abs(wrap(p.heading - progress.heading)) > WRONG_WAY;
      wrongTimer = against && speed > 2 ? wrongTimer + dt : 0;
      if (offTimer > OFF_ROUTE_S) api.reroute('off_route');
      else if (wrongTimer > WRONG_WAY_S) api.reroute('wrong_way');
    },

    view() {
      switch (state) {
        case 'idle': return { kind: 'hidden' };
        case 'routing': return { kind: 'message', glyph: '⟳', text: message, error: false };
        case 'rerouting': return { kind: 'message', glyph: '⟳', text: 'Rerouting…', error: false };
        case 'arrived': return { kind: 'message', glyph: GLYPH.arrive, text: message, error: false };
        case 'error': return { kind: 'message', glyph: '!', text: message, error: true };
      }
      const r = route!;
      const left = Math.max(0, r.distance - progress.along);
      const { next, after } = nextManeuvers(r, progress.along);
      const base = { destination: destination!.name, left, eta: left / Math.min(topSpeed, Math.max(ETA_MIN_SPEED, averageSpeed())) };
      if (!next) {
        return { kind: 'turn', key: 'arrive', glyph: GLYPH.arrive, text: `Arrive at ${destination!.name}`, distance: left, ...base };
      }
      const thenAt = after ? after.along : r.distance;
      const then = thenAt - next.along <= THEN_GAP
        ? (after ? { glyph: GLYPH[after.turn], text: turnText(after) } : { glyph: GLYPH.arrive, text: `Arrive at ${destination!.name}` })
        : undefined;
      return {
        kind: 'turn', key: `${next.along}`, glyph: GLYPH[next.turn], text: turnText(next),
        ...(next.road ? { road: next.road } : {}),
        distance: Math.max(0, next.along - progress.along), ...(then ? { then } : {}), ...base,
      };
    },
  };
  return api;
}

/** Straight-line distance text for the dialog's rows. */
export const awayText = (meters: number) => `${formatLength(meters)} away`;
