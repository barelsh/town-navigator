// Tiny towns for the routing tests: ways built from [node id, x, y] triples, in map meters.

import type { OsmRestriction, RoadFeature, Town } from '@town-navigator/shared';

export type Node = [id: number, x: number, y: number];

export function way(id: number, nodes: Node[], tags: Record<string, string> = {}): RoadFeature {
  return {
    type: 'Feature',
    id: `way/${id}`,
    properties: { highway: 'residential', ...tags },
    geometry: { type: 'LineString', coordinates: nodes.map(([, x, y]) => [x, y]) },
    osm: { nodes: nodes.map(([n]) => n) },
  };
}

export function townOf(ways: RoadFeature[], restrictions: OsmRestriction[] = []): Town {
  return {
    type: 'FeatureCollection', units: 'meters', origin: { lon: 0, lat: 0 }, bbox: [-500, -500, 500, 500],
    features: ways, osm: { restrictions },
  };
}

export function restriction(kind: string, from: number, viaNode: number, to: number): OsmRestriction {
  return {
    id: from * 1000 + to, tags: { type: 'restriction', restriction: kind },
    members: [{ type: 'way', ref: from, role: 'from' }, { type: 'node', ref: viaNode, role: 'via' }, { type: 'way', ref: to, role: 'to' }],
  };
}

// A 4-way crossing X at the origin with 100 m arms, and a loop from the north arm's end round to the west arm's end.
export const X: Node = [1, 0, 0];
const S: Node = [2, 0, -100], N: Node = [3, 0, 100], W: Node = [4, -100, 0], E: Node = [5, 100, 0], NW: Node = [6, -100, 100];
export const CROSSING = [
  way(11, [S, X]),
  way(12, [X, N]),
  way(13, [X, W]),
  way(14, [X, E]),
  way(15, [N, NW, W]),
];

// A one-way roundabout ring (S → E → N → W → S, counter-clockwise) of radius 20 with a 100 m arm at each node.
const RS: Node = [21, 0, -20], RE: Node = [22, 20, 0], RN: Node = [23, 0, 20], RW: Node = [24, -20, 0];
export const ROUNDABOUT = [
  way(31, [RS, RE, RN, RW, RS], { junction: 'roundabout', highway: 'tertiary' }),
  way(32, [[41, 0, -120], RS], { name: 'South' }),
  way(33, [RE, [42, 120, 0]], { name: 'East' }),
  way(34, [RN, [43, 0, 120]], { name: 'North' }),
  way(35, [RW, [44, -120, 0]], { name: 'West' }),
];
