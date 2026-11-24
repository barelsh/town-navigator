// The road graph of each town, built on its first route request and kept in memory (TN-38). A request that finds
// the town file's mtime changed rebuilds it; concurrent first requests share one build.

import { stat } from 'node:fs/promises';
import type { FastifyBaseLogger } from 'fastify';
import { readTown, townFilePath } from '../services/townStore.ts';
import { buildGraph, type RouteGraph } from './graph.ts';

const cache = new Map<string, { mtimeMs: number; graph: Promise<RouteGraph | null> }>();

/** The town's graph, or null when the id is invalid or the town has no file. */
export async function graphFor(id: string, log?: FastifyBaseLogger): Promise<RouteGraph | null> {
  const file = townFilePath(id);
  if (!file) return null;
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { cache.delete(id); return null; }
    throw error;
  }
  const cached = cache.get(id);
  if (cached && cached.mtimeMs === mtimeMs) return cached.graph;

  const graph = (async () => {
    const town = await readTown(id);
    if (!town) return null;
    const started = performance.now();
    const built = buildGraph(town);
    const { nodes, edges, restrictions, viaWaySkipped } = built.stats;
    log?.info(`route graph ${id}: ${nodes} nodes, ${edges} edges, ${restrictions} restrictions (${viaWaySkipped} via-way skipped) in ${Math.round(performance.now() - started)} ms`);
    return built;
  })();
  cache.set(id, { mtimeMs, graph });
  graph.catch(() => cache.delete(id)); // a failed build is retried by the next request
  return graph;
}
