const METERS_PER_SECOND_TO_KMH = 3.6;

export interface SpeedDisplay {
  update(speed: number): void;
}

export function createSpeedDisplay(): SpeedDisplay {
  const element = document.getElementById('speed')!;

  return {
    update(speed) {
      element.textContent = String(Math.round(Math.abs(speed) * METERS_PER_SECOND_TO_KMH));
    },
  };
}
