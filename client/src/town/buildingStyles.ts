import type { TownProperties } from '@town-navigator/shared';

const LEVEL_HEIGHT = 3; // meters per building level

export type BuildingGroup = 'unknown' | 'house' | 'housing' | 'education' | 'public' | 'commercial';

export const GROUP_COLORS: Record<BuildingGroup, number> = {
  unknown: 0xd6d0c4, house: 0xd99a7a, housing: 0x8d9db0,
  education: 0xf0c040, public: 0x9c89b8, commercial: 0x2a9d8f,
};
const BUILDING_GROUPS: Record<string, BuildingGroup | undefined> = {
  detached: 'house', apartments: 'housing', residential: 'housing',
  school: 'education', kindergarten: 'education',
  public: 'public', synagogue: 'public',
  commercial: 'commercial', retail: 'commercial',
};
const RESIDENTIAL_GROUPS = new Set<BuildingGroup>(['house', 'housing']);

export const UNKNOWN_SHADES = [0.95, 0.975, 1, 1.025, 1.05]; // keeps untyped blocks from merging
export const ROOF_SHADE = 0.7;

const AMENITY_ICONS: Record<string, string | undefined> = {
  place_of_worship: '✡️', clinic: '🏥', townhall: '🏛️', fire_station: '🚒', police: '🚓',
  bank: '🏦', library: '📖', theatre: '🎭', marketplace: '🧺',
};
const BUILDING_ICONS: Record<string, string | undefined> = {
  retail: '🛒', commercial: '🛒', school: '📚', kindergarten: '🧸', synagogue: '✡️', public: '🏛️',
};

export function buildingGroup({ building, shop, office, amenity }: TownProperties): BuildingGroup {
  const group = BUILDING_GROUPS[building ?? ''];
  if (group) return group;
  if (shop || office) return 'commercial';
  return amenity ? 'public' : 'unknown';
}

// Only non-residential buildings get an icon.
export function buildingIcon(properties: TownProperties): string | null {
  if (RESIDENTIAL_GROUPS.has(buildingGroup(properties))) return null;
  const { amenity, shop, office, leisure, building } = properties;
  const amenityIcon = AMENITY_ICONS[amenity ?? ''];
  if (amenityIcon) return amenityIcon;
  if (shop) return '🛒';
  if (office) return '💼';
  if (leisure === 'sports_centre') return '🏋️';
  return BUILDING_ICONS[building ?? ''] ?? null;
}

export function buildingHeight(properties: TownProperties): number {
  const height = parseFloat(properties.height ?? '');
  if (height > 0) return height;
  const levels = parseFloat(properties['building:levels'] ?? '');
  return (levels > 0 ? levels : 1) * LEVEL_HEIGHT;
}
