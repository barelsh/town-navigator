# town-navigator

## purpose
Make demo web app that can navigate through a town.



### tech
using three.js for rendering the 3D navigator.
geojson input file to generate based on a real imported data.

- client: TypeScript + three.js, bundled with Vite
- server: TypeScript on Node (24+) with Fastify, serves the town data and the built client
- npm workspaces: `client`, `server`, `shared` (types used by both)

### structure
```
client/src/
  main.ts     loads the town, wires the modules, runs the frame loop
  api/        calls to the server
  scene/      renderer, camera, lights, ground
  town/       roads, buildings, street labels, collision, tileManager (loads and disposes tiles around the car)
  car/        car model and driving
  camera/     chase and top-down camera
  hud/        compass, speed, current street
server/src/
  app.ts      Fastify app
  routes/     HTTP endpoints
  services/   data access, future navigation logic
shared/src/   types shared by client and server
data/         input files and scripts
```

### commands
- `npm install` - install everything
- `npm run normalize -- raw_min_tidhar2.geojson` - generate the town file the app loads
- `npm run normalize -- raw_rosh_haayin.osm.json rosh_haayin` - normalize a raw OSM export; the optional second argument sets the town id of the output
- `npm run tile -- rosh_haayin` - split a normalized town into 500 m tiles for streaming. An optional second argument sets the tile size in meters
- `npm run dev` - run server and client with auto-reload, open http://localhost:5173
- `npm run build` then `npm start` - run the built app, open http://localhost:3000
- `npm run typecheck` - check types in all packages
- `npm test` - run the unit tests (`client/src/**/*.test.ts`, e.g. the road graph) with Node's built-in test runner

### controls
- `W` / `↑` accelerate, `S` / `↓` brake and reverse, `A` `D` / `←` `→` steer
- `C` switch camera, click a building for details
- `P` settings, `V` building view, `M` performance panel, `F` favorites
- With the performance panel on (`M`), a road graph overlay draws on the nearby roads: an orange ring per junction zone (red for dead ends), a disc per junction and a tick per exit, green if you can drive out on it and gray if it is one-way in. Close junctions, such as roundabouts and dual-carriageway crossings, share one zone.
- `B` tile map: a north-up map of the town's tile grid showing which tiles are loaded, loading, failed or not loaded, the 3 x 3 around the car and the car's heading. Driving input pauses while it is open.

### tile streaming
- The client fetches `/api/towns/:id/index` and keeps the 3 x 3 tiles around the car's tile loaded, which reaches 500 m past the car, beyond the 450 m fog.
- Tiles more than 2 rings away are disposed, and in-flight requests for them are aborted.
- At most 4 requests run at once, and one tile is built per frame. A failed request is retried after 1, 2 and 4 seconds.
- Press `B` to open the tile map and watch which tiles are loaded as the car drives.
- Collision, the street name, the start point and picking use only the tiles around the car.
- Set `TOWN_LOAD_MODE = 'whole'` in `client/src/config.ts` to load the whole town from `/api/towns/:id` instead.

### api
- `GET /api/towns/:id` - a normalized town, e.g. `/api/towns/raw_min_tidhar2` reads `data/town_meters_raw_min_tidhar2.geojson`
- `GET /api/towns/:id/index` - the town's tile index, e.g. `/api/towns/rosh_haayin/index` reads `data/tiles/rosh_haayin/rosh_haayin_index.json`: tile size, grid range, bbox and the list of non-empty tiles with their counts
- `GET /api/towns/:id/tiles/:tx/:ty` - one tile, e.g. `/api/towns/rosh_haayin/tiles/-1/-1` reads `data/tiles/rosh_haayin/rosh_haayin_-1_-1.geojson`. 404 for tiles that are not in the index
- Both are cached for 5 minutes. Generate the files with `npm run tile -- <town>`. `GET /api/towns/:id` still returns the whole town, for debugging.


### data
'data' dir contains the input files with scripts that initiate it.

files:
-  raw.geojson - the raw geojson file exported from outer source. For example 'https://overpass-turbo.eu/
- raw_<town>.osm.json - a raw Overpass OSM JSON export (see export below). Preferred over GeoJSON: it keeps node ids, tagged nodes and turn restrictions.
- town_meters.geojson - generated from raw.geojson. Same entities, with [x east, y north] coordinates in meters around the town center. Not for use in map tools, which expect lat-lon.

scripts:
- normalize_coordinates.js - adjusts the lat-lon coordinates of raw.geojson entities into town_meters.geojson. Run with `npm run normalize`, or `npm run normalize -- other.geojson` to use a different raw file in the data dir, which writes town_meters_other.geojson. An input with an `elements` array is raw OSM JSON: it is converted with osmtogeojson, and a trailing `.osm` is dropped from the name (`other.osm.json` writes town_meters_other.geojson). An optional second argument sets the town id: `npm run normalize -- raw_rosh_haayin.osm.json rosh_haayin` writes town_meters_rosh_haayin.geojson.
- tile_town.js - splits a normalized town into tiles. Run with `npm run tile -- <town>` (e.g. `rosh_haayin` reads town_meters_rosh_haayin.geojson), or `npm run tile -- <town> 1000` for a different tile size in meters.

pipeline: `raw_<town>.osm.json` (or `.geojson`) -> `npm run normalize` -> `town_meters_<town>.geojson` -> `npm run tile` -> `tiles/<town>/`

export (manual): in https://overpass-turbo.eu/ run

```
[out:json][timeout:180];
{{geocodeArea:Rosh HaAyin}}->.a;
( way["highway"](area.a); way["building"](area.a); )->.f;
.f out body;
node(w.f); out body qt;                       // every node of those ways, with its tags
rel(bw.f)["type"="restriction"]; out body;    // turn restrictions
```

then Export -> Data -> raw OSM data, and save it as `data/raw_<town>.osm.json`. Use `out body` for the nodes, not `skel`, or the node tags are lost.

what the normalized town file keeps from an OSM export (backend only, served by `GET /api/towns/:id` but stripped from tiles):
- features have the same geometry and properties as an overpass-turbo GeoJSON export: `{ '@id': 'way/123', ...tags }`
- every way LineString also has a top-level `osm: { nodes: [id, ...] }`, 1:1 with its coordinates
- tagged nodes (traffic signals, stop signs, turning circles...) are Point features with id `node/<id>`
- the collection has `osm.restrictions`: the `type=restriction` relations as `{ id, tags, members: [{ type, ref, role }] }`

tiles (generated, git-ignored):
- tiles/<town>/<town>_<tx>_<ty>.geojson - one file per non-empty tile, a FeatureCollection in the same meter space as the town file, with the town's `origin` and `bbox` plus `tile: { tx, ty, size, bounds }`, so a tile is a valid town. Tiles leave out `osm` and the tagged-node Points, and add `junctions`: every drivable road node in the tile where 3 or more branches meet (`kind: 'junction'`) or a road ends (`kind: 'dead_end'`), as `{ id, x, y, kind, control?, branches }`. `id` is the OSM node id, or `null` for towns without node ids, which are matched by coordinates. `control` is the node's `traffic_signals`, `stop`, `give_way`, `mini_roundabout` or `turning_circle` tag. Each branch is one direction a road leaves the node in: a unit vector `dx`, `dy` toward the next vertex, the road's `highway`, `lanes` and `name`, and `flow`: `both` for two-way roads, `out` when one-way traffic leaves along it, `in` when it may only arrive.
- tiles/<town>/<town>_index.json - `town`, `source`, `units`, `origin`, `bbox`, `tileSize`, `grid` (`minTx`, `maxTx`, `minTy`, `maxTy`) and `tiles`: one entry per tile with `tx`, `ty`, `file`, `buildings`, `roads`, `other` and `junctions` counts and `bytes`.

The grid is anchored at the origin (0, 0): `tx = floor(x / size)`, `ty = floor(y / size)`, y north, so tile (0, 0) covers x 0 to 500 and y 0 to 500. The default size is 500 m: a 3 x 3 window of tiles around the car reaches 500 m past it, beyond the 450 m fog. A building goes whole to the tile of its centroid. A road is cut where it crosses a tile border; each piece keeps the road's properties and id and gets `properties.part` (0, 1, 2...). Re-running deletes and rewrites `tiles/<town>/`.
