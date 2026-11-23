const METERS_PER_SECOND_TO_KMH = 3.6;

export interface SpeedDisplay {
  update(speed: number): void;
  /** Shows the ROAD pill while Stick to roads is on, dimmed while the car steers freely in a junction zone. */
  setRoadLock(on: boolean, free?: boolean): void;
}

export function createSpeedDisplay(): SpeedDisplay {
  const element = document.getElementById('speed')!;
  const pill = document.getElementById('road-pill')!;

  return {
    update(speed) {
      element.textContent = String(Math.round(Math.abs(speed) * METERS_PER_SECOND_TO_KMH));
    },
    setRoadLock(on, free = false) {
      pill.hidden = !on;
      pill.classList.toggle('free', on && free);
    },
  };
}
