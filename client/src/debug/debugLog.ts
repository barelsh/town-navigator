// A flight recorder for chasing frame-rate and flicker problems. It keeps the last stretch of driving in memory:
// one row of numbers per frame and a list of events, and saves them on request (the L key in main.ts) to
// logs/ through the dev server, or as a download if the server doesn't answer.
//
// Recording a frame writes into preallocated typed arrays, so the recorder allocates nothing per frame and doesn't
// disturb the frame rate it is there to measure. Development only: main.ts creates it only when import.meta.env.DEV.

/** The columns of a frame row, in order. All numbers; see main.ts for how each is measured. */
export const FRAME_FIELDS = [
  // time
  't', 'interval', 'dt',
  // milliseconds spent in each stage of the frame, and in all of it
  'msTiles', 'msCar', 'msCamera', 'msHud', 'msRender', 'msTotal',
  // the car, and the W S A D keys held (bits 1 2 4 8)
  'x', 'z', 'heading', 'speed', 'keys',
  // the road lock
  'lockActive', 'lockMode', 'hold', 'candHeading', 'candFlow',
  'zoneX', 'zoneZ', 'zoneR', 'lastZoneR',
  'trackAx', 'trackAz', 'trackBx', 'trackBz', 'trackT', 'trackDir',
  'lockHeading', 'lateral', 'offLen', 'ease',
  // the camera
  'camX', 'camY', 'camZ', 'camToCar',
  // the renderer and the JS heap
  'calls', 'triangles', 'geometries', 'textures', 'heapMB', 'overlay',
] as const;

export type FrameField = (typeof FRAME_FIELDS)[number];
export type FrameSample = Record<FrameField, number>;

export interface DebugLog {
  /** Fill this in, then call `commit()`. One object, reused every frame. */
  readonly sample: FrameSample;
  /** Stores the sample as the next frame row, overwriting the oldest once the buffer is full. */
  commit(): void;
  /** Records something that happened, with a little data. Rare things only: this allocates. */
  event(kind: string, data?: Record<string, unknown>): void;
  /** Writes the log to logs/ through the dev server. Resolves to the file, or 'download' if it fell back to that. */
  save(meta?: Record<string, unknown>): Promise<string>;
}

const KEY_BITS: Record<string, number> = {
  KeyW: 1, ArrowUp: 1, KeyS: 2, ArrowDown: 2, KeyA: 4, ArrowLeft: 4, KeyD: 8, ArrowRight: 8,
};
const SLOW_FRAME_MS = 50;       // a frame this long, or a gap this long between frames, is logged as an event
const SLOW_EVENT_GAP_MS = 250;  // at most one such event per this long

export function createDebugLog({ frames = 12000, events = 4000 } = {}): DebugLog { // 100 s at 120 frames a second
  const width = FRAME_FIELDS.length;
  const rows = new Float64Array(frames * width);
  const sample = Object.fromEntries(FRAME_FIELDS.map(field => [field, 0])) as FrameSample;
  const eventRing: Record<string, unknown>[] = [];
  const started = performance.now();
  let frameCount = 0, eventCount = 0, held = 0, lastSlow = -Infinity;

  function event(kind: string, data: Record<string, unknown> = {}): void {
    eventRing[eventCount++ % events] = { t: +(performance.now() - started).toFixed(1), frame: frameCount, kind, ...data };
  }

  // Everything the page does that could matter, whichever code did it.
  addEventListener('keydown', e => {
    held |= KEY_BITS[e.code] ?? 0;
    if (!e.repeat) event('key', { code: e.code, down: true });
  });
  addEventListener('keyup', e => {
    held &= ~(KEY_BITS[e.code] ?? 0);
    event('key', { code: e.code, down: false });
  });
  addEventListener('blur', () => { held = 0; event('window', { focus: false }); });
  addEventListener('focus', () => event('window', { focus: true }));
  document.addEventListener('visibilitychange', () => event('visibility', { hidden: document.hidden }));
  addEventListener('resize', () => event('resize', { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }));
  addEventListener('error', e => event('error', { message: e.message, source: e.filename, line: e.lineno }));
  addEventListener('unhandledrejection', e => event('rejection', { reason: String(e.reason) }));

  function ordered<T>(ring: T[], count: number, capacity: number): T[] {
    return count <= capacity ? ring.slice(0, count) : [...ring.slice(count % capacity), ...ring.slice(0, count % capacity)];
  }

  return {
    sample,

    commit() {
      sample.keys = held;
      const base = (frameCount % frames) * width;
      for (let i = 0; i < width; i++) rows[base + i] = sample[FRAME_FIELDS[i]];
      frameCount++;
      if ((sample.interval > SLOW_FRAME_MS || sample.msTotal > SLOW_FRAME_MS) && sample.t - lastSlow > SLOW_EVENT_GAP_MS) {
        lastSlow = sample.t;
        event('slowFrame', { interval: +sample.interval.toFixed(1), msTotal: +sample.msTotal.toFixed(1), msRender: +sample.msRender.toFixed(1) });
      }
    },

    event,

    async save(meta = {}) {
      const kept = Math.min(frameCount, frames);
      const first = frameCount > frames ? frameCount % frames : 0;
      const data: number[][] = [];
      for (let n = 0; n < kept; n++) {
        const base = ((first + n) % frames) * width;
        const row: number[] = new Array(width);
        for (let i = 0; i < width; i++) {
          const value = rows[base + i];
          row[i] = Number.isFinite(value) ? Math.round(value * 1000) / 1000 : (null as unknown as number); // JSON has no NaN
        }
        data.push(row);
      }
      const payload = {
        savedAt: new Date().toISOString(),
        recordedSeconds: +((performance.now() - started) / 1000).toFixed(1),
        meta: { userAgent: navigator.userAgent, dpr: devicePixelRatio, w: innerWidth, h: innerHeight, ...meta },
        fields: FRAME_FIELDS,
        firstFrame: frameCount - kept,
        frames: data,
        events: ordered(eventRing, eventCount, events),
      };
      const body = JSON.stringify(payload);
      try {
        const response = await fetch('/api/debug-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return ((await response.json()) as { file: string }).file;
      } catch {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
        link.download = `town-navigator-debug-${payload.savedAt.replace(/[:.]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        return 'download';
      }
    },
  };
}
