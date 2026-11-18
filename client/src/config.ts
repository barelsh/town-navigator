// export const DEFAULT_TOWN = 'raw_min_tidhar2';
export const DEFAULT_TOWN = 'rosh_haayin';

export const SETTINGS_STORAGE_KEY = 'town-navigator:settings';
export const SETTINGS_SHORTCUT = 'KeyP';
export const MONITORING_SHORTCUT = 'KeyM';
export const APPEARANCE_SHORTCUT = 'KeyV';
export const FAVORITES_SHORTCUT = 'KeyF';
export const MAX_FAVORITES = 50;
export const FAVORITE_NAME_MAX = 40;

// 'tiles' streams the tiles around the car; 'whole' loads the whole town from GET /api/towns/:id (for debugging).
export const TOWN_LOAD_MODE: 'tiles' | 'whole' = 'tiles';
export const LOAD_RADIUS = 1;    // rings of tiles around the car's tile that are kept loaded (1 = 3 x 3)
export const UNLOAD_RADIUS = 2;  // loaded tiles farther than this many rings are disposed
export const MAX_IN_FLIGHT = 4;  // tile requests running at once
