import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Town } from '@town-navigator/shared';

const DATA_DIR = path.resolve(import.meta.dirname, '../../../data');
const VALID_TOWN_ID = /^[A-Za-z0-9_-]+$/; // keeps requests inside DATA_DIR
const DEFAULT_RAW_NAME = 'raw'; // normalize writes raw.geojson without a name suffix

function townFileName(id: string): string {
  return id === DEFAULT_RAW_NAME ? 'town_meters.geojson' : `town_meters_${id}.geojson`;
}

/** Returns the normalized town, or null when the id is invalid or has no file. */
export async function readTown(id: string): Promise<Town | null> {
  if (!VALID_TOWN_ID.test(id)) return null;

  try {
    const content = await readFile(path.join(DATA_DIR, townFileName(id)), 'utf8');
    return JSON.parse(content) as Town;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
