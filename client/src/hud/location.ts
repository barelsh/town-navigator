import type { Vector3 } from 'three';
import { fromWorld, type MapPoint } from '../settings/settingsStore.ts';

const UPDATE_INTERVAL = 0.25; // seconds, like the street readout

export const roundMeters = (n: number) => Math.round(n * 10) / 10;
/** One decimal, and never "-0.0". */
export const formatMeters = (n: number) => (roundMeters(n) || 0).toFixed(1);
export const formatPlace = (p: MapPoint) => `E ${formatMeters(p.x)} · N ${formatMeters(p.y)}`;

export interface LocationReadout {
  update(dt: number, carPosition: Vector3): void;
}

export function createLocationReadout(): LocationReadout {
  const xOut = document.getElementById('location-x')!;
  const yOut = document.getElementById('location-y')!;
  let updateIn = 0;

  return {
    update(dt, carPosition) {
      updateIn -= dt;
      if (updateIn > 0) return;
      updateIn = UPDATE_INTERVAL;

      const { x, y } = fromWorld(carPosition);
      const ex = formatMeters(x);
      const ny = formatMeters(y);
      if (xOut.textContent !== ex) xOut.textContent = ex;
      if (yOut.textContent !== ny) yOut.textContent = ny;
    },
  };
}
