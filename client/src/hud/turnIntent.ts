// The HUD side of choosing the next turn: a chip after the ROAD pill that names the queued turn, and one curved
// arrow on the road that shows the path the car will take through the next junction.
//
// The arrow is a single mesh, one draw call: a violet halo, a solid violet body, a flowing white core and a head, all
// layers of one geometry. It is lit by nothing and added to what is behind it, so it reads as a light projected on the
// road and can't be mistaken for paint. The geometry is rebuilt only when the arrow's path changes, about once per junction.

import * as THREE from 'three';
import type { Side, TurnArrow } from '../car/roadLock.ts';
import { ROAD_LINE_Y } from '../town/roads.ts';
import { buildArrowArrays } from './turnArrow.ts';

const ARROW_Y = ROAD_LINE_Y + 0.04; // above the road, the center lines and the debug overlay
const DASH_ON = 1.2, DASH_PERIOD = 2.8, FLOW_SPEED = 4; // m, m, m/s

export interface TurnIntent {
  /**
   * Shows the queued turn on the chip and the arrow on the road (null: none). `seconds` runs the core's flow.
   */
  update(intent: Side | null, arrow: TurnArrow | null, seconds: number): void;
}

export function createTurnIntent(scene: THREE.Scene): TurnIntent {
  const chip = document.getElementById('turn-chip')!;

  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `
      attribute vec4 color;
      attribute float along;
      attribute float core;
      varying vec4 vColor;
      varying float vAlong;
      varying float vCore;
      void main() {
        vColor = color;
        vAlong = along;
        vCore = core;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      varying vec4 vColor;
      varying float vAlong;
      varying float vCore;
      void main() {
        if (vCore > 0.5 && fract((vAlong - uTime * ${FLOW_SPEED.toFixed(1)}) / ${DASH_PERIOD.toFixed(1)}) > ${(DASH_ON / DASH_PERIOD).toFixed(4)}) discard;
        gl_FragColor = vColor; // additive blending adds rgb times alpha to what is behind
      }`,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.name = 'turnArrow';
  mesh.frustumCulled = false; // spans a junction; cheaper than recomputing bounds
  mesh.renderOrder = 10;
  mesh.visible = false;
  scene.add(mesh);
  let builtFor = -1; // the arrow version on screen

  function rebuild(arrow: TurnArrow): void {
    const arrays = buildArrowArrays(arrow.path, arrow.heading, ARROW_Y);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 4));
    geometry.setAttribute('along', new THREE.Float32BufferAttribute(arrays.along, 1));
    geometry.setAttribute('core', new THREE.Float32BufferAttribute(arrays.core, 1));
    geometry.setIndex(arrays.indices);
    mesh.geometry.dispose();
    mesh.geometry = geometry;
  }

  let chipSide: Side | null = null;
  return {
    update(intent, arrow, seconds) {
      if (intent !== chipSide) {
        chipSide = intent;
        chip.hidden = intent === null;
        if (intent) chip.textContent = intent === 'left' ? '◀ Next left' : 'Next right ▶';
      }
      mesh.visible = arrow !== null;
      if (!arrow) return;
      if (arrow.version !== builtFor) {
        builtFor = arrow.version;
        rebuild(arrow);
      }
      material.uniforms.uTime.value = seconds;
    },
  };
}
