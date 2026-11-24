// The glowing ribbon look shared by TN-37's turn arrow and the navigation overlay (TN-40): lit by nothing, added to
// what is behind it so it reads as light projected on the road, with a dashed white core that flows along the path.
// One material serves every glow mesh; its `uTime` is set once per frame.

import * as THREE from 'three';
import type { ArrowArrays } from './turnArrow.ts';

const DASH_ON = 1.2, DASH_PERIOD = 2.8, FLOW_SPEED = 4; // m, m, m/s

export type GlowMaterial = THREE.ShaderMaterial & { uniforms: { uTime: { value: number } } };

export function createGlowMaterial(): GlowMaterial {
  return new THREE.ShaderMaterial({
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
  }) as GlowMaterial;
}

/** The arrays as a geometry for a glow mesh. */
export function toGeometry(arrays: ArrowArrays): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(arrays.positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(arrays.colors, 4));
  geometry.setAttribute('along', new THREE.Float32BufferAttribute(arrays.along, 1));
  geometry.setAttribute('core', new THREE.Float32BufferAttribute(arrays.core, 1));
  geometry.setIndex(arrays.indices);
  return geometry;
}

/** A glow mesh on the road: spans more than one junction, so it isn't frustum culled. Starts hidden and empty. */
export function createGlowMesh(material: GlowMaterial, name: string, renderOrder: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.name = name;
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.visible = false;
  return mesh;
}
