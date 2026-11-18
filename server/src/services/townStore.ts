import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Town } from '@town-navigator/shared';

const DATA_DIR = path.resolve(import.meta.dirname, '../../../data');
const VALID_TOWN_ID = /^[A-Za-z0-9_-]+$/; // keeps requests inside DATA_DIR
const DEFAULT_RAW_NAME = 'raw'; // normalize writes raw.geojson without a name suffix

function townFileName(id: string): string {
  return id === DEFAULT_RAW_NAME ? 'town_meters.geojson' : `town_meters_${id}.geojson`;
}

const TILES_DIR = path.join(DATA_DIR, 'tiles');
const VALID_TILE_COORD = /^-?\d{1,4}$/;

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Returns the normalized town, or null when the id is invalid or has no file. */
export async function readTown(id: string): Promise<Town | null> {
  if (!VALID_TOWN_ID.test(id)) return null;

  const content = await readOptional(path.join(DATA_DIR, townFileName(id)));
  return content ? (JSON.parse(content) as Town) : null;
}

/** The tile index JSON as stored, or null when the id is invalid or the town was never tiled. */
export function readTileIndexFile(id: string): Promise<string | null> {
  if (!VALID_TOWN_ID.test(id)) return Promise.resolve(null);
  return readOptional(path.join(TILES_DIR, id, `${id}_index.json`));
}

/** One tile's GeoJSON as stored, or null when the id or coordinates are invalid or the tile has no file. */
export function readTileFile(id: string, tx: string, ty: string): Promise<string | null> {
  if (!VALID_TOWN_ID.test(id) || !VALID_TILE_COORD.test(tx) || !VALID_TILE_COORD.test(ty)) {
    return Promise.resolve(null);
  }
  // Number() turns "-0" and "007" into the names the tiler writes.
  return readOptional(path.join(TILES_DIR, id, `${id}_${Number(tx)}_${Number(ty)}.geojson`));
}
