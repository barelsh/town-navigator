import * as THREE from 'three';
import type { StartPosition } from '../town/roads.ts';
import { WHEEL_RADIUS, type CarModel } from './carModel.ts';

const MAX = 22, ACCEL = 14, BRAKE = 24, FRICTION = 6;

export interface CarController {
  readonly position: THREE.Vector3;
  readonly heading: number;
  readonly speed: number;
  update(dt: number): void;
}

export function createCarController(
  { group, wheels }: CarModel,
  start: StartPosition,
  isBlocked: (x: number, z: number) => boolean
): CarController {
  const keys: Record<string, boolean> = {};
  addEventListener('keydown', e => { keys[e.code] = true; });
  addEventListener('keyup', e => { keys[e.code] = false; });

  group.position.set(start.x, 0, start.z);
  group.rotation.y = start.heading;

  let speed = 0, heading = start.heading;
  const forward = new THREE.Vector3();

  return {
    position: group.position,
    get heading() { return heading; },
    get speed() { return speed; },

    update(dt) {
      const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
      const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;

      if (up) speed += ACCEL * dt;
      else if (down) speed -= (speed > 0 ? BRAKE : ACCEL * 0.6) * dt;
      else speed -= Math.sign(speed) * Math.min(Math.abs(speed), FRICTION * dt);
      speed = THREE.MathUtils.clamp(speed, -MAX * 0.4, MAX);

      const steer = (left ? 1 : 0) - (right ? 1 : 0);
      heading += steer * dt * 2.2 * THREE.MathUtils.clamp(speed / 8, -1, 1);

      forward.set(Math.sin(heading), 0, Math.cos(heading));
      const previous = group.position.clone();
      group.position.addScaledVector(forward, speed * dt);
      group.rotation.y = heading;

      if (isBlocked(group.position.x, group.position.z)) {
        group.position.copy(previous);
        speed *= -0.3;
      }

      for (const wheel of wheels) wheel.rotation.x += speed * dt / WHEEL_RADIUS;
    },
  };
}
