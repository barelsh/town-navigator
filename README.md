# town-navigator

## purpose
Make demo web app that can navigate through a town.



### tech
using three.js for rendering the 3D navigator.
geojson input file to generate based on a real imported data.


### data
'data' dir contains the input files with scripts that initiate it.

files:
-  raw.geojson - the raw geojson file exported from outer source. For example 'https://overpass-turbo.eu/
- town_meters.geojson - generated from raw.geojson. Same entities, with [x east, y north] coordinates in meters around the town center. Not for use in map tools, which expect lat-lon.

scripts:
- normalize_coordinates.js - adjusts the lat-lon coordinates of raw.geojson entities into town_meters.geojson. Run with `npm run normalize`, or `npm run normalize -- other.geojson` to use a different raw file in the data dir, which writes town_meters_other.geojson.
