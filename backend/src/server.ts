// Entry point: npm start / npm run dev. Exactly one instance may run (SQLite file + in-memory stream hub).
import { buildApp } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const { app, close } = await buildApp({ config, logger: true });
await app.listen({ port: config.port, host: process.env.HOST ?? '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    close().finally(() => process.exit(0));
  });
}
