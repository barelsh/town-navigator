// Converts raw.geojson (WGS84 lon/lat) into town_meters.geojson: the same
// features with [x east, y north] positions in meters around the town center.
//
// Uses an equirectangular projection, which is accurate to under a meter at
// town scale. The output keeps the GeoJSON structure, but RFC 7946 requires
// lon/lat positions, so map tools will misplace it.

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, '..', 'raw.geojson');
const OUTPUT = path.join(__dirname, '..', 'town_meters.geojson');

const EARTH_RADIUS_M = 6378137;
const DEG_TO_RAD = Math.PI / 180;

const round = (value) => Math.round(value * 100) / 100; // 1 cm

// Applies fn to every position, at any coordinate nesting depth.
function mapPositions(coordinates, fn) {
  return typeof coordinates[0] === 'number'
    ? fn(coordinates)
    : coordinates.map((child) => mapPositions(child, fn));
}

function mapGeometry(geometry, fn) {
  if (!geometry) return geometry;
  if (geometry.type === 'GeometryCollection') {
    return { ...geometry, geometries: geometry.geometries.map((g) => mapGeometry(g, fn)) };
  }
  return { ...geometry, coordinates: mapPositions(geometry.coordinates, fn) };
}

function assertLonLat([lon, lat]) {
  if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) {
    throw new Error(`Position [${lon}, ${lat}] is not lon/lat. Is the input already normalized?`);
  }
}

function createBounds() {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, count: 0 };
  bounds.add = ([x, y]) => {
    bounds.minX = Math.min(bounds.minX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.maxY = Math.max(bounds.maxY, y);
    bounds.count++;
  };
  return bounds;
}

function normalize(raw) {
  if (raw.type !== 'FeatureCollection' || !Array.isArray(raw.features)) {
    throw new Error('Input is not a GeoJSON FeatureCollection.');
  }

  const source = createBounds();
  for (const feature of raw.features) {
    mapGeometry(feature.geometry, (position) => {
      assertLonLat(position);
      source.add(position);
      return position;
    });
  }
  if (source.count === 0) throw new Error('Input has no positions.');

  const lon0 = (source.minX + source.maxX) / 2;
  const lat0 = (source.minY + source.maxY) / 2;
  const metersPerDegreeLat = DEG_TO_RAD * EARTH_RADIUS_M;
  const metersPerDegreeLon = metersPerDegreeLat * Math.cos(lat0 * DEG_TO_RAD);

  const target = createBounds();
  const project = ([lon, lat, ...rest]) => {
    const position = [
      round((lon - lon0) * metersPerDegreeLon),
      round((lat - lat0) * metersPerDegreeLat),
      ...rest,
    ];
    target.add(position);
    return position;
  };

  const features = raw.features.map((feature) => ({
    ...feature,
    geometry: mapGeometry(feature.geometry, project),
  }));

  return {
    collection: {
      ...raw,
      units: 'meters',
      origin: { lon: lon0, lat: lat0 },
      bbox: [target.minX, target.minY, target.maxX, target.maxY],
      features,
    },
    pointCount: target.count,
  };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const { collection, pointCount } = normalize(raw);
  fs.writeFileSync(OUTPUT, `${JSON.stringify(collection)}\n`);

  const [minX, minY, maxX, maxY] = collection.bbox;
  console.log(`Features: ${collection.features.length}, points: ${pointCount}`);
  console.log(`Origin: lon ${collection.origin.lon}, lat ${collection.origin.lat}`);
  console.log(`Extent (m): x ${minX} to ${maxX}, y ${minY} to ${maxY}`);
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT)}`);
}

try {
  main();
} catch (error) {
  console.error(`normalize_coordinates: ${error.message}`);
  process.exitCode = 1;
}
