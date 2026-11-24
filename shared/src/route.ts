// Routing types shared by the client and server (TN-38). Types only, like town.ts.
// Positions are the town's map meters: x east, y north. Bearings are degrees clockwise from north.

/** Body of POST /api/towns/:id/route. */
export interface RouteRequest {
  from: { x: number; y: number; bearing: number };
  to: { x: number; y: number };
}

export type TurnKind = 'straight' | 'slight_left' | 'left' | 'sharp_left' | 'slight_right' | 'right' | 'sharp_right'
  | 'uturn' | 'roundabout';

/** One junction on the route, or one roundabout: what to do there. */
export interface Maneuver {
  /** OSM node ids of the junction nodes the route passes here, in order (several for a roundabout or a dual carriageway). */
  nodes: number[];
  /** The first of those nodes, map meters. */
  x: number;
  y: number;
  /** Meters from the route's start to the first node. */
  along: number;
  /** Bearings over the 30 m before the first node and the 30 m after the last, degrees clockwise from north. */
  inBearing: number;
  outBearing: number;
  /** outBearing − inBearing, wrapped to −180..180; positive is right. */
  angle: number;
  turn: TurnKind;
  /** Roundabouts: which exit, counting only exits a car may take. */
  exit?: number;
  /** Name of the road the route leaves on. */
  road?: string;
  /** Going straight, but another exit here is straighter, so "straight" needs saying. */
  ambiguous?: boolean;
}

/** A stretch of the route along one road piece: points[start] up to the next stretch's start. */
export interface RouteStretch {
  start: number;
  highway: string;
  oneway: boolean;
  name?: string;
}

export interface Route {
  /** Meters, 1 decimal. */
  distance: number;
  /** Map meters, start snap → destination snap, 2 decimals. */
  points: [number, number][];
  stretches: RouteStretch[];
  /** Where the car was snapped onto the road. */
  start: { x: number; y: number };
  /** Where the destination was snapped onto the road. */
  destination: { x: number; y: number };
  /** Every junction with 3+ branches on the route, in order. */
  maneuvers: Maneuver[];
}
