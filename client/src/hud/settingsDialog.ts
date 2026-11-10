import type { TownBounds } from '@town-navigator/shared';
import { SETTINGS_SHORTCUT } from '../config.ts';
import type { StartMatch } from '../town/roads.ts';
import { toWorld, type MapPoint } from '../settings/settingsStore.ts';

const MAX_DISTANCE = 50_000; // meters

function parseMeters(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && Math.abs(value) <= MAX_DISTANCE ? value : null;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

const round1 = (n: number) => String(Math.round(n * 10) / 10);

export interface SettingsDialogOptions {
  initial(): MapPoint;
  carPoint(): MapPoint;
  preview(point: MapPoint): StartMatch;
  bounds: TownBounds;
  onOpenChange(open: boolean): void;
  /** Applies the point; returns false when it could not be stored. */
  onSave(point: MapPoint): boolean;
}

export interface SettingsDialog {
  readonly isOpen: boolean;
}

export function createSettingsDialog(options: SettingsDialogOptions): SettingsDialog {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('settings-dialog');
  const gear = $<HTMLButtonElement>('settings-button');
  const east = $<HTMLInputElement>('settings-east');
  const north = $<HTMLInputElement>('settings-north');
  const error = $('settings-error');
  const preview = $('settings-preview');
  const note = $('settings-note');
  const save = $<HTMLButtonElement>('settings-save');

  function read(): MapPoint | null {
    const x = parseMeters(east.value), y = parseMeters(north.value);
    return x === null || y === null ? null : { x, y };
  }

  function line(text: string, className?: string): HTMLElement {
    const el = document.createElement('div');
    if (className) el.className = className;
    el.textContent = text;
    return el;
  }

  function refresh(): void {
    const point = read();
    const invalid = point === null;
    for (const input of [east, north]) {
      input.setAttribute('aria-invalid', String(parseMeters(input.value) === null));
    }
    error.hidden = !invalid;
    error.textContent = invalid ? 'Enter a distance in meters, like 120 or -35.5' : '';
    save.disabled = invalid;
    preview.replaceChildren();
    if (!point) return;

    const match = options.preview(point);
    const { x, z } = toWorld(point);
    const [minX, minY, maxX, maxY] = options.bounds;
    const outside = x < minX || x > maxX || z < -maxY || z > -minY;
    if (match.distance === 0 && match.name === undefined && match.x === x && match.z === z) {
      preview.append(line('This town has no drivable roads, so the car starts at the point itself.', 'warn'));
      return;
    }
    const street = match.name ?? 'an unnamed road';
    const distance = match.distance < 1000 ? `${Math.round(match.distance)} m` : `${(match.distance / 1000).toFixed(1)} km`;
    const first = document.createElement('div');
    first.append('Starts on ');
    const b = document.createElement('b');
    b.textContent = street;
    b.dir = 'auto';
    first.append(b, `, about ${distance} away`);
    preview.append(first);
    if (outside) preview.append(line('This point is outside the town’s area.', 'warn'));
  }

  function open(): void {
    if (dialog.open) return;
    const point = options.initial();
    east.value = round1(point.x);
    north.value = round1(point.y);
    note.hidden = true;
    refresh();
    options.onOpenChange(true);
    dialog.showModal();
    east.focus();
    east.select();
  }

  // Esc fires `cancel` and closing by any route fires `close`; both end up here.
  dialog.addEventListener('close', () => {
    options.onOpenChange(false);
    gear.focus();
  });

  gear.addEventListener('click', open);
  for (const input of [east, north]) input.addEventListener('input', refresh);

  $('settings-use-car').addEventListener('click', () => {
    const p = options.carPoint();
    east.value = round1(p.x);
    north.value = round1(p.y);
    refresh();
  });
  $('settings-reset').addEventListener('click', () => {
    east.value = '0';
    north.value = '0';
    refresh();
  });
  for (const id of ['settings-cancel', 'settings-close']) $(id).addEventListener('click', () => dialog.close());
  // A click whose target is the dialog itself landed on the backdrop.
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  dialog.addEventListener('submit', e => {
    e.preventDefault();
    const point = read();
    if (!point) return;
    const stored = options.onSave(point);
    if (stored) {
      dialog.close();
    } else {
      note.textContent = 'Couldn’t save in this browser. This start lasts until you reload.';
      note.hidden = false;
    }
  });

  addEventListener('keydown', e => {
    if (e.code !== SETTINGS_SHORTCUT || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    e.preventDefault(); // stops the "p" landing in the field that open() focuses
    if (dialog.open) dialog.close(); else open();
  });

  return {
    get isOpen() { return dialog.open; },
  };
}
