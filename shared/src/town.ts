// Types shared by the client and server. Import with `import type` only:
// this package has no runtime code.

import type { Feature, FeatureCollection, Geometry, LineString, Polygon } from 'geojson';

/** OpenStreetMap tags of a feature, such as `highway`, `building` or `name`. */
export type TownProperties = Record<string, string | undefined>;

export type TownFeature = Feature<Geometry, TownProperties>;
export type BuildingFeature = Feature<Polygon, TownProperties>;
export type RoadFeature = Feature<LineString, TownProperties> & {
  /** OSM node ids, 1:1 with the coordinates. Backend town file only: tiles strip it. */
  osm?: { nodes: number[] };
};

export type TownBounds = [minX: number, minY: number, maxX: number, maxY: number];

/** A normalized town: positions are [x east, y north] in meters around `origin`. */
export interface Town extends Omit<FeatureCollection<Geometry, TownProperties>, 'bbox'> {
  units: 'meters';
  origin: { lon: number; lat: number };
  bbox: TownBounds;
  /** Turn restrictions from the OSM export. Backend town file only: tiles strip it. */
  osm?: { restrictions: OsmRestriction[] };
}

/** An OSM `type=restriction` relation, kept for routing (IDEA-3). */
export interface OsmRestriction {
  id: number;
  tags: Record<string, string>;
  members: { type: 'node' | 'way' | 'relation'; ref: number; role: string }[];
}

export type JunctionControl = 'traffic_signals' | 'stop' | 'give_way' | 'mini_roundabout' | 'turning_circle';

/** One direction a road leaves a junction in. */
export interface JunctionBranch {
  /** Unit vector from the node toward the next vertex, [x east, y north], 3 decimals. */
  dx: number;
  dy: number;
  highway: string;
  lanes?: string;
  name?: string;
  /** 'out': traffic may only leave along it; 'in': one-way toward the junction, arriving only. */
  flow: 'both' | 'out' | 'in';
}

/** A drivable road node where 3+ branches meet, or where a road ends. */
export interface Junction {
  /** OSM node id; null when the town has no node ids (coordinate fallback). */
  id: number | null;
  /** Meters, same space as the features. */
  x: number;
  y: number;
  kind: 'junction' | 'dead_end';
  control?: JunctionControl;
  /** Dead ends have one. */
  branches: JunctionBranch[];
}

/** One written tile, as listed in a town's tile index. */
export interface TileEntry {
  tx: number;
  ty: number;
  file: string;
  buildings: number;
  roads: number;
  other: number;
  /** Missing in indexes written before TN-33. */
  junctions?: number;
  bytes: number;
}

/** data/tiles/<town>/<town>_index.json: the town's grid and the tiles that have content. */
export interface TileIndex {
  town: string;
  source: string;
  units: 'meters';
  origin: { lon: number; lat: number };
  bbox: TownBounds;
  tileSize: number;
  grid: { minTx: number; maxTx: number; minTy: number; maxTy: number };
  tiles: TileEntry[];
}

/** One tile: a Town holding only the tile's features, plus its grid position. */
export interface TownTile extends Town {
  tile: { tx: number; ty: number; size: number; bounds: TownBounds };
  /** Missing in tiles written before TN-33. */
  junctions?: Junction[];
}

export interface ApiError {
  message: string;
}

export type * from './route.ts';
