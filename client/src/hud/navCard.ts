// The navigation card at the top of the screen (TN-39): the next turn with a countdown, the turn after it when it is
// close, and the distance and time left. Messages (calculating, rerouting, arrived, errors) replace the turn.
//
// The text refreshes 4 times a second, like the location readout, and the DOM is written only when it changes.

import { formatDistance, formatDuration, formatLength } from '../nav/routeProgress.ts';
import type { NavView } from '../nav/navigation.ts';

const UPDATE_INTERVAL = 0.25; // s
const PULSE_AT = [150, 50];   // m before a maneuver

export interface NavCard {
  update(dt: number, view: NavView): void;
}

export function createNavCard({ onStop }: { onStop(): void }): NavCard {
  const card = document.getElementById('nav-card')!;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let updateIn = 0;
  let html = '';
  let pulseKey = '', pulseBand = 0;

  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  function render(view: NavView): string {
    if (view.kind === 'hidden') return '';
    const stop = '<button class="nav-stop" type="button" aria-label="Stop navigation">×</button>';
    if (view.kind === 'message') {
      return `<div class="nav-msg${view.error ? ' error' : ''}"><span class="nav-glyph" aria-hidden="true">${esc(view.glyph)}</span>`
        + `<span dir="auto">${esc(view.text)}</span>${stop}</div>`;
    }
    const road = view.road ? `<div class="nav-road" dir="auto">onto ${esc(view.road)}</div>` : '';
    const then = view.then ? `<div class="nav-then">then <b aria-hidden="true">${esc(view.then.glyph)}</b> ${esc(view.then.text)}</div>` : '';
    return `<div class="nav-now"><span class="nav-glyph" aria-hidden="true">${esc(view.glyph)}</span>`
      + `<div><div class="nav-dist">${esc(formatDistance(view.distance))}</div><div class="nav-what" dir="auto">${esc(view.text)}</div>${road}</div></div>`
      + then
      + `<div class="nav-foot"><span dir="auto">To ${esc(view.destination)} · ${esc(formatLength(view.left))} · ${esc(formatDuration(view.eta))}</span>${stop}</div>`;
  }

  card.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('.nav-stop')) onStop();
  });

  return {
    update(dt, view) {
      updateIn -= dt;
      // Show and hide at once; refresh the text 4 times a second.
      const visible = view.kind !== 'hidden';
      if (visible === card.hidden || updateIn <= 0) {
        updateIn = UPDATE_INTERVAL;
        const next = render(view);
        if (next !== html) {
          html = next;
          card.innerHTML = next;
        }
        card.hidden = !visible;
        card.classList.toggle('error', view.kind === 'message' && view.error);
      }
      if (view.kind !== 'turn') { pulseKey = ''; return; }
      const band = PULSE_AT.filter(at => view.distance < at).length;
      if (view.key !== pulseKey) { pulseKey = view.key; pulseBand = band; return; } // a new maneuver: no pulse for being close already
      if (band > pulseBand) {
        pulseBand = band;
        if (!reducedMotion.matches) {
          card.classList.remove('pulse');
          void card.offsetWidth; // restart the animation
          card.classList.add('pulse');
        }
      }
    },
  };
}
