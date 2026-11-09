import type { ApiError, Town } from '@town-navigator/shared';

export async function fetchTown(id: string): Promise<Town> {
  const response = await fetch(`/api/towns/${encodeURIComponent(id)}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.message ?? `Could not load town "${id}" (HTTP ${response.status})`);
  }
  return (await response.json()) as Town;
}
