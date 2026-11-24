// Road rules shared by the tiler (tile_town.js) and the server's route graph
// (server/src/routing/graph.ts), so the tiles' junctions and the router always agree
// on which roads are drivable, which way they run and where they meet.

// Keep in sync with ROAD_STYLES layer >= MIN_DRIVABLE_LAYER in client/src/town/roadStyles.ts.
const DRIVABLE_HIGHWAYS = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'trunk_link', 'primary_link',
  'secondary_link', 'tertiary_link', 'residential', 'unclassified', 'road', 'living_street', 'service']);

/**
 * Which way traffic may run along a road's coordinates: 1 forward only (oneway=yes|1|true,
 * or junction=roundabout), -1 backward only (oneway=-1), 0 both ways.
 */
function onewayOf(properties) {
  const p = properties ?? {};
  if (p.oneway === 'yes' || p.oneway === '1' || p.oneway === 'true' || p.junction === 'roundabout') return 1;
  if (p.oneway === '-1') return -1;
  return 0;
}

/**
 * The degree of every node of the given roads: +1 where a road ends, +2 where it passes through.
 * keyOf(feature, i) names the node at coordinate i (an OSM node id, or a coordinate string).
 */
function nodeDegrees(roads, keyOf) {
  const degrees = new Map();
  for (const f of roads) {
    const last = f.geometry.coordinates.length - 1;
    for (let i = 0; i <= last; i++) {
      const key = keyOf(f, i);
      degrees.set(key, (degrees.get(key) ?? 0) + (i === 0 || i === last ? 1 : 2));
    }
  }
  return degrees;
}

module.exports = { DRIVABLE_HIGHWAYS, onewayOf, nodeDegrees };
