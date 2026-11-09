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

export interface ApiError {
  message: string;
}
