import type { Position } from 'geojson';
import type { BuildingFeature, TownProperties } from '@town-navigator/shared';
import { buildingGroup, buildingHeight, buildingIcon, GROUP_COLORS, LEVEL_HEIGHT, type BuildingGroup } from './buildingStyles.ts';

export interface BuildingInfo {
  id: string;
  title: string;
  icon: string | null;
  group: string;      // label, e.g. "Apartments and housing"
  color: number;      // GROUP_COLORS value for the swatch
  height: number;
  heightSource: string;
  footprint: number;  // square meters: outer ring minus holes
  corners: number;
  tags: [key: string, value: string][]; // properties in file order, without @id
}

const GROUP_LABELS: Record<BuildingGroup, string> = {
  unknown: 'Unknown type', house: 'House', housing: 'Apartments and housing',
  education: 'Education', public: 'Public and religious', commercial: 'Commercial',
};
const TYPE_LABELS: Record<string, string | undefined> = {
  apartments: 'Apartments', school: 'School', detached: 'House', residential: 'Residential building',
  kindergarten: 'Kindergarten', public: 'Public building', synagogue: 'Synagogue',
  commercial: 'Commercial building', retail: 'Retail building',
};

function buildingTitle(properties: TownProperties): string {
  const { name, building } = properties;
  const street = properties['addr:street'], houseNumber = properties['addr:housenumber'];
  if (name) return name;
  if (street && houseNumber) return `${street} ${houseNumber}`;
  return TYPE_LABELS[building ?? ''] ?? 'Building';
}

// Applies the same checks as buildingHeight.
function heightSource(properties: TownProperties): string {
  if (parseFloat(properties.height ?? '') > 0) return 'from height tag';
  const levels = parseFloat(properties['building:levels'] ?? '');
  if (levels > 0) return `${levels} ${levels === 1 ? 'level' : 'levels'} × ${LEVEL_HEIGHT} m`;
  return 'assumed 1 level';
}

// Shoelace formula. GeoJSON rings repeat their first point at the end.
function ringArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return Math.abs(sum) / 2;
}

export function buildingInfo({ id, properties, geometry }: BuildingFeature): BuildingInfo {
  const [outer, ...holes] = geometry.coordinates;
  const group = buildingGroup(properties);

  return {
    id: String(id ?? properties['@id'] ?? ''),
    title: buildingTitle(properties),
    icon: buildingIcon(properties),
    group: GROUP_LABELS[group],
    color: GROUP_COLORS[group],
    height: buildingHeight(properties),
    heightSource: heightSource(properties),
    footprint: holes.reduce((area, hole) => area - ringArea(hole), ringArea(outer)),
    corners: outer.length - 1,
    tags: Object.entries(properties).filter(
      (tag): tag is [string, string] => tag[0] !== '@id' && tag[1] !== undefined
    ),
  };
}
