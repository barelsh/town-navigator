import * as THREE from 'three';
import type { BuildingInfo } from '../town/buildingInfo.ts';

const GAP = 14;         // pixels between the panel and its point
const MARGIN = 12;      // pixels kept clear at the screen edges
const CARET_INSET = 14; // pixels the caret stays from the panel's corners

const { clamp } = THREE.MathUtils;

export interface BuildingTooltip {
  open(info: BuildingInfo, point: THREE.Vector3): void;
  close(): void;
  /** Call after rendering, when the camera matrices are current. */
  update(camera: THREE.Camera): void;
}

// Tags are community-edited text, so every value goes through textContent.
function addFact(parent: HTMLElement, label: string, value: string, note?: string): void {
  const box = document.createElement('div');
  const term = document.createElement('dt');
  term.textContent = label;
  const detail = document.createElement('dd');
  detail.textContent = value;
  if (note) {
    const small = document.createElement('small');
    small.textContent = note;
    detail.appendChild(small);
  }
  box.append(term, detail);
  parent.appendChild(box);
}

function addTag(parent: HTMLElement, key: string, value: string): void {
  const term = document.createElement('dt');
  term.textContent = key;
  const detail = document.createElement('dd');
  detail.textContent = value;
  detail.dir = 'auto';
  parent.append(term, detail);
}

export function createBuildingTooltip(): BuildingTooltip {
  const element = document.getElementById('building-tooltip')!;
  const icon = document.getElementById('tip-icon')!;
  const title = document.getElementById('tip-title')!;
  const swatch = document.getElementById('tip-swatch')!;
  const group = document.getElementById('tip-group')!;
  const id = document.getElementById('tip-id')!;
  const facts = document.getElementById('tip-facts')!;
  const tags = document.getElementById('tip-tags')!;

  let anchor: THREE.Vector3 | null = null;
  let width = 0, height = 0;
  const projected = new THREE.Vector3();

  function measure(): void {
    width = element.offsetWidth;
    height = element.offsetHeight;
  }

  function close(): void {
    element.hidden = true;
    anchor = null;
  }

  document.getElementById('tip-close')!.addEventListener('click', close);
  addEventListener('resize', measure); // the panel narrows on small screens

  return {
    open(info, point) {
      icon.textContent = info.icon ?? '';
      icon.hidden = !info.icon;
      title.textContent = info.title;
      swatch.style.background = `#${info.color.toString(16).padStart(6, '0')}`;
      group.textContent = info.group;
      id.textContent = `· ${info.id}`;

      facts.replaceChildren();
      addFact(facts, 'Height', `${info.height} m`, info.heightSource);
      addFact(facts, 'Footprint', `${Math.round(info.footprint).toLocaleString('en-US')} m²`);
      addFact(facts, 'Corners', String(info.corners));

      tags.replaceChildren();
      for (const [key, value] of info.tags) addTag(tags, key, value);
      tags.scrollTop = 0;

      element.hidden = false;
      measure();
      anchor = point;
    },

    close,

    update(camera) {
      if (!anchor) return;
      projected.copy(anchor).project(camera);
      const onScreen = projected.z < 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
      element.style.visibility = onScreen ? 'visible' : 'hidden';
      if (!onScreen) return;

      const x = (projected.x + 1) / 2 * innerWidth;
      const y = (1 - projected.y) / 2 * innerHeight;

      let top = y - height - GAP;
      const below = top < MARGIN;
      if (below) top = y + GAP;
      top = clamp(top, MARGIN, Math.max(MARGIN, innerHeight - height - MARGIN));
      const left = clamp(x - width / 2, MARGIN, Math.max(MARGIN, innerWidth - width - MARGIN));

      element.style.transform = `translate(${left}px, ${top}px)`;
      element.classList.toggle('below', below);
      element.style.setProperty('--caret', `${clamp(x - left, CARET_INSET, width - CARET_INSET)}px`);
    },
  };
}
