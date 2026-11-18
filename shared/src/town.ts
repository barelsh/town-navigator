// Types shared by the client and server. Import with `import type` only:
// this package has no runtime code.

import type { Feature, FeatureCollection, Geometry, LineString, Polygon } from 'geojson';

/** OpenStreetMap tags of a feature, such as `highway`, `building` or `name`. */
export type TownProperties = Record<string, string | undefined>;

export type TownFeature = Feature<Geometry, TownProperties>;
export type BuildingFeature = Feature<Polygon, TownProperties>;
export type RoadFeature = Feature<LineString, TownProperties>;

export type TownBounds = [minX: number, minY: number, maxX: number, maxY: number];

/** A normalized town: positions are [x east, y north] in meters around `origin`. */
export interface Town extends Omit<FeatureCollection<Geometry, TownProperties>, 'bbox'> {
  units: 'meters';
  origin: { lon: number; lat: number };
  bbox: TownBounds;
}

/** One written tile, as listed in a town's tile index. */
export interface TileEntry {
  tx: number;
  ty: number;
  file: string;
  buildings: number;
  roads: number;
  other: number;
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
}

export interface ApiError {
  message: string;
}
