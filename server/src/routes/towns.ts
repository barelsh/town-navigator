import type { ApiError } from '@town-navigator/shared';
import type { FastifyPluginAsync } from 'fastify';
import { readTown } from '../services/townStore.ts';

export const townRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>('/towns/:id', async (request, reply) => {
    const { id } = request.params;
    const town = await readTown(id);
    if (town) return town;

    const error: ApiError = {
      message: `Town "${id}" not found. Generate it with: npm run normalize -- <raw file>`,
    };
    return reply.code(404).send(error);
  });
};
