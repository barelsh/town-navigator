import { SETTINGS_STORAGE_KEY } from '../config.ts';

/** A point on the map in meters from the town's center: x east, y north. */
export interface MapPoint {
  x: number;
  y: number;
}

export interface TownSettings {
  startPoint: MapPoint;
}

export const DEFAULT_SPEED_LIMIT_KMH = 79;
export const MIN_SPEED_LIMIT_KMH = 10;
export const MAX_SPEED_LIMIT_KMH = 150; // faster could skip through walls on a 0.05 s frame

export interface Settings {
  version: 1;
  speedLimitKmh?: number;
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

export function townSettings(settings: Settings, townId: string): TownSettings {
  const point = settings.towns[townId]?.startPoint;
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) ? { startPoint: point! } : DEFAULT_TOWN_SETTINGS;
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
