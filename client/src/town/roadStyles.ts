import type { TownProperties } from '@town-navigator/shared';

export const MIN_DRIVABLE_LAYER = 3; // service roads and above; excludes tracks and paths

const LANE_WIDTH = 3.5;

const ASPHALT = 0x3b3f46, PAVERS = 0x8f8a80, CONCRETE = 0xa9a9a4, DIRT = 0x9a7b54;
const FOOTPATH = 0xc9c4b8, CYCLE_LANE = 0xa8584a;

export interface RoadStyle {
  width: number; // meters
  color: number;
  layer: number; // higher layers draw on top where roads meet
  line: boolean; // center line
}

// Types not listed here (e.g. proposed roads) are not drawn.
const ROAD_STYLES: Record<string, Omit<RoadStyle, 'line'> & { line?: boolean } | undefined> = {
  motorway:       { width: 12,  color: ASPHALT,    layer: 7, line: true },
  trunk:          { width: 11,  color: ASPHALT,    layer: 7, line: true },
  primary:        { width: 10,  color: ASPHALT,    layer: 7, line: true },
  secondary:      { width: 9,   color: ASPHALT,    layer: 6, line: true },
  tertiary:       { width: 8,   color: ASPHALT,    layer: 6, line: true },
  trunk_link:     { width: 5.5, color: ASPHALT,    layer: 5 },
  primary_link:   { width: 5.5, color: ASPHALT,    layer: 5 },
  secondary_link: { width: 5.5, color: ASPHALT,    layer: 5 },
  tertiary_link:  { width: 5.5, color: ASPHALT,    layer: 5 },
  residential:    { width: 6.5, color: ASPHALT,    layer: 4, line: true },
  unclassified:   { width: 6,   color: ASPHALT,    layer: 4, line: true },
  road:           { width: 6,   color: ASPHALT,    layer: 4, line: true },
  living_street:  { width: 5,   color: ASPHALT,    layer: 4 },
  service:        { width: 4,   color: ASPHALT,    layer: 3 },
  track:          { width: 3,   color: DIRT,       layer: 2 },
  cycleway:       { width: 2.5, color: CYCLE_LANE, layer: 1 },
  pedestrian:     { width: 4,   color: FOOTPATH,   layer: 0 },
  footway:        { width: 2,   color: FOOTPATH,   layer: 0 },
  steps:          { width: 2,   color: FOOTPATH,   layer: 0 },
  path:           { width: 1.5, color: FOOTPATH,   layer: 0 },
};

const SURFACE_COLORS: Record<string, number | undefined> = {
  asphalt: ASPHALT, concrete: CONCRETE, paving_stones: PAVERS, sett: PAVERS, ground: DIRT, unpaved: DIRT,
};

export function roadStyle({ highway, lanes, surface }: TownProperties): RoadStyle | null {
  const style = ROAD_STYLES[highway ?? ''];
  if (!style) return null;
  const laneCount = parseInt(lanes ?? '', 10);
  return {
    ...style,
    width: laneCount > 0 ? laneCount * LANE_WIDTH : style.width,
    color: SURFACE_COLORS[surface ?? ''] ?? style.color,
    line: Boolean(style.line) && laneCount !== 1,
  };
}
