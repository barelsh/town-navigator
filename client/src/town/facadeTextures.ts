import * as THREE from 'three';

export const STONE_TILE = 4.8; // meters: 8 courses of 0.6 m
const COURSE = 0.6;            // meters

const GREY = '#9aa1a6', GLASS = '#5a6b7d', SHUTTER = '#c6c9c7', SHUTTER_LINE = '#a1a4a3';

type Draw = (context: CanvasRenderingContext2D, width: number, height: number) => void;

function canvasTexture(width: number, height: number, draw: Draw): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d')!, width, height);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  return map;
}

/**
 * Coursed limestone with horizontal joints and staggered vertical joints. It repeats in
 * world meters, because ExtrudeGeometry's side UVs are already in meters.
 */
export function stoneTexture(): THREE.CanvasTexture {
  const map = canvasTexture(1024, 1024, (c, s) => {
    let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const courseH = s * COURSE / STONE_TILE;
    for (let row = 0; row < STONE_TILE / COURSE; row++) {
      const blockW = courseH * 2.6;
      const shift = row % 2 ? blockW / 2 : 0;
      for (let x = -blockW + shift; x < s; x += blockW) {
        const tone = 238 + Math.floor(rand() * 12);
        c.fillStyle = `rgb(${tone},${tone - 5},${tone - 15})`;
        c.fillRect(x, row * courseH, blockW, courseH);
      }
      c.fillStyle = 'rgba(90, 82, 70, 0.22)';
      for (let x = -blockW + shift; x < s; x += blockW) c.fillRect(x, row * courseH, 1.5, courseH);
      c.fillStyle = 'rgba(70, 64, 56, 0.8)';
      c.fillRect(0, row * courseH, s, 3);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1 / STONE_TILE, 1 / STONE_TILE);
  return map;
}

function drawSlats(
  c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  base: string, line: string, slats: number
): void {
  c.fillStyle = base;
  c.fillRect(x, y, w, h);
  c.fillStyle = line;
  const step = h / slats;
  for (let i = 0; i < slats; i++) c.fillRect(x, y + i * step, w, step * 0.32);
}

// Each window module is one box, with its glass, shutter and frame painted on.
function windowPane(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, shutterShare: number): void {
  const shutterH = h * shutterShare;
  drawSlats(c, x, y, w, shutterH, SHUTTER, SHUTTER_LINE, 9);
  c.fillStyle = GLASS;
  c.fillRect(x, y + shutterH, w, h - shutterH);
}

/** Full-height grey window bay. */
export function bayTexture(): THREE.CanvasTexture {
  return canvasTexture(256, 320, (c, w, h) => {
    c.fillStyle = GREY;
    c.fillRect(0, 0, w, h);
    windowPane(c, w * 0.19, h * 0.18, w * 0.62, h * 0.64, 0.58);
  });
}

/** Small window with a grey frame. */
export function punchedTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 172, (c, w, h) => {
    c.fillStyle = GREY;
    c.fillRect(0, 0, w, h);
    windowPane(c, w * 0.07, h * 0.05, w * 0.86, h * 0.9, 0.6);
  });
}

/** Wood panel between two white-framed windows. */
export function woodTexture(): THREE.CanvasTexture {
  return canvasTexture(330, 150, (c, w, h) => {
    c.fillStyle = '#b5895f';
    c.fillRect(w * 0.26, 0, w * 0.48, h);
    c.fillStyle = '#a07650';
    for (let x = w * 0.26; x < w * 0.74; x += w * 0.06) c.fillRect(x, 0, 2, h);
    for (const left of [0, w * 0.74]) {
      c.fillStyle = '#eef0f0';
      c.fillRect(left, 0, w * 0.26, h);
      c.fillStyle = GLASS;
      c.fillRect(left + w * 0.03, h * 0.07, w * 0.2, h * 0.86);
    }
  });
}

/** Dark slatted service shaft. */
export function louvreTexture(): THREE.CanvasTexture {
  return canvasTexture(128, 128, (c, w, h) => drawSlats(c, 0, 0, w, h, '#7f868c', '#40464b', 10));
}
