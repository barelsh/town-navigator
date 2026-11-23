// Converts raw.geojson (WGS84 lon/lat) into town_meters.geojson: the same
// features with [x east, y north] positions in meters around the town center.
//
// The input is either an overpass-turbo GeoJSON export, or raw Overpass OSM
// JSON (an `elements` array, e.g. raw_<town>.osm.json). OSM JSON is converted
// with osmtogeojson and keeps what GeoJSON drops, for the backend only: road
// node ids (`osm.nodes`), tagged nodes as Point features and turn restrictions
// (`osm.restrictions` on the collection).
//
// Uses an equirectangular projection, which is accurate to under a meter at
// town scale. The output keeps the GeoJSON structure, but RFC 7946 requires
// lon/lat positions, so map tools will misplace it.

const fs = require('fs');
const path = require('path');
const osmtogeojson = require('osmtogeojson');

const DATA_DIR = path.join(__dirname, '..');
const DEFAULT_INPUT = 'raw.geojson';

// Same rule as VALID_TOWN_ID in server/src/services/townStore.ts and tile_town.js.
const VALID_TOWN_ID = /^[A-Za-z0-9_-]+$/;

// raw.geojson -> town_meters.geojson, other.geojson -> town_meters_other.geojson,
// other.osm.json -> town_meters_other.geojson. An explicit town id names the output instead.
function outputPathFor(inputPath, townId) {
  const inputName = path.basename(inputPath, path.extname(inputPath)).replace(/\.osm$/, '');
  const defaultName = path.basename(DEFAULT_INPUT, path.extname(DEFAULT_INPUT));
  const name = townId ?? inputName;
  const suffix = name === defaultName ? '' : `_${name}`;
  return path.join(DATA_DIR, `town_meters${suffix}.geojson`);
}

// Raw Overpass OSM JSON -> a lon/lat FeatureCollection shaped like an
// overpass-turbo export, plus node ids, tagged-node Points and restrictions.
function fromOverpass(raw) {
  const ways = new Map(raw.elements.filter((e) => e.type === 'way').map((w) => [w.id, w]));
  const tags = new Map(raw.elements.map((e) => [`${e.type}/${e.id}`, e.tags ?? {}]));
  const geo = osmtogeojson(raw);
  const stats = { roadsWithNodes: 0, taggedNodes: 0, restrictions: 0 };

  const features = [];
  for (const feature of geo.features) {
    const id = String(feature.id);
    // Restriction relations go to collection.osm instead of becoming features.
    if (id.startsWith('relation/') && tags.get(id)?.type === 'restriction') continue;
    feature.properties = { '@id': id, ...tags.get(id) };
    const way = id.startsWith('way/') && ways.get(Number(id.slice(4)));
    if (way && feature.geometry?.type === 'LineString') {
      const positions = feature.geometry.coordinates.length;
      if (way.nodes.length !== positions) {
        throw new Error(`${id}: ${way.nodes.length} nodes, ${positions} positions`);
      }
      feature.osm = { nodes: way.nodes };
      if (feature.properties.highway) stats.roadsWithNodes++;
    }
    if (id.startsWith('node/')) stats.taggedNodes++;
    features.push(feature);
  }

  const restrictions = raw.elements
    .filter((e) => e.type === 'relation' && e.tags?.type === 'restriction')
    .map(({ id, tags: relationTags, members }) => ({
      id,
      tags: relationTags,
      members: members.map(({ type, ref, role }) => ({ type, ref, role })),
    }));
  stats.restrictions = restrictions.length;

  return {
    collection: {
      type: 'FeatureCollection',
      generator: raw.generator,
      copyright: raw.osm3s?.copyright,
      timestamp: raw.osm3s?.timestamp_osm_base,
      features,
      osm: { restrictions },
    },
    stats,
  };
}

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
  // Optional argument: raw file name, relative to the data dir.
  // Optional second argument: the town id of the output, e.g. rosh_haayin.
  const input = path.resolve(DATA_DIR, process.argv[2] ?? DEFAULT_INPUT);
  const townId = process.argv[3];
  if (townId !== undefined && !VALID_TOWN_ID.test(townId)) {
    throw new Error(`Invalid town id "${townId}". Use letters, digits, _ and -.`);
  }
  let raw = JSON.parse(fs.readFileSync(input, 'utf8'));
  let osmStats = null;
  if (Array.isArray(raw.elements)) ({ collection: raw, stats: osmStats } = fromOverpass(raw));
  const { collection, pointCount } = normalize(raw);
  const output = outputPathFor(input, townId);
  fs.writeFileSync(output, `${JSON.stringify(collection)}\n`);

  const [minX, minY, maxX, maxY] = collection.bbox;
  console.log(`Features: ${collection.features.length}, points: ${pointCount}`);
  console.log(`Origin: lon ${collection.origin.lon}, lat ${collection.origin.lat}`);
  console.log(`Extent (m): x ${minX} to ${maxX}, y ${minY} to ${maxY}`);
  if (osmStats) {
    const n = (value) => value.toLocaleString('en-US');
    console.log(`Roads with node ids: ${n(osmStats.roadsWithNodes)} · tagged nodes: ${n(osmStats.taggedNodes)} · restrictions: ${n(osmStats.restrictions)}`);
  }
  console.log(`Wrote ${path.relative(process.cwd(), output)}`);
}

try {
  main();
} catch (error) {
  console.error(`normalize_coordinates: ${error.message}`);
  process.exitCode = 1;
}
