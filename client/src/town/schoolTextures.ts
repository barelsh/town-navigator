import * as THREE from 'three';
import { canvasTexture } from './facadeTextures.ts';

export const STONE_TILE = 4.5; // meters: 6 courses of 0.75 m
const COURSE = 0.75;           // meters

/** Large pale blocks with light joints. It repeats in world meters, like the apartment stone. */
export function blockStoneTexture(): THREE.CanvasTexture {
  const map = canvasTexture(1024, 1024, (c, s) => {
    let seed = 23;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const courseH = s * COURSE / STONE_TILE;
    const rows = Math.round(STONE_TILE / COURSE);
    for (let row = 0; row < rows; row++) {
      const blockW = courseH * 2.4;
      const shift = row % 2 ? blockW / 2 : 0;
      for (let x = -blockW + shift; x < s; x += blockW) {
        const tone = 236 + Math.floor(rand() * 12);
        c.fillStyle = `rgb(${tone},${tone - 4},${tone - 12})`;
        c.fillRect(x, row * courseH, blockW, courseH);
      }
      c.fillStyle = 'rgba(120, 114, 104, 0.45)';
      for (let x = -blockW + shift; x < s; x += blockW) c.fillRect(x, row * courseH, 2.5, courseH);
      c.fillRect(0, row * courseH, s, 2.5);
    }
  });
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1 / STONE_TILE, 1 / STONE_TILE);
  return map;
}

function drawPane(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, curtain: boolean): void {
  c.fillStyle = '#6d7f8b';
  c.fillRect(x, y, w, h);
  if (curtain) {
    c.fillStyle = '#d9d2bd';
    c.fillRect(x, y, w, h * 0.82);
    c.fillStyle = 'rgba(120, 112, 90, 0.35)';
    for (let i = 1; i < 6; i++) c.fillRect(x + (w * i) / 6, y, 1.5, h * 0.82);
  }
}

/** One band per module: two runs of panes around a dark spacer, on a black frame. */
export function ribbonTexture(): THREE.CanvasTexture {
  return canvasTexture(760, 136, (c, w, h) => {
    c.fillStyle = '#23262a';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#3b4044';
    c.fillRect(w * 0.46, 0, w * 0.08, h);
    const paneW = w * 0.46 / 5, frame = 5;
    [0, w * 0.54].forEach((start, side) => {
      for (let i = 0; i < 5; i++) {
        drawPane(c, start + i * paneW + frame, frame, paneW - frame * 2 + 3, h - frame * 2, (i + side) % 3 !== 0);
      }
    });
  });
}

/** Three separate windows on a dark band. */
export function trioTexture(): THREE.CanvasTexture {
  return canvasTexture(620, 136, (c, w, h) => {
    c.fillStyle = '#34393d';
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 3; i++) {
      const x = w * (0.06 + i * 0.32);
      c.fillStyle = '#1f2225';
      c.fillRect(x - 5, 5, w * 0.24 + 10, h - 10);
      drawPane(c, x, 10, w * 0.24, h - 20, i !== 1);
    }
  });
}
