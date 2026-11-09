import type { Vector3 } from 'three';

const UPDATE_INTERVAL = 0.25; // seconds

export interface StreetReadout {
  update(dt: number, carPosition: Vector3): void;
}

export function createStreetReadout(findStreet: (x: number, z: number) => string | null): StreetReadout {
  const readout = document.getElementById('street')!;
  let updateIn = 0;

  return {
    update(dt, carPosition) {
      updateIn -= dt;
      if (updateIn > 0) return;
      updateIn = UPDATE_INTERVAL;

      const name = findStreet(carPosition.x, carPosition.z);
      readout.hidden = !name;
      if (name && readout.textContent !== name) readout.textContent = name;
    },
  };
}
