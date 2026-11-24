import * as THREE from 'three';
import type { StartPosition } from '../town/roads.ts';
import { DEFAULT_SPEED_LIMIT_KMH } from '../settings/settingsStore.ts';
import type { CarModel } from './carModel.ts';
import { applyHold, CAP_BRAKE, type DriveGuide, type Side } from './roadLock.ts';

export const ACCEL = 14, BRAKE = 24, FRICTION = 6; // m/s²
export const REVERSE_SHARE = 0.4; // reverse limit as a share of the speed limit
export const KMH_PER_MPS = 3.6;
export const TAP_MS = 250; // with Stick to roads: a steering key let go sooner is a tap, a longer hold is steering

const SIDE_OF: Record<string, Side> = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right' };
const CODES_OF: Record<Side, string[]> = { left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] };

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
  /** Moves the car to a pose, keeping its speed. */
  setPose(x: number, z: number, heading: number): void;
}

export function createCarController(
  model: CarModel,
  start: StartPosition,
  /** How far into a building or past the town's edge the vehicle would be at this pose, in meters; 0 when clear. */
  overlap: (x: number, z: number, heading: number) => number,
  /** While active and locked, it places the car on the road each frame: steering and collision are skipped. */
  guide?: DriveGuide,
): CarController {
  const { group } = model;
  const keys: Record<string, boolean> = {};
  let inputEnabled = true;
  // When each steering key went down (null: up), and whether that was inside a junction zone, where a quick tap
  // moves the target exit instead of steering. Outside a zone a press queues the turn for the next junction.
  const pressed: Record<Side, { at: number | null; inZone: boolean }> = { left: { at: null, inZone: false }, right: { at: null, inZone: false } };
  const isDown = (side: Side) => CODES_OF[side].some(code => keys[code]);
  addEventListener('keydown', e => {
    if (!inputEnabled) return;
    keys[e.code] = true;
    const side = SIDE_OF[e.code];
    if (!side || e.repeat || pressed[side].at !== null) return;
    pressed[side] = { at: performance.now(), inZone: guide?.active === true && guide.mode === 'free' };
    if (guide?.active && guide.mode === 'locked') guide.press(side);
  });
  addEventListener('keyup', e => {
    keys[e.code] = false;
    const side = SIDE_OF[e.code];
    if (!side || pressed[side].at === null || isDown(side)) return;
    const { at, inZone } = pressed[side];
    pressed[side] = { at: null, inZone: false };
    if (inZone && performance.now() - at! < TAP_MS && guide?.active && guide.mode === 'free') guide.tap(side);
  });
  /** Steering by hand: with Stick to roads a key counts only once it has been held past a tap. */
  const steering = (side: Side): boolean => {
    if (!isDown(side)) return false;
    if (!guide?.active) return true;
    const at = pressed[side].at;
    return at === null || performance.now() - at >= TAP_MS;
  };

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
      if (!enabled) {
        for (const code in keys) keys[code] = false;
        pressed.left = { at: null, inZone: false };
        pressed.right = { at: null, inZone: false };
      }
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

    setPose(x, z, nextHeading) {
      group.position.set(x, 0, z);
      heading = nextHeading;
      group.rotation.y = heading;
    },

    update(dt) {
      const up = keys.KeyW || keys.ArrowUp, down = keys.KeyS || keys.ArrowDown;

      const reverseMax = maxSpeed * REVERSE_SHARE;
      const before = speed;
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

      // A turn, or a short gap between junctions, caps the speed: brake to it, and W can't push past it.
      const cap = guide?.active ? guide.speedCap : undefined;
      if (cap !== undefined && speed > cap) speed = Math.max(cap, Math.min(speed, before - CAP_BRAKE * dt));

      if (guide?.active && guide.mode === 'locked') {
        // Stick to roads: W and S set the speed; the road decides where the car goes, so A and D do nothing
        // and a building footprint under the road can't trap the car.
        const next = guide.step({ x: group.position.x, z: group.position.z, heading }, speed, dt);
        group.position.set(next.x, 0, next.z);
        heading = next.heading;
        group.rotation.y = heading;
        speed = next.speed;
      } else {
        let steer = (steering('left') ? 1 : 0) - (steering('right') ? 1 : 0);
        if (guide?.active) {
          // Inside a zone the car steers itself onto the target exit until the player steers by hand.
          guide.steerHeld(steer !== 0);
          if (steer === 0) steer = guide.autoSteer({ x: group.position.x, z: group.position.z, heading }, speed) ?? 0;
        }
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

        if (guide?.active) {
          // Stick to roads, free inside a junction zone: a zone with no legal exit holds the car at its edge,
          // and a car that is out of the zone locks onto the exit.
          if (guide.hold) {
            const held = applyHold(guide.hold, previous, group.position);
            if (held.held) {
              group.position.x = held.x;
              group.position.z = held.z;
              speed = 0;
            }
          }
          guide.observe({ x: group.position.x, z: group.position.z, heading }, speed, dt);
        }
      }

      for (const wheel of model.wheels) wheel.rotation.x += speed * dt / model.spec.wheelRadius;
    },
  };
}
