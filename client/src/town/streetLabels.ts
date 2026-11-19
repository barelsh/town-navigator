import * as THREE from 'three';
import { pointAlong, type Point2 } from './geometry.ts';

// Street labels are painted on the road surface and run along it, like map labels.
const LABEL_SPACING = 120;         // meters along a road
const LABEL_MIN_SEPARATION = 100;  // meters between labels of the same street
const LABEL_ROAD_RATIO = 0.55;     // text height as a share of the road width
const LABEL_MAX_HEIGHT = 5;        // meters
const LABEL_FONT_SIZE = 64;        // pixels
const LABEL_CANVAS_HEIGHT = 96;    // pixels
const LABEL_CANVAS_PADDING = 16;   // pixels
const LABEL_OUTLINE = 10;          // pixels; hides center line dashes behind the text

const ATLAS_WIDTH = 2048;          // pixels
const ATLAS_GUTTER = 8;            // pixels; stops neighbors bleeding into each other in mipmaps
const LABEL_FONT = `600 ${LABEL_FONT_SIZE}px system-ui, sans-serif`;

/** Built once: the renderer and a context for measuring names. Atlases belong to the chunks. */
export interface LabelKit {
  renderer: THREE.WebGLRenderer;
  measure: CanvasRenderingContext2D;
}

export function createLabelKit(renderer: THREE.WebGLRenderer): LabelKit {
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = LABEL_FONT;
  return { renderer, measure };
}

export interface StreetLabels {
  /** Records labels along one road, spaced out and skipping nearby repeats of the name. */
  add(name: string, points: Point2[], length: number, roadWidth: number): void;
  setHeight(y: number): void;
  /** Draws the recorded names onto atlases and builds the label meshes. Call once, after every add. */
  finish(): void;
  /** Flips labels so they read upright for a car with this heading. */
  update(heading: number): void;
  /** Removes the labels and frees their geometries, atlas textures and materials. */
  dispose(): void;
}

interface Placement {
  name: string;
  x: number; z: number;
  dirX: number; dirZ: number;
  length: number; height: number;
  flipped: boolean;
  page: number;  // which atlas it uses, set by finish
  slot: number;  // its index among that atlas's labels
}

interface Cell { x: number; y: number; w: number; h: number; page: number }

interface Page {
  positions: Float32Array;
  mesh: THREE.Mesh;
  texture: THREE.CanvasTexture;
  material: THREE.MeshBasicMaterial;
  count: number;
}

// Corner order: [along, across, u, v] as fractions. Across +0.5 is the bottom of the text.
const CORNERS = [[-0.5, 0.5, 0, 0], [0.5, 0.5, 1, 0], [-0.5, -0.5, 0, 1], [0.5, -0.5, 1, 1]];

function writeCorners(positions: Float32Array, slot: number, l: Placement, flipped: boolean): void {
  const s = flipped ? -1 : 1; // a 180 degree turn mirrors both axes through the center
  for (let c = 0; c < 4; c++) {
    const [a, b] = CORNERS[c];
    const along = s * a * l.length, across = s * b * l.height;
    const k = (slot * 4 + c) * 3;
    positions[k] = l.x + l.dirX * along - l.dirZ * across;
    positions[k + 1] = 0; // the group's y is set by setHeight
    positions[k + 2] = l.z + l.dirZ * along + l.dirX * across;
  }
}

/** Rows of cells, widest name first. Starts a new page when one would be taller than the GPU allows. */
function pack(widths: Map<string, number>, maxHeight: number): { cells: Map<string, Cell>; pageHeights: number[] } {
  const cells = new Map<string, Cell>();
  const pageHeights: number[] = [];
  let x = 0, y = 0, page = 0;
  for (const [name, w] of [...widths].sort((a, b) => b[1] - a[1])) {
    if (x > 0 && x + w > ATLAS_WIDTH) { x = 0; y += LABEL_CANVAS_HEIGHT + ATLAS_GUTTER; }
    if (y + LABEL_CANVAS_HEIGHT > maxHeight) { pageHeights.push(y - ATLAS_GUTTER); page++; x = 0; y = 0; }
    cells.set(name, { x, y, w, h: LABEL_CANVAS_HEIGHT, page });
    x += w + ATLAS_GUTTER;
  }
  pageHeights.push(y + LABEL_CANVAS_HEIGHT);
  return { cells, pageHeights };
}

function drawName(context: CanvasRenderingContext2D, name: string, cell: Cell): void {
  const cx = cell.x + cell.w / 2, cy = cell.y + cell.h / 2;
  context.font = LABEL_FONT;
  context.direction = 'rtl';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.lineWidth = LABEL_OUTLINE;
  context.strokeStyle = '#3b3f46';
  context.strokeText(name, cx, cy);
  context.fillStyle = '#f5f1d0';
  context.fillText(name, cx, cy);
}

/** The labels of one chunk. Labels of the same street are kept apart within the chunk. */
export function createStreetLabels(parent: THREE.Object3D, kit: LabelKit): StreetLabels {
  const group = new THREE.Group();
  parent.add(group);

  const placedLabels = new Map<string, Point2[]>();
  const placements: Placement[] = [];
  const widths = new Map<string, number>(); // atlas cell width per name
  let pages: Page[] = [];

  const widthOf = (name: string): number => {
    let width = widths.get(name);
    if (width === undefined) {
      width = Math.ceil(kit.measure.measureText(name).width) + LABEL_CANVAS_PADDING * 2;
      widths.set(name, width);
    }
    return width;
  };

  return {
    add(name, points, length, roadWidth) {
      const count = Math.max(1, Math.floor(length / LABEL_SPACING));
      const placed = placedLabels.get(name) ?? [];
      placedLabels.set(name, placed);
      const aspect = widthOf(name) / LABEL_CANVAS_HEIGHT;

      // Short roads shrink the text so it stays on the road.
      const fullHeight = Math.min(roadWidth * LABEL_ROAD_RATIO, LABEL_MAX_HEIGHT);
      const fit = Math.min(1, length / (fullHeight * aspect));
      const textHeight = fullHeight * fit;
      const textLength = textHeight * aspect;

      for (let i = 0; i < count; i++) {
        const center = THREE.MathUtils.clamp((i + 0.5) * length / count, textLength / 2, length - textLength / 2);
        const [x, z] = pointAlong(points, center);
        // Streets are split into many segments, and divided roads repeat the name.
        if (placed.some(([px, pz]) => Math.hypot(px - x, pz - z) < LABEL_MIN_SEPARATION)) continue;

        // Align with the stretch of road under the text, which also evens out curves.
        const [ax, az] = pointAlong(points, center - textLength / 2);
        const [bx, bz] = pointAlong(points, center + textLength / 2);
        const chord = Math.hypot(bx - ax, bz - az);
        if (chord === 0) continue;
        placed.push([x, z]);

        placements.push({
          name, x, z, dirX: (bx - ax) / chord, dirZ: (bz - az) / chord,
          length: textLength, height: textHeight, flipped: false, page: 0, slot: 0,
        });
      }
    },

    finish() {
      if (pages.length || !placements.length) return;
      const maxHeight = kit.renderer.capabilities.maxTextureSize;
      const { cells, pageHeights } = pack(widths, maxHeight);

      const canvases = pageHeights.map(height => {
        const canvas = document.createElement('canvas');
        canvas.width = ATLAS_WIDTH;
        canvas.height = height;
        return canvas;
      });
      for (const [name, cell] of cells) drawName(canvases[cell.page].getContext('2d')!, name, cell);

      const counts = pageHeights.map(() => 0);
      for (const l of placements) {
        l.page = cells.get(l.name)!.page;
        l.slot = counts[l.page]++;
      }

      pages = canvases.map((canvas, page) => {
        const count = counts[page];
        const positions = new Float32Array(count * 12);
        const uvs = new Float32Array(count * 8);
        const indices = new Uint32Array(count * 6);
        for (const l of placements) {
          if (l.page !== page) continue;
          const cell = cells.get(l.name)!;
          writeCorners(positions, l.slot, l, false);
          const u0 = cell.x / canvas.width, u1 = (cell.x + cell.w) / canvas.width;
          const vTop = 1 - cell.y / canvas.height, vBottom = 1 - (cell.y + cell.h) / canvas.height;
          for (let c = 0; c < 4; c++) {
            uvs[(l.slot * 4 + c) * 2] = CORNERS[c][2] ? u1 : u0;
            uvs[(l.slot * 4 + c) * 2 + 1] = CORNERS[c][3] ? vTop : vBottom;
          }
          const v = l.slot * 4;
          indices.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], l.slot * 6); // faces up
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeBoundingSphere(); // a flip mirrors corners through their center, so it stays valid

        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = kit.renderer.capabilities.getMaxAnisotropy(); // stays sharp at low view angles
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
        const mesh = new THREE.Mesh(geometry, material);
        group.add(mesh);
        return { positions, mesh, texture, material, count };
      });
    },

    setHeight(y) {
      group.position.y = y;
    },

    dispose() {
      group.removeFromParent();
      for (const { mesh, texture, material } of pages) {
        mesh.geometry.dispose();
        texture.dispose();
        material.dispose();
      }
      group.clear();
      pages = [];
      placements.length = 0;
    },

    // Both cameras look along the car, so text reads upright when it runs toward the car's right.
    update(heading) {
      const rightX = -Math.cos(heading), rightZ = Math.sin(heading);
      const changed = new Set<Page>();
      for (const l of placements) {
        const flipped = l.dirX * rightX + l.dirZ * rightZ < 0;
        if (flipped === l.flipped) continue;
        l.flipped = flipped;
        const page = pages[l.page];
        if (!page) continue; // not finished yet
        writeCorners(page.positions, l.slot, l, flipped);
        changed.add(page);
      }
      for (const page of changed) page.mesh.geometry.attributes.position.needsUpdate = true;
    },
  };
}
