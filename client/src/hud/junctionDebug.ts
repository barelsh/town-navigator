// Debug overlay for the road graph, shown with the performance panel: a ring per junction zone,
// a disc per member junction and a tick per exit, drawn flat on the road just above the center lines.
// Two draw calls: one mesh for rings and discs, one LineSegments for the exit ticks.

import * as THREE from 'three';
import type { RoadGraph } from '../town/roadGraph.ts';
import { ROAD_LINE_Y } from '../town/roads.ts';

const OVERLAY_Y = ROAD_LINE_Y + 0.02;
const RING_WIDTH = 0.4;   // m
const RING_SEGMENTS = 48;
const DISC_RADIUS = 0.6;  // m: a 1.2 m disc per member junction
const DISC_SEGMENTS = 12;
const TICK_LENGTH = 6;    // m, from the zone's edge outward

const JUNCTION_COLOR = new THREE.Color(0xe8a33d);
const DEAD_END_COLOR = new THREE.Color(0xd9534f);
const EXIT_COLOR = new THREE.Color(0x4cd07d);    // you can leave on it (flow both / out)
const ARRIVE_COLOR = new THREE.Color(0x9aa3ad);  // one-way toward the junction

export interface JunctionDebug {
  readonly visible: boolean;
  setVisible(visible: boolean): void;
  /** Replaces the overlay with the graph's zones. Frees the old geometry. */
  show(graph: RoadGraph): void;
  /** The graph on screen, or null. */
  readonly shown: RoadGraph | null;
}

export function createJunctionDebug(scene: THREE.Scene): JunctionDebug {
  const group = new THREE.Group();
  group.name = 'junctionDebug';
  group.visible = false;
  scene.add(group);

  // Unlit; fog fades it like the roads.
  const surfaceMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true });
  const surface = new THREE.Mesh(new THREE.BufferGeometry(), surfaceMaterial);
  const ticks = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial);
  for (const object of [surface, ticks]) {
    object.position.y = OVERLAY_Y;
    object.frustumCulled = false; // spans the 3 x 3; cheaper than recomputing bounds
    group.add(object);
  }
  let shown: RoadGraph | null = null;

  function show(graph: RoadGraph): void {
    shown = graph;
    const positions: number[] = [];
    const colors: number[] = [];
    const tickPositions: number[] = [];
    const tickColors: number[] = [];
    const triangle = (color: THREE.Color, ...points: [number, number][]) => {
      for (const [x, z] of points) {
        positions.push(x, 0, z);
        colors.push(color.r, color.g, color.b);
      }
    };

    for (const zone of graph.zones) {
      const color = zone.kind === 'dead_end' ? DEAD_END_COLOR : JUNCTION_COLOR;
      const inner = zone.radius - RING_WIDTH / 2, outer = zone.radius + RING_WIDTH / 2;
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2, b = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
        const at = (r: number, t: number): [number, number] => [zone.x + Math.sin(t) * r, zone.z + Math.cos(t) * r];
        triangle(color, at(inner, a), at(outer, a), at(outer, b));
        triangle(color, at(inner, a), at(outer, b), at(inner, b));
      }
      for (const m of zone.members) {
        for (let i = 0; i < DISC_SEGMENTS; i++) {
          const a = (i / DISC_SEGMENTS) * Math.PI * 2, b = ((i + 1) / DISC_SEGMENTS) * Math.PI * 2;
          triangle(color, [m.x, m.z],
            [m.x + Math.sin(a) * DISC_RADIUS, m.z + Math.cos(a) * DISC_RADIUS],
            [m.x + Math.sin(b) * DISC_RADIUS, m.z + Math.cos(b) * DISC_RADIUS]);
        }
      }
      if (zone.kind === 'dead_end') continue;
      for (const exit of zone.exits) {
        // Where the branch's ray from its member leaves the zone circle, then outward along it.
        const dx = Math.sin(exit.heading), dz = Math.cos(exit.heading);
        const fx = exit.from.x - zone.x, fz = exit.from.z - zone.z;
        const b = fx * dx + fz * dz, c = fx * fx + fz * fz - zone.radius * zone.radius;
        const t = -b + Math.sqrt(Math.max(0, b * b - c));
        const x0 = exit.from.x + dx * t, z0 = exit.from.z + dz * t;
        tickPositions.push(x0, 0, z0, x0 + dx * TICK_LENGTH, 0, z0 + dz * TICK_LENGTH);
        const tick = exit.flow === 'in' ? ARRIVE_COLOR : EXIT_COLOR;
        tickColors.push(tick.r, tick.g, tick.b, tick.r, tick.g, tick.b);
      }
    }

    surface.geometry.dispose();
    ticks.geometry.dispose();
    surface.geometry = geometryOf(positions, colors);
    ticks.geometry = geometryOf(tickPositions, tickColors);
  }

  return {
    get visible() { return group.visible; },
    setVisible(visible) { group.visible = visible; },
    show,
    get shown() { return shown; },
  };
}

function geometryOf(positions: number[], colors: number[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}
