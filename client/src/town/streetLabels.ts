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

interface LabelMaterial {
  material: THREE.MeshBasicMaterial;
  aspect: number;
}

interface LabelOrientation {
  mesh: THREE.Mesh;
  dirX: number;
  dirZ: number;
  angle: number;
}

export interface StreetLabels {
  /** Adds labels along one road, spaced out and skipping nearby repeats of the name. */
  add(name: string, points: Point2[], length: number, roadWidth: number): void;
  setHeight(y: number): void;
  /** Flips labels so they read upright for a car with this heading. */
  update(heading: number): void;
}

export function createStreetLabels(scene: THREE.Scene, renderer: THREE.WebGLRenderer): StreetLabels {
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const group = new THREE.Group();
  scene.add(group);

  const materials = new Map<string, LabelMaterial>(); // shared per street name
  const placedLabels = new Map<string, Point2[]>();
  const orientations: LabelOrientation[] = [];

  function labelMaterial(name: string): LabelMaterial {
    const cached = materials.get(name);
    if (cached) return cached;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    const font = `600 ${LABEL_FONT_SIZE}px system-ui, sans-serif`;
    context.font = font;
    canvas.width = Math.ceil(context.measureText(name).width) + LABEL_CANVAS_PADDING * 2;
    canvas.height = LABEL_CANVAS_HEIGHT;

    context.font = font; // resizing the canvas reset it
    context.direction = 'rtl';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.lineJoin = 'round';
    context.lineWidth = LABEL_OUTLINE;
    context.strokeStyle = '#3b3f46';
    context.strokeText(name, canvas.width / 2, canvas.height / 2);
    context.fillStyle = '#f5f1d0';
    context.fillText(name, canvas.width / 2, canvas.height / 2);

    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = renderer.capabilities.getMaxAnisotropy(); // stays sharp at low view angles
    const label = {
      material: new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false }),
      aspect: canvas.width / canvas.height,
    };
    materials.set(name, label);
    return label;
  }

  return {
    add(name, points, length, roadWidth) {
      const count = Math.max(1, Math.floor(length / LABEL_SPACING));
      const placed = placedLabels.get(name) ?? [];
      placedLabels.set(name, placed);
      const { material, aspect } = labelMaterial(name);

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

        const dirX = (bx - ax) / chord, dirZ = (bz - az) / chord;
        const mesh = new THREE.Mesh(plane, material);
        mesh.scale.set(textLength, 1, textHeight);
        mesh.position.set(x, 0, z);
        group.add(mesh);
        orientations.push({ mesh, dirX, dirZ, angle: Math.atan2(-dirZ, dirX) });
      }
    },

    setHeight(y) {
      group.position.y = y;
    },

    // Both cameras look along the car, so text reads upright when it runs toward the car's right.
    update(heading) {
      const rightX = -Math.cos(heading), rightZ = Math.sin(heading);
      for (const { mesh, dirX, dirZ, angle } of orientations) {
        mesh.rotation.y = dirX * rightX + dirZ * rightZ < 0 ? angle + Math.PI : angle;
      }
    },
  };
}
