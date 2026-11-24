// One route request, start to finish: snap both ends, search, build the Route (TN-38).

import type { Route, RouteRequest } from '@town-navigator/shared';
import type { RouteGraph } from './graph.ts';
import { toRoute } from './maneuvers.ts';
import { findPath } from './search.ts';
import { snapGoal, snapStart } from './snap.ts';

/** Why there is no route; the route endpoint answers each with 422 and this message. */
export const NO_ROUTE = {
  noGraph: 'This town has no road graph. Re-export it with npm run normalize.',
  startOffRoad: 'The car is not near a road.',
  goalOffRoad: 'No road leads near this place.',
  unreachable: 'No legal route to this place.',
} as const;

export type PlanResult = { route: Route } | { error: (typeof NO_ROUTE)[keyof typeof NO_ROUTE] };

export function planRoute(g: RouteGraph, { from, to }: RouteRequest): PlanResult {
  if (!g.pieces.length) return { error: NO_ROUTE.noGraph };
  const start = snapStart(g, from.x, from.y, from.bearing);
  if (!start) return { error: NO_ROUTE.startOffRoad };
  const goal = snapGoal(g, to.x, to.y);
  if (!goal) return { error: NO_ROUTE.goalOffRoad };
  const path = findPath(g, start, goal);
  if (!path) return { error: NO_ROUTE.unreachable };
  return { route: toRoute(g, path) };
}
