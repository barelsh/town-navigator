import { MAX_FAVORITES, SETTINGS_STORAGE_KEY } from '../config.ts';
import type { Appearance } from '../town/buildings.ts';
import { DEFAULT_VEHICLE, vehicleById } from '../car/vehicles.ts';

/** A point on the map in meters from the town's center: x east, y north. */
export interface MapPoint {
  x: number;
  y: number;
}

/** A saved place the car can be sent back to. */
export interface Favorite extends MapPoint {
  id: string;
  name: string;
}

export interface TownSettings {
  startPoint: MapPoint;
  favorites?: Favorite[];
}

export const DEFAULT_SPEED_LIMIT_KMH = 79;
export const MIN_SPEED_LIMIT_KMH = 10;
export const MAX_SPEED_LIMIT_KMH = 150; // faster could skip through walls on a 0.05 s frame

export interface Settings {
  version: 1;
  speedLimitKmh?: number;
  vehicle?: string;
  appearance?: Appearance;
  monitoring?: boolean;
  roadLock?: boolean;
  towns: Record<string, TownSettings | undefined>;
}

const DEFAULT_TOWN_SETTINGS: TownSettings = { startPoint: { x: 0, y: 0 } };

// The scene's z axis points south, so the conversion flips the sign.
export const toWorld = ({ x, y }: MapPoint) => ({ x, z: -y });
export const fromWorld = ({ x, z }: { x: number; z: number }): MapPoint => ({ x, y: -z });

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
    if (stored?.version === 1 && typeof stored.towns === 'object' && stored.towns !== null) return stored as Settings;
  } catch {
    // unreadable or blocked: fall through to defaults
  }
  return { version: 1, towns: {} };
}

export function speedLimitOf(settings: Settings): number {
  const kmh = settings.speedLimitKmh;
  return Number.isInteger(kmh) && kmh! >= MIN_SPEED_LIMIT_KMH && kmh! <= MAX_SPEED_LIMIT_KMH
    ? kmh! : DEFAULT_SPEED_LIMIT_KMH;
}

/** The saved vehicle id; unknown or missing ids give the default. */
export function vehicleOf(settings: Settings): string {
  return vehicleById(settings.vehicle ?? DEFAULT_VEHICLE).id;
}

/** The saved building view; unknown or missing values give Realistic. */
export function appearanceOf(settings: Settings): Appearance {
  return settings.appearance === 'plain' ? 'plain' : 'realistic';
}

/** Whether the performance panel is saved as on; missing means off. */
export function monitoringEnabled(settings: Settings): boolean {
  return settings.monitoring === true;
}

/** Whether Stick to roads is saved as on; missing means off. */
export function roadLockOf(settings: Settings): boolean {
  return settings.roadLock === true;
}

export function townSettings(settings: Settings, townId: string): TownSettings {
  const point = settings.towns[townId]?.startPoint;
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? { startPoint: point! } : DEFAULT_TOWN_SETTINGS;
}

/** The town's saved favorites; entries without an id, a name or finite coordinates are dropped. */
export function favoritesOf(settings: Settings, townId: string): Favorite[] {
  const list = settings.towns[townId]?.favorites;
  return Array.isArray(list)
    ? list.filter(f => typeof f?.id === 'string' && typeof f.name === 'string' && f.name.trim() !== ''
        && Number.isFinite(f.x) && Number.isFinite(f.y)).slice(0, MAX_FAVORITES)
    : [];
}

/** Writes the town's list, keeping its starting point. Returns false when the browser refused. */
export function saveFavorites(townId: string, favorites: Favorite[]): boolean {
  const latest = loadSettings();
  latest.towns[townId] = { ...townSettings(latest, townId), favorites };
  return saveSettings(latest);
}

/** Returns false when the browser refused to store it. */
export function saveSettings(settings: Settings): boolean {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
