// The HUD side of choosing the next turn: a chip after the ROAD pill that names the queued turn, and one curved
// arrow on the road that shows the path the car will take through the next junction.
//
// The arrow is a single mesh, one draw call: a violet halo, a solid violet body, a flowing white core and a head, all
// layers of one geometry, in the glow look of glowRibbon.ts. The geometry is rebuilt only when the arrow's path changes,
// about once per junction. While navigating (TN-40), a queued turn on the route gets a cyan border and a ✓ on the chip.

import type * as THREE from 'three';
import type { Side, TurnArrow } from '../car/roadLock.ts';
import { ROAD_LINE_Y } from '../town/roads.ts';
import { createGlowMesh, toGeometry, type GlowMaterial } from './glowRibbon.ts';
import { buildArrowArrays } from './turnArrow.ts';

export const ARROW_Y = ROAD_LINE_Y + 0.04; // above the road, the center lines and the debug overlay

export interface TurnIntentOptions {
  /** The queued turn is the route's turn at that junction (TN-40). */
  onRoute?: boolean;
}

export interface TurnIntent {
  /**
   * Shows the queued turn on the chip and the arrow on the road (null: none). `seconds` runs the core's flow.
   */
  update(intent: Side | null, arrow: TurnArrow | null, seconds: number, options?: TurnIntentOptions): void;
}

export function createTurnIntent(scene: THREE.Scene, material: GlowMaterial): TurnIntent {
  const chip = document.getElementById('turn-chip')!;

  const mesh = createGlowMesh(material, 'turnArrow', 11); // over the navigation overlay's cyan
  scene.add(mesh);
  let builtFor = -1; // the arrow version on screen

  let chipSide: Side | null = null;
  let chipOnRoute = false;
  return {
    update(intent, arrow, seconds, { onRoute = false } = {}) {
      const routed = intent !== null && onRoute;
      if (intent !== chipSide || routed !== chipOnRoute) {
        chipSide = intent;
        chipOnRoute = routed;
        chip.hidden = intent === null;
        if (intent) chip.textContent = `${intent === 'left' ? '◀ Next left' : 'Next right ▶'}${routed ? ' ✓' : ''}`;
        chip.classList.toggle('on-route', routed);
      }
      material.uniforms.uTime.value = seconds;
      mesh.visible = arrow !== null;
      if (!arrow) return;
      if (arrow.version !== builtFor) {
        builtFor = arrow.version;
        mesh.geometry.dispose();
        mesh.geometry = toGeometry(buildArrowArrays(arrow.path, arrow.heading, ARROW_Y));
      }
    },
  };
}
