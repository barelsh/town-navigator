import type { TownBounds } from '@town-navigator/shared';
import { SETTINGS_SHORTCUT } from '../config.ts';
import type { StartMatch } from '../town/roads.ts';
import { DEFAULT_VEHICLE, VEHICLES } from '../car/vehicles.ts';
import type { Appearance } from '../town/buildings.ts';
import { createVehiclePreview } from './vehiclePreview.ts';
import { ACCEL, KMH_PER_MPS, REVERSE_SHARE } from '../car/carController.ts';
import {
  DEFAULT_SPEED_LIMIT_KMH, MAX_SPEED_LIMIT_KMH, MIN_SPEED_LIMIT_KMH, toWorld, type MapPoint,
} from '../settings/settingsStore.ts';

const MAX_DISTANCE = 50_000; // meters

function parseMeters(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && Math.abs(value) <= MAX_DISTANCE ? value : null;
}

const TEXT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password']);

/** True while a text field has focus; a checkbox or radio doesn't count. */
export function isTyping(target: EventTarget | null): boolean {
  return (target instanceof HTMLInputElement && TEXT_TYPES.has(target.type)) || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function parseLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= MIN_SPEED_LIMIT_KMH && value <= MAX_SPEED_LIMIT_KMH ? value : null;
}

function limitFacts(kmh: number): string {
  const reverse = Math.round(kmh * REVERSE_SHARE);
  const seconds = (kmh / KMH_PER_MPS / ACCEL).toFixed(1);
  return `Reverse up to ${reverse} km/h · 0 to ${kmh} in ${seconds} s`;
}

const round1 = (n: number) => String(Math.round(n * 10) / 10);

/** What the dialog edits. */
export interface DialogValues {
  startPoint: MapPoint;
  speedLimitKmh: number;
  vehicle: string;
  appearance: Appearance;
  monitoring: boolean;
}

export interface SettingsDialogOptions {
  initial(): DialogValues;
  carPoint(): MapPoint;
  preview(point: MapPoint): StartMatch;
  bounds: TownBounds;
  onOpenChange(open: boolean): void;
  /** Applies the values; returns false when they could not be stored. */
  onSave(values: DialogValues): boolean;
}

export interface SettingsDialog {
  readonly isOpen: boolean;
  /** Flips the Monitoring box while the dialog is open; it applies on Save like the other fields. */
  toggleMonitoring(): void;
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
  const slider = $<HTMLInputElement>('settings-limit-slider');
  const limitInput = $<HTMLInputElement>('settings-limit-input');
  const limitError = $('settings-limit-error');
  const limitFactsLine = $('settings-limit-facts');
  const cars = $('settings-cars');
  const carsDetails = $<HTMLDetailsElement>('settings-cars-details');
  const carsSummary = $('settings-cars-summary');
  const monitoring = $<HTMLInputElement>('settings-monitoring');
  const appearanceRadios = [...document.querySelectorAll<HTMLInputElement>('input[name="settings-appearance"]')];
  const chosenAppearance = (): Appearance => appearanceRadios.find(r => r.checked)?.value === 'plain' ? 'plain' : 'realistic';
  const carPreview = createVehiclePreview($('settings-car-preview'), $('settings-car-name'), $('settings-car-size'));

  cars.innerHTML = VEHICLES.map(v =>
    `<label><input type="radio" name="settings-car" value="${v.id}"><b>${v.name}</b>` +
    `<small>${v.id === DEFAULT_VEHICLE ? '<span class="default">Default · </span>' : ''}${v.blurb}</small></label>`).join('');
  const radios = [...cars.querySelectorAll<HTMLInputElement>('input')];
  const chosenVehicle = () => radios.find(radio => radio.checked)?.value ?? DEFAULT_VEHICLE;
  const updateCarsSummary = () => {
    const spec = VEHICLES.find(v => v.id === chosenVehicle());
    carsSummary.textContent = `All cars (${VEHICLES.length}) · ${spec?.name ?? ''}`;
  };
  cars.addEventListener('change', () => {
    carPreview.show(chosenVehicle());
    updateCarsSummary();
  });

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
    const limit = parseLimit(limitInput.value);
    limitInput.setAttribute('aria-invalid', String(limit === null));
    limitError.hidden = limit !== null;
    limitError.textContent = limit === null
      ? `Enter a whole number from ${MIN_SPEED_LIMIT_KMH} to ${MAX_SPEED_LIMIT_KMH}` : '';
    if (limit !== null) {
      slider.value = String(limit);
      limitFactsLine.textContent = limitFacts(limit);
    }
    save.disabled = invalid || limit === null;
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
    const { startPoint: point, speedLimitKmh, vehicle, appearance, monitoring: shown } = options.initial();
    monitoring.checked = shown;
    for (const radio of appearanceRadios) radio.checked = radio.value === appearance;
    for (const radio of radios) radio.checked = radio.value === vehicle;
    carsDetails.open = false; // the list is long, so it starts folded
    updateCarsSummary();
    east.value = round1(point.x);
    north.value = round1(point.y);
    limitInput.value = slider.value = String(speedLimitKmh);
    note.hidden = true;
    refresh();
    options.onOpenChange(true);
    dialog.showModal();
    carPreview.start(vehicle);
    east.focus();
    east.select();
  }

  // Esc fires `cancel` and closing by any route fires `close`; both end up here.
  dialog.addEventListener('close', () => {
    carPreview.stop();
    options.onOpenChange(false);
    gear.focus();
  });

  gear.addEventListener('click', open);
  for (const input of [east, north, limitInput]) input.addEventListener('input', refresh);
  slider.addEventListener('input', () => { limitInput.value = slider.value; refresh(); });
  slider.addEventListener('keydown', e => {
    if (e.code !== 'PageUp' && e.code !== 'PageDown') return;
    e.preventDefault(); // the browser's own page step isn't 10
    const next = Number(slider.value) + (e.code === 'PageUp' ? 10 : -10);
    limitInput.value = slider.value = String(Math.min(MAX_SPEED_LIMIT_KMH, Math.max(MIN_SPEED_LIMIT_KMH, next)));
    refresh();
  });
  $('settings-limit-reset').addEventListener('click', () => {
    limitInput.value = String(DEFAULT_SPEED_LIMIT_KMH);
    refresh();
  });

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
    const point = read(), speedLimitKmh = parseLimit(limitInput.value);
    if (!point || speedLimitKmh === null) return;
    const stored = options.onSave({ startPoint: point, speedLimitKmh, vehicle: chosenVehicle(), appearance: chosenAppearance(), monitoring: monitoring.checked });
    if (stored) {
      dialog.close();
    } else {
      note.textContent = 'Couldn’t save in this browser. These settings last until you reload.';
      note.hidden = false;
    }
  });

  addEventListener('keydown', e => {
    if (e.code !== SETTINGS_SHORTCUT || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (!dialog.open && document.querySelector('dialog[open]')) return; // another dialog is open
    e.preventDefault(); // stops the "p" landing in the field that open() focuses
    if (dialog.open) dialog.close(); else open();
  });

  return {
    get isOpen() { return dialog.open; },
    toggleMonitoring() { if (dialog.open) monitoring.checked = !monitoring.checked; },
  };
}
