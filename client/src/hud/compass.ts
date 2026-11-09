import * as THREE from 'three';

const COMPASS_POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export interface Compass {
  update(heading: number): void;
}

export function createCompass(): Compass {
  const dial = document.getElementById('compass-dial')!;
  const letters = dial.querySelectorAll('text');
  const reading = document.getElementById('compass-reading')!;

  return {
    update(heading) {
      // Car forward is (sin, cos) in (x, z) and north is -z, so bearing = 180° - heading.
      const bearing = THREE.MathUtils.euclideanModulo(180 - THREE.MathUtils.radToDeg(heading), 360);

      // The needle stays pointing up; the dial turns under it, with upright letters.
      dial.setAttribute('transform', `rotate(${-bearing})`);
      letters.forEach(letter => letter.setAttribute('transform', `rotate(${bearing})`));

      const degrees = Math.round(bearing) % 360;
      reading.textContent = `${degrees}° ${COMPASS_POINTS[Math.round(bearing / 45) % 8]}`;
    },
  };
}
