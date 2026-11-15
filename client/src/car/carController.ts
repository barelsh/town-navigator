import * as THREE from 'three';
import type { StartPosition } from '../town/roads.ts';
import { DEFAULT_SPEED_LIMIT_KMH } from '../settings/settingsStore.ts';
import type { CarModel } from './carModel.ts';

export const ACCEL = 14, BRAKE = 24, FRICTION = 6; // m/s²
export const REVERSE_SHARE = 0.4; // reverse limit as a share of the speed limit
export const KMH_PER_MPS = 3.6;

export interface CarController {
  readonly position: THREE.Vector3;
  readonly heading: number;
  readonly speed: number;
  update(dt: number): void;
  /** Sets the top speed in km/h. A lower limit than the current speed brakes the car down to it. */
  setSpeedLimit(kmh: number): void;
  /** Turns driving keys on or off; turning them off releases any held key. */
  setInputEnabled(enabled: boolean): void;
  /** Puts the car at a start, stopped. */
  resetTo(start: StartPosition): void;
}

export function createCarController(
  model: CarModel,
  start: StartPosition,
  /** How far into a building or past the town's edge the vehicle would be at this pose, in meters; 0 when clear. */
  overlap: (x: number, z: number, heading: number) => number
): CarController {
  const { group } = model;
  const keys: Record<string, boolean> = {};
  let inputEnabled = true;
  addEventListener('keydown', e => { if (inputEnabled) keys[e.code] = true; });
  addEventListener('keyup', e => { keys[e.code] = false; });

  group.position.set(start.x, 0, start.z);
  group.rotation.y = start.heading;

  let speed = 0, heading = start.heading;
  let maxSpeed = DEFAULT_SPEED_LIMIT_KMH / KMH_PER_MPS; // m/s
  const forward = new THREE.Vector3();

  return {
    position: group.position,
    get heading() { return heading; },
    get speed() { return speed; },

    setInputEnabled(enabled) {
      inputEnabled = enabled;
      if (!enabled) for (const code in keys) keys[code] = false;
    },

    setSpeedLimit(kmh) {
      maxSpeed = kmh / KMH_PER_MPS;
    },

    resetTo(next) {
      group.position.set(next.x, 0, next.z);
      heading = next.heading;
      group.rotation.y = heading;
      speed = 0;
    },

    update(dt) {
      const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;
      const left = keys.KeyA || keys.ArrowLeft, right = keys.KeyD || keys.ArrowRight;

      const reverseMax = maxSpeed * REVERSE_SHARE;
      if (speed > maxSpeed) {
        // A limit lowered while driving: brake down to it instead of snapping.
        speed = Math.max(maxSpeed, speed - BRAKE * dt);
      } else if (speed < -reverseMax) {
        speed = Math.min(-reverseMax, speed + BRAKE * dt);
      } else {
        if (up) speed += ACCEL * dt;
        else if (down) speed -= (speed > 0 ? BRAKE : ACCEL * 0.6) * dt;
        else speed -= Math.sign(speed) * Math.min(Math.abs(speed), FRICTION * dt);
        speed = THREE.MathUtils.clamp(speed, -reverseMax, maxSpeed);
      }

      const steer = (left ? 1 : 0) - (right ? 1 : 0);
      const previousHeading = heading;
      heading += steer * dt * 2.2 * THREE.MathUtils.clamp(speed / 8, -1, 1);

      forward.set(Math.sin(heading), 0, Math.cos(heading));
      const previous = group.position.clone();
      group.position.addScaledVector(forward, speed * dt);
      group.rotation.y = heading;

      // Compare whole poses, so turning into a wall counts as much as driving into it. A pose may overlap
      // only if it is no deeper than the one before, which lets a car that overlaps (after a vehicle swap)
      // drive out, and never lets it drive further in.
      const now = overlap(group.position.x, group.position.z, heading);
      if (now > 0 && now > overlap(previous.x, previous.z, previousHeading) + 1e-4) {
        group.position.copy(previous);
        heading = previousHeading;
        group.rotation.y = heading;
        speed *= -0.3;
      }

      for (const wheel of model.wheels) wheel.rotation.x += speed * dt / model.spec.wheelRadius;
    },
  };
}
