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
