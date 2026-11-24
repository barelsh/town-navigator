// Shortest route by distance over the road graph (TN-38): edge-based A*, or Dijkstra without the heuristic.
//
// The search state is the directed edge a car arrived on, not the node, so turn restrictions and the no-U-turn rule
// can depend on where the car came from. dist[e] is the cost to the END of edge e. The heuristic is the straight line
// from an edge's end to the goal: no road is shorter, so A* still returns the shortest route.

import { canMove, type RouteGraph } from './graph.ts';
import type { GoalEntry, GoalSnap, Seed, StartSnap } from './snap.ts';

export interface PathResult {
  distance: number;
  /** The edge the route starts on. */
  seed: Seed;
  /** Full edges after the seed edge's start, in order, starting with the seed edge; empty when start and goal share it. */
  edges: number[];
  /** The goal edge, driven `offset` meters from its from-node. */
  goal: GoalEntry;
  /** Edges settled, for comparing A* with Dijkstra. */
  settled: number;
}

/** Extra cost of moving from edge `from` to edge `to`. Distance only for now: kept so turn costs can be added later. */
export const turnCost = (_g: RouteGraph, _from: number, _to: number) => 0;

/** A binary min-heap of edge ids keyed by float costs, on typed arrays that grow by doubling. */
class EdgeHeap {
  private keys = new Float64Array(256);
  private values = new Int32Array(256);
  size = 0;

  push(value: number, key: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2), values = new Int32Array(this.size * 2);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.values[i] = value;
  }

  minKey(): number { return this.keys[0]; }

  /** Removes the smallest entry and returns its value. */
  pop(): number {
    const top = this.values[0];
    const key = this.keys[--this.size], value = this.values[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child];
      this.values[i] = this.values[child];
      i = child;
    }
    this.keys[i] = key;
    this.values[i] = value;
    return top;
  }
}

export function findPath(g: RouteGraph, start: StartSnap, goal: GoalSnap, { heuristic = true } = {}): PathResult | null {
  const edgeCount = g.edgeTo.length;
  const dist = new Float64Array(edgeCount).fill(Infinity);
  const prev = new Int32Array(edgeCount).fill(-1);
  const seedOf = new Int32Array(edgeCount).fill(-1); // which start seed each edge's best path began with
  const h = (e: number) => (heuristic ? Math.hypot(g.nodeX[g.edgeTo[e]] - goal.x, g.nodeY[g.edgeTo[e]] - goal.y) : 0);
  const heap = new EdgeHeap();

  let best = Infinity;
  let result: Omit<PathResult, 'settled'> | null = null;

  start.seeds.forEach((seed, i) => {
    // Start and goal on the same edge, the goal ahead: drive straight there.
    for (const entry of goal.entries) {
      if (entry.edge !== seed.edge) continue;
      const startAt = g.edgeLength[seed.edge] - (seed.cost - seed.penalty); // meters from the edge's from-node
      const cost = seed.penalty + entry.offset - startAt;
      if (entry.offset >= startAt && cost < best) { best = cost; result = { distance: cost, seed, edges: [], goal: entry }; }
    }
    if (seed.cost < dist[seed.edge]) {
      dist[seed.edge] = seed.cost;
      seedOf[seed.edge] = i;
      heap.push(seed.edge, seed.cost + h(seed.edge));
    }
  });

  let settled = 0;
  while (heap.size) {
    if (heap.minKey() >= best) break; // nothing left can beat the best arrival
    const key = heap.minKey();
    const e = heap.pop();
    if (key > dist[e] + h(e) + 1e-9) continue; // stale entry
    settled++;
    const node = g.edgeTo[e];
    for (const entry of goal.byNode.get(node) ?? []) {
      const cost = dist[e] + turnCost(g, e, entry.edge) + entry.offset;
      if (cost < best && canMove(g, e, entry.edge)) {
        best = cost;
        result = { distance: cost, seed: start.seeds[seedOf[e]], edges: unwind(prev, e), goal: entry };
      }
    }
    for (let k = g.outStart[node]; k < g.outStart[node + 1]; k++) {
      const next = g.outEdges[k];
      if (!canMove(g, e, next)) continue;
      const d = dist[e] + turnCost(g, e, next) + g.edgeLength[next];
      if (d < dist[next]) {
        dist[next] = d;
        prev[next] = e;
        seedOf[next] = seedOf[e];
        heap.push(next, d + h(next));
      }
    }
  }
  return result ? { ...(result as Omit<PathResult, 'settled'>), settled } : null;
}

function unwind(prev: Int32Array, last: number): number[] {
  const edges: number[] = [];
  for (let e = last; e >= 0; e = prev[e]) edges.push(e);
  return edges.reverse();
}
