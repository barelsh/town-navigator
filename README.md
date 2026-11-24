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
  services/   data access
  routing/    road graph, snapping, A* route search and maneuvers
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
- `npm test` - run the unit tests (`client/src/**/*.test.ts` and `server/src/**/*.test.ts`, e.g. the road graph and routing) with Node's built-in test runner

### controls
- `W` / `↑` accelerate, `S` / `↓` brake and reverse, `A` `D` / `←` `→` steer
- `C` switch camera, click a building for details
- `P` settings, `V` building view, `M` performance panel, `F` favorites, `N` navigation (see below)
- `R` stick to roads: the car stays on its road and `W` / `S` only set the speed (see below)
- `L` (development only) save the debug log, see below
- With the performance panel on (`M`), a road graph overlay draws on the nearby roads: an orange ring per junction zone (red for dead ends), a disc per junction and a tick per exit, green if you can drive out on it and gray if it is one-way in. Close junctions, such as roundabouts and dual-carriageway crossings, share one zone.
- `B` tile map: a north-up map of the town's tile grid showing which tiles are loaded, loading, failed or not loaded, the 3 x 3 around the car and the car's heading. Driving input pauses while it is open.

### debug log
In development (`npm run dev`) the client keeps a flight recorder: the last ~100 s of frames and the events around them. It is for chasing frame-rate drops and flicker. Press `L` right after it happens and it is written to `logs/debug-<time>.json` (git-ignored) through the dev server, or downloaded if the server doesn't answer. A toast shows the file name.
- one row per frame (`fields` names the columns): the time between frames, milliseconds spent in tiles, car, camera, HUD and render, the car's position, heading, speed and held keys, the road lock's insides (mode, zone, track segment, snap offset, candidate exit), the camera's position and distance to the car, draw calls, triangles, geometries and the JS heap
- events: zone captures and exits with their distances, road graph and overlay rebuilds with their time, tile changes, key presses, dialogs, settings saves, tab visibility and focus, window resizes, slow frames and page errors
- recording allocates nothing per frame, and none of it is in the production build

### stick to roads
- Press `R`, or tick Stick to roads under Driving in the settings (`P`). It is saved in the browser. A `ROAD` pill floating at the top center of the window shows it is on (above the street name in a narrow window). Between junctions `A` `D` don't steer: they choose the next turn (see below).
- Turning it on, and every teleport (a new starting point, Go to on a favorite), snaps the car to the nearest drivable road, facing the way it already faced. Without a road nearby it stays off.
- The car keeps to the right-hand lane of two-way roads (1.75 m right of the center line at most) and drives on the center line of one-way roads. It eases around curves.
- Junctions, roundabouts and dead ends are zones (the ring drawn by the overlay with `M`). A locked car enters a zone only if its own road runs into it, about 0.3 s of speed before the zone's edge. Inside, the car is free again and collision applies, and the `ROAD` pill dims: it steers itself onto the exit chosen as below, or you steer by holding `A` `D`. When the car leaves the zone it locks onto the legal exit closest to its direction of travel, merging onto the lane over about a second. The overlay brightens the exit it would take. One-way-in branches never count as exits.
- A zone with no legal exit within 100 degrees of the direction of travel holds the car at its edge. This is how dead ends work: stop, back up and steer around, and drive out the way you came. Reversing works the same way, matched by the direction of travel, so reversing into a T-junction and steering backs out onto the side road.
- Where a town has no junction data (whole-town mode, tiles written before the junctions were added) there are no zones: the car takes the road closest to straight ahead at a junction and stops at a dead end. Choosing the turn ahead of a junction needs the zones, so it only works where there is junction data.
- Choosing the turn: tap `A` (left) or `D` (right) before a junction to queue a turn for the next one. A big chip next to the `ROAD` pill (`◀ Next left`, `Next right ▶`) names it, and a violet arrow with a flowing white core is drawn on the road from the car's lane at the zone's edge to the lane of the exit it will take. Tap the other key to cancel. The arrow shows from 120 m before a zone, and only for a turn of more than 30 degrees. With no turn queued the car takes the exit closest to straight, or the smallest turn when there is none. A turn with no exit on that side stays queued for the next junction. Reversing ignores it.
- Inside the zone the car steers itself onto the target exit and slows to 25 km/h, braking at 6 m/s² from the braking distance before the zone. A zone that follows within 40 m of the exit it just left keeps the 25 km/h cap through the gap. A quick tap (under 250 ms) of `A` or `D` inside the zone moves the target one exit to that side, so in a roundabout you tap until the arrow points where you want. Holding a key longer than that steers by hand, as before, and hides the arrow; 0.4 s after you let go, the car heads for the exit it now points at. The arrow is the route, and auto-steer drives exactly it (it steers toward a point a few meters ahead on the arrow). Through a single junction it is a smooth curve from the entry lane to the exit lane. Through a zone of several junctions, a roundabout or a dual-carriageway crossing, it follows the real roads between them in their direction of travel, so a roundabout is driven around its ring and a left turn there goes the long way around.
- U-turn at a dead end: tap `A` or `D` before a dead end and the arrow draws a U, in the lane you drive in and out along the lane of the road coming back. The car goes through it at 20 km/h with a harder steering lock than the keys give, and leaves the way it came. With no turn queued the car stops at the dead end, as before.
- Building collision is skipped while it is on, since the road decides where the car can be. Turning it off hands steering and collision back.

### navigation
- Press `N`, or the arrow button at the top of the corner buttons, to open the Navigation dialog. It lists the town's favorites (save them with `F`) with their straight-line distance from the car. Navigate asks the server for the shortest legal route from the car (`POST /api/towns/:id/route`, see Routing) and closes the dialog.
- Guidance only: the route never steers the car. A card at the top of the screen names the next turn (`⟲ Roundabout, 2nd exit`, `↰ Turn left`, ...) with the road it leads onto, counts down the meters to it, and shows the destination with the distance and time left. When the turn after it comes within 80 m, a `then` line names it too. The card pulses 150 m and 50 m before each turn. Straight-throughs are only named when another way there is straighter. With Stick to roads on, you still choose each turn with `A` `D`.
- Leaving the route (more than 20 m off it for 2 s, or driving against it for 3 s) asks for a new route from where the car is (`Rerouting…`), at most every 3 s. Go to on a favorite, or a new starting point, reroutes at once.
- Within 20 m of the destination the card shows `Arrived at ...` for 4 s and navigation ends. The card's `×`, or Stop in the dialog, ends it at any time. While it runs, the arrow button has a cyan ring.
- If no road leads near the favorite, the card shows the server's message for 6 s. If the server can't be reached it retries after 2, 4 and 8 s. Navigation is not saved: a reload starts without it.

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
- `POST /api/towns/:id/route` - the shortest legal route by distance; see Routing below

### routing
`POST /api/towns/:id/route` with `{ "from": { "x", "y", "bearing" }, "to": { "x", "y" } }` in the town's map meters (x east, y north; bearing in degrees clockwise from north) returns a `Route` (`shared/src/route.ts`): the distance, the polyline, one stretch per road piece (highway, one-way, name), the snapped start and destination, and one maneuver per junction (`roundabout` with its exit number, `left`, `slight_right`, ...).

```
curl -s -X POST localhost:3000/api/towns/rosh_haayin/route -H 'content-type: application/json' \
  -d '{"from":{"x":-18.3,"y":-7.9,"bearing":0},"to":{"x":-2009,"y":609}}'
```

- The server builds the town's road graph from `data/town_meters_<town>.geojson` on the first route request (roads cut at every junction and dead end, by OSM node id), keeps it in memory, and rebuilds it when the file changes. Rosh HaAyin: 2,370 nodes and 4,636 directed edges, built in about 20 ms.
- The search is edge-based A* with the straight line to the destination as its heuristic, so it returns the same shortest route as Dijkstra while settling far fewer edges; a route takes a few milliseconds.
- Respected: one-way roads (`oneway`, `junction=roundabout`, the same rules as the tiler, shared in `data/scripts/roadRules.js`), turn restrictions with a via node, and no U-turns except at dead ends. The car joins the road in the direction it faces (standing on a junction node, it counts as arriving there); turning back costs 50 m, and such a route starts with a `uturn` maneuver at 0 m.
- Not respected: turn restrictions with a via way (skipped and counted in the log), access tags, speeds and traffic signals. The cost is distance only.
- Errors: 400 for a bad body, 404 for an unknown town, 422 when no road is within 60 m of either end or there is no legal route.


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
