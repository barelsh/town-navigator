import type { ApiError, Route, RouteRequest, TileIndex, Town, TownTile } from '@town-navigator/shared';

/** A failed request, with the HTTP status so callers can tell a missing file (404) from a broken server. */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(url: string, fallback: string, signal?: AbortSignal, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new HttpError(body?.message ?? `${fallback} (HTTP ${response.status})`, response.status);
  }
  return (await response.json()) as T;
}

export function fetchTown(id: string): Promise<Town> {
  return getJson<Town>(`/api/towns/${encodeURIComponent(id)}`, `Could not load town "${id}"`);
}

export function fetchTileIndex(id: string): Promise<TileIndex> {
  return getJson<TileIndex>(`/api/towns/${encodeURIComponent(id)}/index`, `Could not load the tile index of "${id}"`);
}

export function fetchTile(id: string, tx: number, ty: number, signal?: AbortSignal): Promise<TownTile> {
  return getJson<TownTile>(
    `/api/towns/${encodeURIComponent(id)}/tiles/${tx}/${ty}`, `Could not load tile ${tx}, ${ty} of "${id}"`, signal);
}

/** The shortest legal route from the car to a point (TN-38). 422 carries a message to show. */
export function fetchRoute(id: string, body: RouteRequest, signal?: AbortSignal): Promise<Route> {
  return getJson<Route>(`/api/towns/${encodeURIComponent(id)}/route`, 'Could not get a route', signal, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
