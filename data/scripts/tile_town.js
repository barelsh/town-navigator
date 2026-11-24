// Cuts a normalized town (town_meters_<town>.geojson) into a square grid of
// tiles anchored at the origin (0, 0), and writes one GeoJSON file per
// non-empty tile plus an index, to data/tiles/<town>/.
//
// Buildings (any polygon) go whole to the tile of their centroid. Roads (any
// line) are cut where they cross a grid line, so no piece leaves its tile.
// Tiles stay in the same meter space as the source, so each is a valid town.
//
// Each tile also gets a `junctions` list: drivable road nodes where 3+ branches
// meet, and dead ends, with the direction, road and one-way flow of every
// branch. Nodes are matched by OSM node id (`osm.nodes`) when the town has
// them, otherwise by coordinates. The backend-only OSM data (`osm` on features,
// tagged-node Points) is not written to tiles.

const fs = require('fs');
const path = require('path');
const { DRIVABLE_HIGHWAYS, onewayOf, nodeDegrees } = require('./roadRules.js');

const DATA_DIR = path.join(__dirname, '..');
const TILES_DIR = path.join(DATA_DIR, 'tiles');
const DEFAULT_TILE_SIZE = 500;

// Same rules as VALID_TOWN_ID and townFileName in server/src/services/townStore.ts
// (plain JS can't import the TypeScript).
const VALID_TOWN_ID = /^[A-Za-z0-9_-]+$/;
const DEFAULT_RAW_NAME = 'raw'; // normalize writes raw.geojson without a name suffix

function townFileName(id) {
  return id === DEFAULT_RAW_NAME ? 'town_meters.geojson' : `town_meters_${id}.geojson`;
}

const round = (value) => Math.round(value * 100) / 100; // 1 cm
const r3 = (value) => Math.round(value * 1000) / 1000;

const NODE_CONTROLS = new Set(['traffic_signals', 'stop', 'give_way', 'mini_roundabout', 'turning_circle']);

// A tagged OSM node, kept as a Point in the backend town file only.
const isNodePoint = (feature) => feature.geometry?.type === 'Point' && String(feature.id).startsWith('node/');

const tileOf = ([x, y], size) => ({ tx: Math.floor(x / size), ty: Math.floor(y / size) });
const tileName = (town, { tx, ty }) => `${town}_${tx}_${ty}`;
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function length(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]);
  }
  return total;
}

// Parameters t in (0, 1), ascending, where the segment a-b crosses a grid line.
function crossings([ax, ay], [bx, by], size) {
  const ts = [];
  const along = (from, to) => {
    if (from === to) return;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    // Grid lines strictly between the ends; an end lying exactly on a line needs no cut.
    for (let k = Math.floor(lo / size) + 1; k * size < hi; k++) ts.push((k * size - from) / (to - from));
  };
  along(ax, bx);
  along(ay, by);
  return [...new Set(ts)].filter((t) => t > 0 && t < 1).sort((p, q) => p - q);
}

// Cuts a line at grid lines. Returns [{ key: {tx, ty}, coords }] in line order.
function splitLine(coords, size) {
  const pieces = [];
  let current = [coords[0]];
  let key = tileOf(coords[0], size);
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    for (const t of crossings(a, b, size)) {
      const p = [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)];
      current.push(p);
      // Name the next tile from just past the cut, so a cut exactly on a corner is handled.
      const next = tileOf(lerp(a, b, t + 1e-9), size);
      if (next.tx !== key.tx || next.ty !== key.ty) {
        pieces.push({ key, coords: current });
        current = [p];
        key = next;
      }
    }
    current.push(b);
  }
  pieces.push({ key, coords: current });
  return pieces.filter((piece) => piece.coords.length >= 2 && length(piece.coords) > 0.01);
}

const average = (points) => [
  points.reduce((sum, p) => sum + p[0], 0) / points.length,
  points.reduce((sum, p) => sum + p[1], 0) / points.length,
];

// Every position of a geometry's first part, used to place multi-part and mixed geometries.
function firstPartPositions(geometry) {
  switch (geometry.type) {
    case 'Point': return [geometry.coordinates];
    case 'MultiPoint': return geometry.coordinates;
    case 'LineString': return geometry.coordinates;
    case 'MultiLineString': return geometry.coordinates[0] ?? [];
    case 'Polygon': return geometry.coordinates[0] ?? [];
    case 'MultiPolygon': return geometry.coordinates[0]?.[0] ?? [];
    case 'GeometryCollection': return geometry.geometries.length ? firstPartPositions(geometry.geometries[0]) : [];
    default: return [];
  }
}

// Junctions and dead ends of the drivable road graph over the whole town.
// Degree counts way occurrences: +1 at a way's end, +2 in its middle.
// useIds: false forces coordinate matching, for comparison.
function buildJunctions(source, { useIds = true } = {}) {
  const nodes = new Map(); // key -> { x, y, id, degree, branches }
  const controls = new Map(); // node id -> control, from Point features 'node/<id>'
  for (const f of source.features) {
    if (isNodePoint(f) && NODE_CONTROLS.has(f.properties?.highway)) {
      controls.set(Number(String(f.id).slice(5)), f.properties.highway);
    }
  }
  const roads = source.features.filter((f) => f.geometry?.type === 'LineString' && DRIVABLE_HIGHWAYS.has(f.properties?.highway));
  const keyOf = (f, i) => {
    const ids = useIds ? f.osm?.nodes : undefined;
    const pos = f.geometry.coordinates[i];
    return ids ? ids[i] : `${pos[0]},${pos[1]}`;
  };
  const degrees = nodeDegrees(roads, keyOf);
  for (const f of roads) {
    const p = f.properties ?? {};
    const c = f.geometry.coordinates;
    const ids = useIds ? f.osm?.nodes : undefined;
    const oneway = onewayOf(p);
    const forwardOnly = oneway === 1;
    const backwardOnly = oneway === -1;
    c.forEach((pos, i) => {
      const key = keyOf(f, i);
      const node = nodes.get(key) ?? { x: pos[0], y: pos[1], id: ids ? ids[i] : null, degree: degrees.get(key), branches: [] };
      for (const [j, along] of [[i + 1, true], [i - 1, false]]) {
        if (j < 0 || j >= c.length) continue;
        const dx = c[j][0] - pos[0];
        const dy = c[j][1] - pos[1];
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        const flow = forwardOnly ? (along ? 'out' : 'in') : backwardOnly ? (along ? 'in' : 'out') : 'both';
        // Undefined fields are left out of the JSON, so tiles stay small.
        node.branches.push({ dx: r3(dx / len), dy: r3(dy / len), highway: p.highway, lanes: p.lanes, name: p.name, flow });
      }
      nodes.set(key, node);
    });
  }
  const junctions = [];
  for (const n of nodes.values()) {
    if (n.degree !== 1 && n.degree < 3) continue;
    junctions.push({
      id: n.id,
      x: n.x,
      y: n.y,
      kind: n.degree === 1 ? 'dead_end' : 'junction',
      ...(n.id !== null && controls.has(n.id) ? { control: controls.get(n.id) } : {}),
      branches: n.branches,
    });
  }
  return junctions;
}

const countKinds = (junctions) => ({
  junctions: junctions.filter((j) => j.kind === 'junction').length,
  deadEnds: junctions.filter((j) => j.kind === 'dead_end').length,
});

function classify(feature) {
  const tags = feature.properties ?? {};
  if (tags.building) return 'buildings';
  if (tags.highway) return 'roads';
  return 'other';
}

function parseArgs(argv) {
  const [town, sizeArg] = argv;
  if (!town) throw new Error('Usage: npm run tile -- <town> [tileSize]');
  if (!VALID_TOWN_ID.test(town)) throw new Error(`Invalid town id "${town}". Use letters, digits, _ and -.`);
  let size = DEFAULT_TILE_SIZE;
  if (sizeArg !== undefined) {
    size = Number(sizeArg);
    if (!(Number.isFinite(size) && size > 0)) throw new Error(`Tile size "${sizeArg}" must be a positive number of meters.`);
  }
  return { town, size };
}

function readSource(town) {
  const fileName = townFileName(town);
  const file = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`No data/${fileName}. Run npm run normalize -- raw_${town}.geojson first.`);
  }
  const source = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (source.type !== 'FeatureCollection' || source.units !== 'meters') {
    throw new Error(`data/${fileName} is not normalized. Run npm run normalize first.`);
  }
  return { source, fileName };
}

function assign(source, size) {
  const tiles = new Map(); // "tx,ty" -> { tx, ty, features }
  const put = (key, feature) => {
    const id = `${key.tx},${key.ty}`;
    if (!tiles.has(id)) tiles.set(id, { ...key, features: [] });
    tiles.get(id).features.push(feature);
  };
  const stats = { roads: 0, pieces: 0, multiPart: 0 };

  for (const { osm, ...feature } of source.features) { // osm: backend only
    const geometry = feature.geometry;
    if (!geometry || isNodePoint(feature)) continue;
    if (geometry.type === 'LineString') {
      stats.roads++;
      const pieces = splitLine(geometry.coordinates, size);
      stats.pieces += pieces.length;
      if (pieces.length === 1 && pieces[0].coords.length === geometry.coordinates.length) {
        put(pieces[0].key, feature); // inside one tile: written unchanged
      } else {
        pieces.forEach((piece, part) => {
          put(piece.key, {
            ...feature,
            properties: { ...feature.properties, part },
            geometry: { ...geometry, coordinates: piece.coords },
          });
        });
      }
    } else {
      let positions = firstPartPositions(geometry);
      if (geometry.type === 'Polygon' && positions.length > 1) positions = positions.slice(0, -1); // drop closing point
      if (!positions.length) continue;
      if (geometry.type !== 'Polygon' && geometry.type !== 'Point') stats.multiPart++;
      put(tileOf(average(positions), size), feature);
    }
  }
  return { tiles, stats };
}

function main() {
  const { town, size } = parseArgs(process.argv.slice(2));
  const { source, fileName } = readSource(town);
  const junctions = buildJunctions(source);
  const hasNodeIds = junctions.some((j) => j.id !== null);
  const { tiles, stats } = assign(source, size);
  for (const junction of junctions) {
    const key = tileOf([junction.x, junction.y], size);
    const id = `${key.tx},${key.ty}`;
    if (!tiles.has(id)) tiles.set(id, { ...key, features: [] });
    (tiles.get(id).junctions ??= []).push(junction);
  }

  const outDir = path.join(TILES_DIR, town);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const entries = [...tiles.values()].sort((a, b) => a.ty - b.ty || a.tx - b.tx);
  const index = [];
  for (const tile of entries) {
    const name = tileName(town, tile);
    const body = `${JSON.stringify({
      type: 'FeatureCollection',
      units: 'meters',
      origin: source.origin,
      bbox: source.bbox,
      tile: {
        tx: tile.tx,
        ty: tile.ty,
        size,
        bounds: [tile.tx * size, tile.ty * size, (tile.tx + 1) * size, (tile.ty + 1) * size],
      },
      features: tile.features,
      junctions: tile.junctions ?? [],
    })}\n`;
    fs.writeFileSync(path.join(outDir, `${name}.geojson`), body);
    const count = { buildings: 0, roads: 0, other: 0 };
    for (const feature of tile.features) count[classify(feature)]++;
    index.push({
      tx: tile.tx,
      ty: tile.ty,
      file: `${name}.geojson`,
      ...count,
      junctions: tile.junctions?.length ?? 0,
      bytes: Buffer.byteLength(body),
    });
  }

  const grid = {
    minTx: Math.min(...entries.map((t) => t.tx)),
    maxTx: Math.max(...entries.map((t) => t.tx)),
    minTy: Math.min(...entries.map((t) => t.ty)),
    maxTy: Math.max(...entries.map((t) => t.ty)),
  };
  fs.writeFileSync(
    path.join(outDir, `${town}_index.json`),
    `${JSON.stringify({
      town,
      source: fileName,
      units: 'meters',
      origin: source.origin,
      bbox: source.bbox,
      tileSize: size,
      grid,
      tiles: index,
    }, null, 2)}\n`,
  );

  const max = (key) => index.reduce((best, t) => (t[key] > best[key] ? t : best), index[0]);
  const cells = (grid.maxTx - grid.minTx + 1) * (grid.maxTy - grid.minTy + 1);
  const total = (key) => index.reduce((sum, t) => sum + t[key], 0);
  const label = (t) => tileName(town, t);
  console.log(`Tile size: ${size} m, grid tx ${grid.minTx}..${grid.maxTx}, ty ${grid.minTy}..${grid.maxTy}`);
  console.log(`Tiles written: ${index.length} (of ${cells} grid cells; empty cells skipped)`);
  console.log(`Buildings: ${total('buildings')} in ${index.length} tiles, max ${max('buildings').buildings} per tile (${label(max('buildings'))})`);
  console.log(`Road pieces: ${stats.pieces} from ${stats.roads} roads, max ${max('roads').roads} per tile (${label(max('roads'))})`);
  const kinds = countKinds(junctions);
  console.log(`Junctions: ${kinds.junctions} (dead ends: ${kinds.deadEnds}) by ${hasNodeIds ? 'node id' : 'coordinates'}`);
  if (hasNodeIds) {
    const byCoords = countKinds(buildJunctions(source, { useIds: false }));
    console.log(`  coordinate matching would find ${byCoords.junctions} (dead ends: ${byCoords.deadEnds})`);
  }
  console.log(`Largest tile: ${Math.round(max('bytes').bytes / 1024)} KB (${label(max('bytes'))})`);
  if (stats.multiPart) console.log(`Warning: ${stats.multiPart} multi-part features were placed by their first part.`);
  console.log(`Wrote ${path.relative(process.cwd(), outDir)}/ (${index.length} tiles + ${town}_index.json)`);
}

try {
  main();
} catch (error) {
  console.error(`tile_town: ${error.message}`);
  process.exitCode = 1;
}
