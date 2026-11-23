import * as THREE from 'three';
import type { BuildingFeature, TileEntry, TileIndex, Town, TownTile } from '@town-navigator/shared';
import { fetchTile, HttpError } from '../api/townApi.ts';
import { LOAD_RADIUS, MAX_IN_FLIGHT, UNLOAD_RADIUS } from '../config.ts';
import type { Appearance } from './buildings.ts';
import type { Obstacle } from './collision.ts';
import { createRoadGraph, type RoadGraph, type WorldJunction } from './roadGraph.ts';
import type { StreetSegment } from './roads.ts';
import { buildChunk, type TownChunk, type TownKit } from './townChunk.ts';

export type TileStatus = 'loading' | 'loaded' | 'failed';

interface XZ { x: number; z: number }
interface TileKey { tx: number; ty: number }

export interface TownTiles {
  index: TileIndex; // whole mode: one synthetic tile covering the bbox
  pickTargets: Map<THREE.Object3D, BuildingFeature>;
  occluders: THREE.Mesh[];
  tallestBuilding: number;
  /** Per frame. Cheap unless the car changed tile or a fetch finished. */
  update(position: XZ): void;
  /** Fetches and builds the tiles around a point at once, without the one-per-frame limit. */
  ensureLoaded(point: XZ): Promise<void>;
  /** The 3 x 3 around the car's tile (cached), or around a point. */
  obstaclesNear(point?: XZ): Obstacle[];
  segmentsNear(point?: XZ): StreetSegment[];
  /** Road graph over the 3 x 3 around the car's tile. Built on first use, cached until the tiles change. */
  roadGraphNear(): RoadGraph;
  setAppearance(appearance: Appearance): void;
  updateLabels(heading: number): void;
  /** Status of every tile that isn't idle, for the tile map. Keys are `${tx},${ty}`. */
  statuses(): ReadonlyMap<string, TileStatus>;
  carTile(): TileKey;
  /** Called when a chunk is added or removed, or the tallest building grew. */
  onChange(listener: () => void): void;
}

const RETRY_DELAYS = [1000, 2000, 4000]; // milliseconds
const keyOf = ({ tx, ty }: TileKey) => `${tx},${ty}`;
const ring = (a: TileKey, b: TileKey) => Math.max(Math.abs(a.tx - b.tx), Math.abs(a.ty - b.ty));

// ---------------------------------------------------------------------------------------------
// Whole town: one chunk, as before tiles existed.

export function createWholeTown(scene: THREE.Scene, kit: TownKit, town: Town, appearance: Appearance): TownTiles {
  const chunk = buildChunk(kit, town.features, appearance);
  scene.add(chunk.group);
  const [minX, minY, maxX, maxY] = town.bbox;
  const index: TileIndex = {
    town: '', source: '', units: 'meters', origin: town.origin, bbox: town.bbox,
    tileSize: Math.max(maxX - minX, maxY - minY),
    grid: { minTx: 0, maxTx: 0, minTy: 0, maxTy: 0 },
    tiles: [],
  };
  const listeners: (() => void)[] = [];
  let graph: RoadGraph | null = null;
  return {
    index,
    pickTargets: chunk.pickTargets,
    occluders: chunk.occluders,
    tallestBuilding: chunk.tallestBuilding,
    update() {},
    ensureLoaded: () => Promise.resolve(),
    obstaclesNear: () => chunk.obstacles,
    segmentsNear: () => chunk.segments,
    roadGraphNear: () => (graph ??= createRoadGraph(chunk.segments, [])), // no junctions: no zones
    setAppearance: a => chunk.setAppearance(a),
    updateLabels: h => chunk.updateLabels(h),
    statuses: () => new Map([['0,0', 'loaded']]),
    carTile: () => ({ tx: 0, ty: 0 }),
    onChange: listener => { listeners.push(listener); },
  };
}

// ---------------------------------------------------------------------------------------------
// Tile streaming.

interface Nearby { obstacles: Obstacle[]; segments: StreetSegment[]; junctions: WorldJunction[] }

interface Entry extends TileKey {
  key: string;
  info: TileEntry;
  status: TileStatus;
  controller: AbortController;
  tile?: TownTile;     // fetched, waiting to be built
  chunk?: TownChunk;
  fetched: Promise<void>; // settles when the fetch succeeded, failed or was aborted
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export function createTileManager(
  townId: string, scene: THREE.Scene, kit: TownKit, initialAppearance: Appearance, index: TileIndex,
): TownTiles {
  const size = index.tileSize;
  const lookup = new Map(index.tiles.map(t => [keyOf(t), t]));
  const entries = new Map<string, Entry>(); // in flight, ready, loaded or failed
  const ready: Entry[] = [];                // fetched, not built yet
  let queue: TileEntry[] = [];
  let inFlight = 0;
  let appearance = initialAppearance;
  let pinned = new Set<string>();           // tiles an ensureLoaded asked for, kept until the car moves on
  let car: TileKey | null = null;
  let carPosition: XZ = { x: 0, z: 0 };
  let nearby: Nearby | null = null;
  let graph: RoadGraph | null = null;
  const listeners: (() => void)[] = [];

  const pickTargets = new Map<THREE.Object3D, BuildingFeature>();
  const occluders: THREE.Mesh[] = [];
  const manager: TownTiles = {
    index, pickTargets, occluders, tallestBuilding: 0,
    update, ensureLoaded, obstaclesNear, segmentsNear, roadGraphNear, onChange,
    setAppearance(next) {
      appearance = next;
      for (const entry of entries.values()) entry.chunk?.setAppearance(next);
    },
    updateLabels(heading) {
      for (const entry of entries.values()) entry.chunk?.updateLabels(heading);
    },
    statuses() {
      return new Map([...entries.values()].map(e => [e.key, e.status]));
    },
    carTile() {
      return car ?? { tx: 0, ty: 0 };
    },
  };

  const tileAt = ({ x, z }: XZ): TileKey => ({ tx: Math.floor(x / size), ty: Math.floor(-z / size) });
  const distanceToCar = (t: TileKey) =>
    Math.hypot((t.tx + 0.5) * size - carPosition.x, (t.ty + 0.5) * size + carPosition.z);
  const changed = () => { nearby = null; graph = null; for (const listener of listeners) listener(); };

  function onChange(listener: () => void): void {
    listeners.push(listener);
  }

  // --- fetching

  function start(info: TileEntry): Entry {
    const controller = new AbortController();
    const entry: Entry = { ...info, key: keyOf(info), info, status: 'loading', controller, fetched: Promise.resolve() };
    entries.set(entry.key, entry);
    inFlight++;
    entry.fetched = load(entry).finally(() => {
      inFlight--;
      pump();
    });
    return entry;
  }

  async function load(entry: Entry): Promise<void> {
    const { signal } = entry.controller;
    for (let attempt = 0; ; attempt++) {
      try {
        entry.tile = await fetchTile(townId, entry.tx, entry.ty, signal);
        if (signal.aborted) return;
        ready.push(entry);
        retarget(false); // a fetch finished: the car's surroundings may need rebalancing
        return;
      } catch (error) {
        if (signal.aborted) return; // dropped on purpose: not a failure
        const missing = error instanceof HttpError && error.status === 404;
        if (missing) {
          console.warn(`Tile ${entry.key} is in the index but the server has no file for it. Run npm run tile again.`);
        } else if (attempt < RETRY_DELAYS.length) {
          await sleep(RETRY_DELAYS[attempt], signal);
          if (signal.aborted) return;
          continue;
        } else {
          console.warn(`Tile ${entry.key} failed to load after ${attempt + 1} tries:`, error);
        }
        entry.status = 'failed';
        changed();
        return;
      }
    }
  }

  function pump(): void {
    while (inFlight < MAX_IN_FLIGHT && queue.length) {
      const next = queue.shift()!;
      if (!entries.has(keyOf(next))) start(next);
    }
  }

  // --- building and dropping

  function build(entry: Entry): void {
    const at = ready.indexOf(entry);
    if (at >= 0) ready.splice(at, 1);
    if (entries.get(entry.key) !== entry || !entry.tile) return;
    const chunk = buildChunk(kit, entry.tile.features, appearance, entry.tile.junctions);
    entry.tile = undefined;
    entry.chunk = chunk;
    entry.status = 'loaded';
    scene.add(chunk.group);
    for (const [object, feature] of chunk.pickTargets) pickTargets.set(object, feature);
    occluders.push(...chunk.occluders);
    manager.tallestBuilding = Math.max(manager.tallestBuilding, chunk.tallestBuilding);
    changed();
  }

  function drop(entry: Entry): void {
    entries.delete(entry.key);
    const at = ready.indexOf(entry);
    if (at >= 0) ready.splice(at, 1);
    entry.controller.abort();
    const { chunk } = entry;
    if (!chunk) return;
    for (const object of chunk.pickTargets.keys()) pickTargets.delete(object);
    const gone = new Set(chunk.occluders);
    let kept = 0;
    for (const mesh of occluders) if (!gone.has(mesh)) occluders[kept++] = mesh;
    occluders.length = kept;
    chunk.dispose();
    entry.chunk = undefined;
    changed();
  }

  // --- which tiles

  /** Works out what to drop and what to fetch for the car's tile. `fresh` is a move to another tile. */
  function retarget(fresh: boolean): void {
    if (!car) return;
    if (fresh) pinned = new Set();
    for (const entry of [...entries.values()]) {
      if (pinned.has(entry.key)) continue;
      const far = ring(entry, car) > UNLOAD_RADIUS;
      // A failed tile is tried again the next time it becomes wanted, which is when the car moves to another tile.
      if (far || (fresh && entry.status === 'failed')) drop(entry);
    }
    queue = index.tiles
      .filter(t => ring(t, car!) <= LOAD_RADIUS && !entries.has(keyOf(t)))
      .sort((a, b) => ring(a, car!) - ring(b, car!) || distanceToCar(a) - distanceToCar(b));
    pump();
  }

  function update(position: XZ): void {
    carPosition = position;
    const tile = tileAt(position);
    if (!car || car.tx !== tile.tx || car.ty !== tile.ty) {
      car = tile;
      nearby = null;
      graph = null;
      retarget(true);
    }
    // One chunk per frame, the closest first, so a big tile doesn't stall the frame.
    const order = (e: Entry) => ring(e, car!) * 1e9 + distanceToCar(e);
    let best: Entry | null = null;
    for (const entry of ready) if (!best || order(entry) < order(best)) best = entry;
    if (best) build(best);
  }

  async function ensureLoaded(point: XZ): Promise<void> {
    const center = tileAt(point);
    const wanted = index.tiles.filter(t => ring(t, center) <= LOAD_RADIUS);
    pinned = new Set(wanted.map(keyOf));
    const waiting: Entry[] = [];
    for (const info of wanted) {
      let entry = entries.get(keyOf(info));
      if (entry?.status === 'failed') { drop(entry); entry = undefined; }
      if (!entry) {
        queue = queue.filter(t => t !== info);
        entry = start(info);
      }
      if (entry.status !== 'loaded') waiting.push(entry);
    }
    await Promise.all(waiting.map(entry => entry.fetched));
    for (const entry of waiting) build(entry);
  }

  // --- nearby data

  function around(center: TileKey): Entry[] {
    const found: Entry[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const entry = entries.get(keyOf({ tx: center.tx + dx, ty: center.ty + dy }));
        if (entry?.chunk) found.push(entry);
      }
    }
    return found;
  }

  function join(center: TileKey): Nearby {
    const chunks = around(center).map(e => e.chunk!);
    return {
      obstacles: chunks.flatMap(c => c.obstacles),
      segments: chunks.flatMap(c => c.segments),
      junctions: chunks.flatMap(c => c.junctions),
    };
  }

  function nearbyOf(point?: XZ): Nearby {
    if (point) return join(tileAt(point));
    if (!car) return { obstacles: [], segments: [], junctions: [] };
    return (nearby ??= join(car));
  }

  function roadGraphNear(): RoadGraph {
    if (!graph) {
      const { segments, junctions } = nearbyOf();
      graph = createRoadGraph(segments, junctions);
    }
    return graph;
  }

  function obstaclesNear(point?: XZ): Obstacle[] {
    return nearbyOf(point).obstacles;
  }

  function segmentsNear(point?: XZ): StreetSegment[] {
    return nearbyOf(point).segments;
  }

  return manager;
}
