// The Navigation dialog (TN-39): the town's favorites, each with a Navigate button, and the active destination with
// Stop. Opened with N or the corner button; written the same way as favoritesDialog.ts.

import { NAVIGATION_SHORTCUT } from '../config.ts';
import type { Favorite, MapPoint } from '../settings/settingsStore.ts';
import { awayText } from '../nav/navigation.ts';
import { formatLength } from '../nav/routeProgress.ts';
import { formatPlace } from './location.ts';
import { isTyping } from './settingsDialog.ts';

export interface NavigationDialogOptions {
  load(): Favorite[];
  carPoint(): MapPoint;
  /** The active destination's favorite id and meters left, or null when not navigating. */
  active(): { id: string; name: string; left: number | null } | null;
  navigate(favorite: Favorite): void;
  stop(): void;
  openFavorites(): void;
  onOpenChange(open: boolean): void;
}

export interface NavigationDialog {
  readonly isOpen: boolean;
  /** Marks the corner button while a route is active. */
  setActive(active: boolean): void;
}

export function createNavigationDialog(options: NavigationDialogOptions): NavigationDialog {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('navigation-dialog');
  const button = $<HTMLButtonElement>('navigation-button');
  const listEl = $('navigation-list');
  const activeEl = $('navigation-active');
  let afterClose: (() => void) | null = null;

  function renderActive(): void {
    const active = options.active();
    activeEl.hidden = !active;
    if (!active) return;
    $('navigation-dest').textContent = active.name;
    $('navigation-left').textContent = active.left === null ? 'Calculating…' : `${formatLength(active.left)} left`;
  }

  function render(): void {
    renderActive();
    const list = options.load();
    const car = options.carPoint();
    const active = options.active();
    listEl.replaceChildren();
    if (!list.length) {
      const empty = document.createElement('li');
      empty.className = 'nav-empty';
      const link = document.createElement('button');
      link.type = 'button';
      link.textContent = 'Favorites';
      link.addEventListener('click', () => {
        afterClose = options.openFavorites;
        dialog.close();
      });
      const key = document.createElement('kbd');
      key.textContent = 'F';
      empty.append('No favorites yet. Save places in ', link, ' (', key, '), then pick one here.');
      listEl.append(empty);
      return;
    }
    for (const favorite of list) {
      const row = document.createElement('li');
      row.className = 'nav-row';
      const main = document.createElement('div');
      main.style.minWidth = '0';
      const name = document.createElement('div');
      name.className = 'nav-name';
      name.dir = 'auto';
      name.textContent = favorite.name;
      const pos = document.createElement('div');
      pos.className = 'nav-pos';
      pos.textContent = `${formatPlace(favorite)} · ${awayText(Math.hypot(favorite.x - car.x, favorite.y - car.y))}`;
      main.append(name, pos);
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      const current = active?.id === favorite.id;
      go.textContent = current ? 'Navigating' : 'Navigate';
      go.disabled = current;
      go.setAttribute('aria-label', current ? `Navigating to ${favorite.name}` : `Navigate to ${favorite.name}`);
      go.addEventListener('click', () => {
        afterClose = () => options.navigate(favorite);
        dialog.close();
      });
      row.append(main, go);
      listEl.append(row);
    }
  }

  function open(): void {
    if (dialog.open) return;
    render();
    options.onOpenChange(true);
    dialog.showModal();
    (listEl.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? $('navigation-close')).focus();
  }

  $('navigation-stop').addEventListener('click', () => {
    options.stop();
    render();
  });
  // Esc fires `cancel` and closing by any route fires `close`; both end up here.
  dialog.addEventListener('close', () => {
    options.onOpenChange(false);
    const then = afterClose;
    afterClose = null;
    if (then) then(); else button.focus();
  });
  button.addEventListener('click', open);
  $('navigation-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  addEventListener('keydown', e => {
    if (e.code !== NAVIGATION_SHORTCUT || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (!dialog.open && document.querySelector('dialog[open]')) return; // another dialog is open
    e.preventDefault();
    if (dialog.open) dialog.close(); else open();
  });

  return {
    get isOpen() { return dialog.open; },
    setActive(active) { button.classList.toggle('active', active); },
  };
}
