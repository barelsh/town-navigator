// Types for roadRules.js, so the TypeScript server can import the plain-JS rules.

export const DRIVABLE_HIGHWAYS: Set<string>;
export function onewayOf(properties: Record<string, string | undefined> | null | undefined): 1 | -1 | 0;
export function nodeDegrees<F extends { geometry: { coordinates: unknown[] } }, K>(
  roads: Iterable<F>, keyOf: (feature: F, index: number) => K): Map<K, number>;
