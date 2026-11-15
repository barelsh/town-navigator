import type * as THREE from 'three';
import Stats from 'three/addons/libs/stats.module.js';

const SAMPLE_INTERVAL = 1000;            // ms
const GRAPH_TOP = 15, GRAPH_HEIGHT = 30; // px inside a Stats.Panel canvas
const PANEL_HEIGHT = 48;                 // px, a Stats.Panel canvas
const MB = 1024 * 1024;

interface Meter {
  label: string;       // drawn on the graph
  title: string;       // tip heading
  hint: string;
  fg: string;
  bg: string;
  limit: number;       // red line
  max: number;         // top of the graph
  lowIsBad?: boolean;  // FPS: the danger zone is under the line
  unit?: string;
}

export const METERS = {
  fps:        { label: 'FPS',   title: 'Frame rate',  fg: '#0ff',    bg: '#002',    limit: 30,   max: 120,  lowIsBad: true,
                hint: 'Frames drawn per second. Below the line, driving feels choppy.' },
  ms:         { label: 'MS',    title: 'Frame time',  fg: '#0f0',    bg: '#020',    limit: 16.7, max: 50,   unit: ' ms',
                hint: 'CPU time to update and draw the slowest frame of the last second, in ms. GPU time isn’t included.' },
  mb:         { label: 'MB',    title: 'JS memory',   fg: '#f08',    bg: '#201',    limit: 512,  max: 1024, unit: ' MB',
                hint: 'JavaScript memory in use (Chrome only). If it keeps climbing while you drive, something isn’t freed.' },
  calls:      { label: 'CALLS', title: 'Draw calls',  fg: '#ffd166', bg: '#221a05', limit: 1000, max: 2000,
                hint: 'Draw calls per frame, including shadows. Every visible mesh costs at least one, so fewer, bigger meshes are faster.' },
  kTri:       { label: 'kTRI',  title: 'Triangles',   fg: '#ff9c8a', bg: '#220c08', limit: 1000, max: 2000, unit: 'k',
                hint: 'Thousands of triangles drawn per frame, including shadows.' },
  geometries: { label: 'GEO',   title: 'Geometries',  fg: '#9fd3ff', bg: '#081622', limit: 1000, max: 2000,
                hint: 'Geometries loaded on the GPU. It should stay flat while you drive.' },
  textures:   { label: 'TEX',   title: 'Textures',    fg: '#c3a6ff', bg: '#140c22', limit: 256,  max: 512,
                hint: 'Textures loaded on the GPU: facades, street names, icons. It should stay flat while you drive.' },
} satisfies Record<string, Meter>;

type MeterId = keyof typeof METERS;

export interface PerfMonitor {
  /** Call at the start of the frame. */
  begin(): void;
  /** Call after the frame's render. */
  end(): void;
  readonly visible: boolean;
  setVisible(visible: boolean): void;
}

export function createPerfMonitor(renderer: THREE.WebGLRenderer): PerfMonitor {
  renderer.info.autoReset = false; // render() resets after the shadow pass; reset per frame in begin()
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;

  const root = document.createElement('div');
  root.id = 'perf';
  root.hidden = true;
  const tip = document.createElement('div');
  tip.id = 'perf-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(root, tip);

  const graphs = new Map<MeterId, (value: number) => void>();
  for (const id of Object.keys(METERS) as MeterId[]) {
    if (id === 'mb' && !memory) continue;
    const meter: Meter = METERS[id];
    const panel = new Stats.Panel(meter.label, meter.fg, meter.bg);
    const cell = document.createElement('div');
    cell.className = 'perf-cell';
    const line = document.createElement('div');
    line.className = 'perf-limit';
    line.style.top = `${((GRAPH_TOP + (1 - meter.limit / meter.max) * GRAPH_HEIGHT) / PANEL_HEIGHT) * 100}%`; // scales with the cell
    cell.append(panel.dom, line);
    cell.addEventListener('pointerenter', () => showTip(cell, meter));
    cell.addEventListener('pointerleave', () => { tip.hidden = true; });
    root.append(cell);
    graphs.set(id, value => {
      panel.update(value, Math.max(meter.max, value)); // a max below value paints over the label
      cell.classList.toggle('over', meter.lowIsBad ? value < meter.limit : value > meter.limit);
    });
  }

  function showTip(cell: HTMLElement, meter: Meter): void {
    const b = document.createElement('b');
    b.textContent = meter.title;
    const limit = document.createElement('span');
    limit.className = 'lim';
    limit.textContent = `Red line: ${meter.lowIsBad ? 'under' : 'over'} ${meter.limit.toLocaleString('en')}${meter.unit ?? ''}`;
    tip.replaceChildren(b, meter.hint, limit);
    tip.hidden = false;
    const box = cell.getBoundingClientRect(), panel = root.getBoundingClientRect();
    tip.style.left = `${box.left}px`;
    tip.style.bottom = `${innerHeight - panel.top + 6}px`; // just above the whole panel
  }

  let frameStart = 0, frames = 0, slowest = 0, lastSample = performance.now();

  return {
    begin() {
      renderer.info.reset();
      frameStart = performance.now();
    },
    end() {
      const now = performance.now();
      frames++;
      slowest = Math.max(slowest, now - frameStart);
      if (now - lastSample < SAMPLE_INTERVAL) return;
      const { render, memory: gpu } = renderer.info;
      graphs.get('fps')!((frames * 1000) / (now - lastSample));
      graphs.get('ms')!(slowest);
      graphs.get('mb')?.(memory!.usedJSHeapSize / MB);
      graphs.get('calls')!(render.calls);
      graphs.get('kTri')!(render.triangles / 1000);
      graphs.get('geometries')!(gpu.geometries);
      graphs.get('textures')!(gpu.textures);
      frames = 0;
      slowest = 0;
      lastSample = now;
    },
    get visible() { return !root.hidden; },
    setVisible(visible) {
      root.hidden = !visible;
      if (!visible) tip.hidden = true;
    },
  };
}
