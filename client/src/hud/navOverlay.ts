// The route on the road while navigating (TN-40): a thin cyan line in the car's lane for the next 500 m, and cyan turn
// arrows in TN-37's style at the next 2 junctions where the route turns. Two meshes, one draw call each, sharing the
// glow material of the violet arrow.
//
// The line is rebuilt when the car has moved 25 m along the route, or when the route, the road graph or the arrowed
// zones change; the arrows only when the set of arrowed junctions (or the queued turn riding on one) changes.

import * as THREE from 'three';
import { ROAD_LINE_Y } from '../town/roads.ts';
import type { RoadGraph } from '../town/roadGraph.ts';
import { lineSpans, ringPath, turnArrays, upcomingTurns, LINE_AHEAD, type NavTurn, type OnRoute } from '../nav/navTurns.ts';
import type { WorldRoute } from '../nav/routeProgress.ts';
import { createGlowMesh, toGeometry, type GlowMaterial } from './glowRibbon.ts';
import { ARROW_Y } from './turnIntent.ts';
import { buildRibbonArrays, LINE_LAYERS } from './turnArrow.ts';

const LINE_Y = ROAD_LINE_Y + 0.03;
const LINE_REBUILD = 25; // m along the route between line rebuilds
const RING_RADIUS = 1.5; // m: the 3 m ring at the destination

export interface NavOverlay {
  /** The next 2 arrowed junctions ahead of `along`. Cached per route and graph. */
  turnsAhead(route: WorldRoute, along: number, graph: RoadGraph): NavTurn[];
  /** Draws the route (null: clears it). `onRoute` is the junction where the driver's queued turn is the route's. */
  update(route: WorldRoute | null, along: number, graph: RoadGraph, onRoute: OnRoute | null): void;
}

export function createNavOverlay(scene: THREE.Scene, material: GlowMaterial): NavOverlay {
  const line = createGlowMesh(material, 'navLine', 9);
  const arrows = createGlowMesh(material, 'navArrows', 10);
  scene.add(line, arrows);

  let cacheFor: { route: WorldRoute; graph: RoadGraph } | null = null;
  let cache = new Map<number, NavTurn | null>();
  let lineKey = '', lineAlong = -Infinity, lineRoute: WorldRoute | null = null;
  let arrowKey = '';

  const replace = (mesh: THREE.Mesh, geometry: THREE.BufferGeometry | null) => {
    mesh.geometry.dispose();
    mesh.geometry = geometry ?? new THREE.BufferGeometry();
    mesh.visible = geometry !== null;
  };

  function turnsAhead(route: WorldRoute, along: number, graph: RoadGraph): NavTurn[] {
    if (!cacheFor || cacheFor.route !== route || cacheFor.graph !== graph) {
      cacheFor = { route, graph };
      cache = new Map();
    }
    return upcomingTurns(graph, route, along, undefined, cache);
  }

  function clear(): void {
    if (!lineRoute && !arrowKey) return; // already clear
    replace(line, null);
    replace(arrows, null);
    lineKey = arrowKey = '';
    lineRoute = null;
    lineAlong = -Infinity;
    cacheFor = null;
    cache = new Map();
  }

  // Ids that change whenever the route or graph objects do, for the rebuild keys.
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const idOf = (o: object) => ids.get(o) ?? (ids.set(o, nextId), nextId++);

  return {
    turnsAhead,
    update(route, along, graph, onRoute) {
      if (!route) { clear(); return; }
      const turns = turnsAhead(route, along, graph);
      const zones = turns.map(t => `${t.index}-${t.last}`).join(',');

      const aKey = `${idOf(route)}|${idOf(graph)}|${zones}|${onRoute ? `${idOf(onRoute.zone)}:${idOf(onRoute.path)}` : ''}`;
      if (aKey !== arrowKey) {
        arrowKey = aKey;
        replace(arrows, turns.length ? toGeometry(turnArrays(turns, onRoute, ARROW_Y)) : null);
      }

      const lKey = `${idOf(route)}|${idOf(graph)}|${zones}`;
      if (lKey !== lineKey || route !== lineRoute || Math.abs(along - lineAlong) >= LINE_REBUILD) {
        lineKey = lKey;
        lineRoute = route;
        lineAlong = along;
        const pieces = lineSpans(route, along, LINE_AHEAD, turns.map(t => t.zone));
        if (along + LINE_AHEAD >= route.cum[route.cum.length - 1]) pieces.push(ringPath(route.destination, RING_RADIUS));
        replace(line, pieces.length ? toGeometry(buildRibbonArrays(pieces, LINE_LAYERS, LINE_Y)) : null);
      }
    },
  };
}
