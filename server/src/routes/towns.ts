import type { ApiError } from '@town-navigator/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { readTileFile, readTileIndexFile, readTown } from '../services/townStore.ts';

const CACHE = 'public, max-age=300'; // tiles only change when npm run tile runs again

function notFound(reply: FastifyReply, message: string) {
  const error: ApiError = { message };
  return reply.code(404).header('cache-control', 'no-store').send(error);
}

export const townRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/towns/:id', async (request, reply) => {
    const { id } = request.params;
    const town = await readTown(id);
    if (town) return town;

    return notFound(reply, `Town "${id}" not found. Generate it with: npm run normalize -- <raw file>`);
  });

  app.get<{ Params: { id: string } }>('/towns/:id/index', async (request, reply) => {
    const { id } = request.params;
    const index = await readTileIndexFile(id);
    if (index) return reply.header('cache-control', CACHE).type('application/json').send(index);

    return notFound(reply, `Town "${id}" has no tile index. Generate it with: npm run tile -- ${id}`);
  });

  app.get<{ Params: { id: string; tx: string; ty: string } }>(
    '/towns/:id/tiles/:tx/:ty',
    async (request, reply) => {
      const { id, tx, ty } = request.params;
      const tile = await readTileFile(id, tx, ty);
      if (tile) return reply.header('cache-control', CACHE).type('application/json').send(tile);

      return notFound(reply, `Town "${id}" has no tile ${tx}, ${ty}.`);
    },
  );
};
