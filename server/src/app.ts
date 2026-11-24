import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { debugLogRoutes } from './routes/debugLog.ts';
import { routeRoutes } from './routes/route.ts';
import { townRoutes } from './routes/towns.ts';

const CLIENT_DIST = path.resolve(import.meta.dirname, '../../client/dist');

export async function buildApp({ logger = true }: { logger?: boolean } = {}) {
  const app = Fastify({ logger });

  await app.register(townRoutes, { prefix: '/api' });
  await app.register(routeRoutes, { prefix: '/api' });
  if (process.env.NODE_ENV !== 'production') await app.register(debugLogRoutes, { prefix: '/api' });

  // Present after `npm run build`. In development Vite serves the client instead.
  if (existsSync(CLIENT_DIST)) {
    await app.register(fastifyStatic, { root: CLIENT_DIST });
  }

  return app;
}
