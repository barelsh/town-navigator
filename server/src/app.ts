import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { townRoutes } from './routes/towns.ts';

const CLIENT_DIST = path.resolve(import.meta.dirname, '../../client/dist');

export async function buildApp() {
  const app = Fastify({ logger: true });

  await app.register(townRoutes, { prefix: '/api' });

  // Present after `npm run build`. In development Vite serves the client instead.
  if (existsSync(CLIENT_DIST)) {
    await app.register(fastifyStatic, { root: CLIENT_DIST });
  }

  return app;
}
