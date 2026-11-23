import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiError } from '@town-navigator/shared';
import type { FastifyPluginAsync } from 'fastify';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const LOG_DIR = path.join(ROOT, 'logs');
const MAX_BYTES = 64 * 1024 * 1024; // a few minutes of per-frame rows is a few MB

/** Development only (app.ts doesn't register it in production): the client's debug log, saved as logs/debug-<time>.json. */
export const debugLogRoutes: FastifyPluginAsync = async (app) => {
  app.post('/debug-log', { bodyLimit: MAX_BYTES }, async (request, reply) => {
    if (typeof request.body !== 'object' || request.body === null) {
      const error: ApiError = { message: 'Expected a JSON object.' };
      return reply.code(400).send(error);
    }
    await mkdir(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(file, JSON.stringify(request.body));
    request.log.info({ file }, 'debug log saved');
    return { file: path.relative(ROOT, file) };
  });
};
