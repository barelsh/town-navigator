import { buildApp } from './app.ts';

const PORT = Number(process.env.PORT ?? 3000);

const app = await buildApp();
await app.listen({ port: PORT, host: '127.0.0.1' });
