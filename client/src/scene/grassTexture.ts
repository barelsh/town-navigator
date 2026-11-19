import * as THREE from 'three';
import { canvasTexture } from '../town/facadeTextures.ts';

export const GRASS_TILE = 4;        // meters covered by one repeat of the detail texture
const GRASS_COLOR = [0x6f, 0xae, 0x4f];
const GRASS_CONTRAST = 0.12;        // ± luminance of blades and speckles around GRASS_COLOR
const PATCH_CONTRAST = 0.08;        // ± brightness of the large lawn patches
const PATCH_TILE = 70;              // meters: rough size of one light/dark lawn patch

/**
 * Short blade strokes and speckles around the base grass color. Its average is the base color,
 * so from afar (mipmapped) the ground keeps its flat green look; up close it streams past the car.
 */
export function grassDetailTexture(anisotropy: number): THREE.CanvasTexture {
  const map = canvasTexture(512, 512, (c, s) => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    c.fillStyle = `rgb(${GRASS_COLOR})`;
    c.fillRect(0, 0, s, s);
    for (let i = 0; i < 9000; i++) {
      const x = rand() * s, y = rand() * s;
      const shade = 1 + (rand() * 2 - 1) * GRASS_CONTRAST * 2.2;
      const length = 2 + rand() * 6, lean = (rand() - 0.5) * 0.8;
      c.strokeStyle = `rgba(${GRASS_COLOR.map(v => Math.min(255, Math.round(v * shade)))}, 0.7)`;
      c.lineWidth = 1 + rand();
      // Draw at the wrapped copies too, so blades crossing an edge continue on the other side.
      for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
        if (Math.abs(x + dx - s / 2) > s / 2 + 8 || Math.abs(y + dy - s / 2) > s / 2 + 8) continue;
        c.beginPath();
        c.moveTo(x + dx, y + dy);
        c.lineTo(x + dx + Math.sin(lean) * length * 0.4, y + dy - Math.cos(lean) * length);
        c.stroke();
      }
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = anisotropy;
  return map;
}

/**
 * Soft light and dark lawn patches that tint the detail texture. They're computed per pixel from
 * the world position in the material's shader, so the ground can stay a 2-triangle plane.
 */
export function addLawnPatches(material: THREE.Material): void {
  material.onBeforeCompile = shader => {
    shader.uniforms.patchFrequency = { value: (2 * Math.PI) / PATCH_TILE };
    shader.uniforms.patchContrast = { value: PATCH_CONTRAST };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying highp vec2 vGroundXZ;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGroundXZ = (modelMatrix * vec4(transformed, 1.0)).xz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying highp vec2 vGroundXZ;
        uniform float patchFrequency;
        uniform float patchContrast;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        highp vec2 p = vGroundXZ * patchFrequency;
        float lawn = sin(p.x + sin(p.y * 0.7) * 1.3) * 0.5
          + sin(p.y * 1.3 + p.x * 0.4) * 0.35
          + sin((p.x + p.y) * 2.1) * 0.15;
        float shade = 1.0 + lawn * patchContrast;
        diffuseColor.rgb *= vec3(shade * 1.02, shade, shade * 0.97); // brighter patches lean slightly yellow`);
  };
}
