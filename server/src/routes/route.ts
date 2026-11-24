import type { ApiError, Route, RouteRequest } from '@town-navigator/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { graphFor } from '../routing/routeCache.ts';
import { planRoute } from '../routing/plan.ts';

const BAD_BODY = 'Send from: { x, y, bearing } and to: { x, y } in meters.';

const point = (keys: string[]) => ({
  type: 'object',
  required: keys,
  properties: Object.fromEntries(keys.map(k => [k, { type: 'number' }])),
});

const bodySchema = {
  type: 'object',
  required: ['from', 'to'],
  properties: { from: point(['x', 'y', 'bearing']), to: point(['x', 'y']) },
};

function fail(reply: FastifyReply, code: number, message: string) {
  const error: ApiError = { message };
  return reply.code(code).header('cache-control', 'no-store').send(error);
}

const finite = ({ from, to }: RouteRequest) => [from.x, from.y, from.bearing, to.x, to.y].every(Number.isFinite);

export const routeRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string }; Body: RouteRequest }>(
    '/towns/:id/route',
    { schema: { body: bodySchema }, attachValidation: true },
    async (request, reply) => {
      if (request.validationError || !finite(request.body)) return fail(reply, 400, BAD_BODY);
      const { id } = request.params;
      const graph = await graphFor(id, request.log);
      if (!graph) return fail(reply, 404, `Town "${id}" not found. Generate it with: npm run normalize -- <raw file>`);

      const result = planRoute(graph, request.body);
      if ('error' in result) return fail(reply, 422, result.error);
      const route: Route = result.route;
      return reply.header('cache-control', 'no-store').send(route);
    },
  );
};
