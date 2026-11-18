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
  town/       roads, buildings, street labels, collision
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
- `npm run tile -- rosh_haayin` - split a normalized town into 500 m tiles for streaming. An optional second argument sets the tile size in meters
- `npm run dev` - run server and client with auto-reload, open http://localhost:5173
- `npm run build` then `npm start` - run the built app, open http://localhost:3000
- `npm run typecheck` - check types in all packages

### api
- `GET /api/towns/:id` - a normalized town, e.g. `/api/towns/raw_min_tidhar2` reads `data/town_meters_raw_min_tidhar2.geojson`


### data
'data' dir contains the input files with scripts that initiate it.

files:
-  raw.geojson - the raw geojson file exported from outer source. For example 'https://overpass-turbo.eu/
- town_meters.geojson - generated from raw.geojson. Same entities, with [x east, y north] coordinates in meters around the town center. Not for use in map tools, which expect lat-lon.

scripts:
- normalize_coordinates.js - adjusts the lat-lon coordinates of raw.geojson entities into town_meters.geojson. Run with `npm run normalize`, or `npm run normalize -- other.geojson` to use a different raw file in the data dir, which writes town_meters_other.geojson.
- tile_town.js - splits a normalized town into tiles. Run with `npm run tile -- <town>` (e.g. `rosh_haayin` reads town_meters_rosh_haayin.geojson), or `npm run tile -- <town> 1000` for a different tile size in meters.

pipeline: `raw_<town>.geojson` -> `npm run normalize` -> `town_meters_<town>.geojson` -> `npm run tile` -> `tiles/<town>/`

tiles (generated, git-ignored):
- tiles/<town>/<town>_<tx>_<ty>.geojson - one file per non-empty tile, a FeatureCollection in the same meter space as the town file, with the town's `origin` and `bbox` plus `tile: { tx, ty, size, bounds }`, so a tile is a valid town.
- tiles/<town>/<town>_index.json - `town`, `source`, `units`, `origin`, `bbox`, `tileSize`, `grid` (`minTx`, `maxTx`, `minTy`, `maxTy`) and `tiles`: one entry per tile with `tx`, `ty`, `file`, `buildings`, `roads`, `other` counts and `bytes`.

The grid is anchored at the origin (0, 0): `tx = floor(x / size)`, `ty = floor(y / size)`, y north, so tile (0, 0) covers x 0 to 500 and y 0 to 500. The default size is 500 m: a 3 x 3 window of tiles around the car reaches 500 m past it, beyond the 450 m fog. A building goes whole to the tile of its centroid. A road is cut where it crosses a tile border; each piece keeps the road's properties and id and gets `properties.part` (0, 1, 2...). Re-running deletes and rewrites `tiles/<town>/`.
