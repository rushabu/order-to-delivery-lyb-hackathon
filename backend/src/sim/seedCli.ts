// npm run seed: rewrite DATABASE_FILE from the fixtures, then exit.
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { seedDatabase } from './seed';

const config = loadConfig();
const { ctx, sim, close } = await buildApp({ config, autoTick: false });
if (sim) sim.reset(null);
else seedDatabase(ctx, null);
console.log(`Seeded ${config.databaseFile} from ${ctx.fixtures.dir}`);
await close();
