import { FAVORITES_SHORTCUT, FAVORITE_NAME_MAX, MAX_FAVORITES } from '../config.ts';
import type { Favorite, MapPoint } from '../settings/settingsStore.ts';
import { formatPlace, roundMeters } from './location.ts';
import { isTyping } from './settingsDialog.ts';

export interface FavoritesDialogOptions {
  load(): Favorite[];
  /** Returns false when the list could not be stored. */
  store(list: Favorite[]): boolean;
  carPoint(): MapPoint;
  streetHere(): string | null;
  /** Called with true when the dialog opens and false when it closes. */
  onOpenChange(open: boolean): void;
  goTo(favorite: Favorite): void;
}

export interface FavoritesDialog {
  readonly isOpen: boolean;
  open(): void;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The street the car is on, or the smallest "Location N" not yet used. */
function defaultName(list: Favorite[], street: string | null): string {
  if (street) return street.slice(0, FAVORITE_NAME_MAX);
  const used = new Set(list.map(f => f.name));
  let n = 1;
  while (used.has(`Location ${n}`)) n++;
  return `Location ${n}`;
}

const PENCIL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';

export function createFavoritesDialog(options: FavoritesDialogOptions): FavoritesDialog {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('favorites-dialog');
  const star = $<HTMLButtonElement>('favorites-button');
  const saveButton = $<HTMLButtonElement>('favorites-save');
  const hint = $('favorites-hint');
  const listEl = $('favorites-list');
  const noteEl = $('favorites-note');

  let list: Favorite[] = [];
  let unsaved = false; // the browser refused the last write, so storage is older than `list`
  let editingId: string | null = null;
  let removal: { favorite: Favorite; index: number } | null = null;

  function persist(): void {
    unsaved = !options.store(list);
    showNote();
  }

  function showNote(): void {
    noteEl.replaceChildren();
    if (unsaved) {
      noteEl.textContent = 'Couldn’t save in this browser. Favorites last until you reload.';
    } else if (removal) {
      const text = document.createElement('span');
      text.dir = 'auto';
      text.textContent = `Removed ${removal.favorite.name}.`;
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = 'Undo';
      undo.addEventListener('click', () => {
        if (!removal) return;
        list.splice(removal.index, 0, removal.favorite);
        removal = null;
        persist();
        render();
      });
      noteEl.append(text, undo);
    }
    noteEl.hidden = noteEl.childNodes.length === 0;
  }

  function updateHint(): void {
    const full = list.length >= MAX_FAVORITES;
    saveButton.disabled = full;
    if (full) {
      hint.textContent = `The list is full (${MAX_FAVORITES}). Remove one to save another.`;
      return;
    }
    const street = options.streetHere();
    hint.textContent = `Saves where the car is now: ${street ? street + ', ' : ''}${formatPlace(options.carPoint())}`;
  }

  function renderRow(favorite: Favorite): HTMLElement {
    const row = document.createElement('li');
    row.className = 'fav-row';
    const main = document.createElement('div');
    main.style.minWidth = '0';

    if (editingId === favorite.id) {
      const input = document.createElement('input');
      input.maxLength = FAVORITE_NAME_MAX;
      input.dir = 'auto';
      input.value = favorite.name;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Name');
      const error = document.createElement('div');
      error.className = 'fav-err';
      error.hidden = true;
      error.textContent = 'Enter a name';

      const finish = () => {
        editingId = null;
        row.replaceWith(renderRow(favorite));
      };
      const commit = (): void => {
        const name = input.value.trim();
        if (name === '') {
          input.setAttribute('aria-invalid', 'true');
          error.hidden = false;
          return;
        }
        favorite.name = name;
        persist();
        finish();
      };
      input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid');
        error.hidden = true;
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation(); // cancels the rename only, not the dialog
          finish();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      });
      input.addEventListener('blur', () => {
        if (editingId !== favorite.id) return;
        if (input.value.trim() === '') finish(); else commit(); // an empty name restores the old one
      });
      main.append(input, error);
      queueMicrotask(() => { input.focus(); input.select(); });
    } else {
      const name = document.createElement('div');
      name.className = 'fav-name';
      name.dir = 'auto';
      name.textContent = favorite.name;
      main.append(name);
    }
    const pos = document.createElement('div');
    pos.className = 'fav-pos';
    pos.textContent = formatPlace(favorite);
    main.append(pos);

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'icon-btn';
    rename.innerHTML = PENCIL;
    rename.title = 'Rename';
    rename.setAttribute('aria-label', `Rename ${favorite.name}`);
    rename.addEventListener('click', () => {
      removal = null;
      showNote();
      editingId = favorite.id;
      row.replaceWith(renderRow(favorite));
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn';
    remove.textContent = '×';
    remove.title = 'Remove';
    remove.setAttribute('aria-label', `Remove ${favorite.name}`);
    remove.addEventListener('click', () => {
      const index = list.indexOf(favorite);
      if (index < 0) return;
      list.splice(index, 1);
      removal = { favorite, index };
      editingId = null;
      persist();
      render();
    });

    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.textContent = 'Go to';
    go.setAttribute('aria-label', `Go to ${favorite.name}`);
    go.addEventListener('click', () => {
      dialog.close();
      options.goTo(favorite);
    });

    row.append(main, rename, remove, go);
    return row;
  }

  function render(): void {
    updateHint();
    listEl.replaceChildren();
    if (list.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'fav-empty';
      empty.textContent = 'No favorites yet. Drive somewhere and press Save current location.';
      listEl.append(empty);
    } else {
      for (const favorite of list) listEl.append(renderRow(favorite));
    }
    showNote();
  }

  function open(): void {
    if (dialog.open) return;
    if (!unsaved) list = options.load(); // always show the latest stored list
    editingId = null;
    removal = null;
    render();
    options.onOpenChange(true);
    dialog.showModal();
    saveButton.focus();
  }

  saveButton.addEventListener('click', () => {
    if (list.length >= MAX_FAVORITES) return;
    const { x, y } = options.carPoint();
    const favorite: Favorite = { id: newId(), name: defaultName(list, options.streetHere()), x: roundMeters(x), y: roundMeters(y) };
    list.unshift(favorite);
    removal = null;
    editingId = favorite.id; // opens in rename mode with the name selected
    persist();
    render();
  });

  // Esc fires `cancel` and closing by any route fires `close`; both end up here.
  dialog.addEventListener('close', () => {
    editingId = null;
    removal = null;
    options.onOpenChange(false);
    star.focus();
  });
  star.addEventListener('click', open);
  $('favorites-close').addEventListener('click', () => dialog.close());
  // A click whose target is the dialog itself landed on the backdrop.
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  addEventListener('keydown', e => {
    if (e.code !== FAVORITES_SHORTCUT || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (!dialog.open && document.querySelector('dialog[open]')) return; // another dialog is open
    e.preventDefault();
    if (dialog.open) dialog.close(); else open();
  });

  return { get isOpen() { return dialog.open; }, open };
}
