import { TILE_MAP_SHORTCUT } from '../config.ts';
import { fromWorld } from '../settings/settingsStore.ts';
import type { TownTiles } from '../town/tileManager.ts';
import { isTyping } from './settingsDialog.ts';

export interface TileMapOptions {
  tiles: TownTiles;
  townId: string;
  carPose(): { x: number; z: number; heading: number };
  /** Called with true when the window opens and false when it closes. */
  onOpenChange(open: boolean): void;
}

export interface TileMap {
  readonly isOpen: boolean;
  toggle(): void;
}

const MAX_MAP_HEIGHT = 420; // CSS pixels
const MIN_CELL = 8;
const DIALOG_PADDING = 36; // 18 px each side, as in styles.css
const WRAP_PADDING = 16;   // 8 px each side
const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

export function createTileMap({ tiles, townId, carPose, onOpenChange }: TileMapOptions): TileMap {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const dialog = $<HTMLDialogElement>('tile-map-dialog');
  const canvas = $<HTMLCanvasElement>('tile-map-canvas');
  const tip = $('tile-map-tip');
  const foot = $('tile-map-foot');
  const hint = $('tile-map-hint');
  const wrap = canvas.parentElement!;
  const ctx = canvas.getContext('2d')!;

  const { index } = tiles;
  const { grid, bbox } = index;
  const size = index.tileSize;
  const whole = index.tiles.length === 0; // whole-town mode: one synthetic tile covering the bbox
  const listed = whole
    ? [{ tx: 0, ty: 0, file: 'whole town', buildings: 0, roads: 0, other: 0, bytes: 0 }]
    : index.tiles;
  const lookup = new Map(listed.map(t => [`${t.tx},${t.ty}`, t]));
  const maxBuildings = Math.max(1, ...listed.map(t => t.buildings));
  const cols = grid.maxTx - grid.minTx + 1;
  const rows = grid.maxTy - grid.minTy + 1;
  // Meters to map space. The tile grid is anchored at the origin; the whole-town tile starts at the bbox corner.
  const ox = whole ? bbox[0] : 0;
  const oy = whole ? bbox[1] : 0;

  let frame = 0;
  let cell = MIN_CELL;
  let hover: { clientX: number; clientY: number } | null = null;

  hint.textContent = `${townId} · ${size} m tiles · north up · `;
  hint.insertAdjacentHTML('beforeend', '<kbd>B</kbd> or <kbd>Esc</kbd> to close');

  const stateOf = (statuses: ReadonlyMap<string, string>, key: string) => statuses.get(key) ?? 'not loaded';

  function draw(): void {
    const statuses = tiles.statuses();
    // Measured from the dialog, not the wrapper: the wrapper grows with the canvas and would never shrink.
    const available = Math.max(dialog.clientWidth - DIALOG_PADDING - WRAP_PADDING, 1);
    cell = Math.max(MIN_CELL, Math.floor(Math.min(available / cols, MAX_MAP_HEIGHT / rows)));
    const width = cols * cell;
    const height = rows * cell;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const cx = (tx: number) => (tx - grid.minTx) * cell;
    const cy = (ty: number) => (grid.maxTy - ty) * cell; // north up

    // Cells with nothing in them: faint outlines.
    ctx.strokeStyle = 'rgba(169, 179, 191, 0.12)';
    ctx.lineWidth = 1;
    for (let tx = grid.minTx; tx <= grid.maxTx; tx++) {
      for (let ty = grid.minTy; ty <= grid.maxTy; ty++) ctx.strokeRect(cx(tx) + 0.5, cy(ty) + 0.5, cell - 1, cell - 1);
    }

    let loaded = 0, loading = 0, failed = 0;
    for (const t of listed) {
      const status = stateOf(statuses, `${t.tx},${t.ty}`);
      const x = cx(t.tx) + 1.5, y = cy(t.ty) + 1.5, side = cell - 3;
      if (status === 'loaded') {
        loaded++;
        ctx.fillStyle = `rgba(255, 209, 102, ${(0.35 + 0.65 * Math.sqrt(t.buildings / maxBuildings)).toFixed(2)})`;
        ctx.fillRect(x, y, side, side);
      } else if (status === 'loading') {
        loading++;
        ctx.fillStyle = '#1d222c';
        ctx.fillRect(x, y, side, side);
        ctx.strokeStyle = '#ffd166';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, side - 2, side - 2);
      } else if (status === 'failed') {
        failed++;
        ctx.fillStyle = '#ff9c8a';
        ctx.fillRect(x, y, side, side);
      } else {
        ctx.fillStyle = '#3a414e';
        ctx.fillRect(x, y, side, side);
      }
    }

    const mx = (meters: number) => ((meters - ox) / size - grid.minTx) * cell;
    const my = (northMeters: number) => (grid.maxTy + 1 - (northMeters - oy) / size) * cell;
    const scale = cell / size;

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#a9b3bf';
    ctx.lineWidth = 1;
    ctx.strokeRect(mx(bbox[0]), my(bbox[3]), (bbox[2] - bbox[0]) * scale, (bbox[3] - bbox[1]) * scale);
    const carTile = tiles.carTile();
    if (!whole) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx(carTile.tx - 1), cy(carTile.ty + 1), cell * 3, cell * 3);
    }
    ctx.setLineDash([]);

    // The car. Heading 0 drives toward +z, which is south on the map, so the up-pointing arrow turns by PI - heading.
    const pose = carPose();
    ctx.save();
    ctx.translate(mx(pose.x), my(-pose.z));
    ctx.rotate(Math.PI - pose.heading);
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7, 7);
    ctx.lineTo(0, 3);
    ctx.lineTo(-7, 7);
    ctx.closePath();
    ctx.fillStyle = '#ffd166';
    ctx.strokeStyle = '#141820';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fill();
    ctx.restore();

    const where = fromWorld(pose);
    const notLoaded = listed.length - loaded - loading - failed;
    foot.textContent = `${loaded} loaded · ${loading} loading · ${failed} failed · ${notLoaded} not loaded · `
      + `car in tile ${carTile.tx}, ${carTile.ty} (E ${fmt(where.x)}, N ${fmt(where.y)})`;
    showTip(statuses);
  }

  // --- hover

  function showTip(statuses: ReadonlyMap<string, string>): void {
    if (!hover) { tip.hidden = true; return; }
    const rect = canvas.getBoundingClientRect();
    const tx = grid.minTx + Math.floor((hover.clientX - rect.left) / cell);
    const ty = grid.maxTy - Math.floor((hover.clientY - rect.top) / cell);
    const t = lookup.get(`${tx},${ty}`);
    if (!t) { tip.hidden = true; return; }
    const name = t.file.replace(/\.geojson$/, '');
    tip.textContent = `${name} · ${t.buildings} buildings · ${t.roads} roads · ${stateOf(statuses, `${tx},${ty}`)}`;
    tip.hidden = false;
    const box = wrap.getBoundingClientRect();
    const left = Math.min(hover.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${hover.clientY - box.top + 14}px`;
  }

  canvas.addEventListener('mousemove', e => { hover = { clientX: e.clientX, clientY: e.clientY }; });
  canvas.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; });

  // --- open and close

  function loop(): void {
    draw();
    frame = requestAnimationFrame(loop);
  }

  function open(): void {
    if (dialog.open) return;
    dialog.showModal();
    onOpenChange(true);
    loop();
  }

  dialog.addEventListener('close', () => {
    cancelAnimationFrame(frame); // while closed it does no work
    hover = null;
    tip.hidden = true;
    onOpenChange(false);
  });
  $('tile-map-button').addEventListener('click', open);
  $('tile-map-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  addEventListener('keydown', e => {
    if (e.code !== TILE_MAP_SHORTCUT || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (!dialog.open && document.querySelector('dialog[open]')) return; // settings or favorites is open
    e.preventDefault();
    if (dialog.open) dialog.close(); else open();
  });

  return {
    get isOpen() { return dialog.open; },
    toggle() { if (dialog.open) dialog.close(); else open(); },
  };
}
