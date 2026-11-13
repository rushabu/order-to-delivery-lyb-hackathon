import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const backend = join(root, 'backend');
const frontend = join(root, 'frontend');
const vite = join(frontend, 'node_modules/vite/bin/vite.js');
const servers = new Set();
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const server of servers) server.kill();
  if (servers.size) setTimeout(() => {
    for (const server of servers) server.kill('SIGKILL');
  }, 2000).unref();
}

function verifyDependencies() {
  try {
    const require = createRequire(join(backend, 'package.json'));
    require.resolve('tsx');
    const Sqlite = require('better-sqlite3');
    const db = new Sqlite(':memory:');
    db.close();
    if (!existsSync(vite)) throw new Error('Vite is missing');
  } catch {
    throw new Error('Dependencies are missing or SQLite could not load. Run npm run setup from the repository root.');
  }
}

function setup() {
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Run npm run setup from the repository root.');
  for (const [cwd, flags] of [[backend, process.platform === 'win32' && process.arch === 'x64' ? ['--ignore-scripts'] : []], [frontend, []]]) {
    const result = spawnSync(process.execPath, [npm, 'ci', ...flags], { cwd, stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(`Dependency install failed in ${cwd}.`);
  }
  verifyDependencies();
  console.log('Setup complete. Run npm run dev to start both services.');
}

function port(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error(`${label} must be a valid TCP port.`);
  return number;
}

function start(label, cwd, args, env) {
  const server = spawn(process.execPath, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  servers.add(server);
  server.once('error', (error) => {
    servers.delete(server);
    console.error(`${label} could not start. ${error.message}`);
    stop(1);
  });
  server.once('exit', (code) => {
    servers.delete(server);
    if (!stopping) {
      console.error(`${label} stopped (${code ?? 'signal'}). Check the output above.`);
      stop(1);
    }
  });
}

async function ready(url, label) {
  const deadline = Date.now() + 20_000;
  while (!stopping && Date.now() < deadline) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch { /* The server is still starting. */ }
    await delay(250);
  }
  if (stopping) return false;
  throw new Error(`${label} did not respond at ${url}. Check whether the port is already in use.`);
}

async function dev() {
  verifyDependencies();
  const envFile = join(backend, '.env');
  const backendEnv = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
  const apiPort = port(backendEnv.PORT ?? 4000, 'PORT');
  const webPort = port(process.env.WEB_PORT ?? 5173, 'WEB_PORT');
  if (apiPort === webPort) throw new Error('PORT and WEB_PORT must be different.');
  const api = `http://127.0.0.1:${apiPort}`;
  const web = `http://127.0.0.1:${webPort}`;
  const demoMode = backendEnv.DEMO_MODE ?? 'true';
  const origins = new Set([web, `http://localhost:${webPort}`, ...(backendEnv.CORS_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean)]);
  process.once('SIGINT', () => stop(0));
  process.once('SIGTERM', () => stop(0));
  start('API', backend, ['--use-system-ca', '--import', 'tsx', 'src/server.ts'], {
    ...backendEnv, HOST: '127.0.0.1', PORT: String(apiPort), DEMO_MODE: demoMode,
    DATABASE_FILE: backendEnv.DATABASE_FILE || ':memory:',
    JWT_SECRET: backendEnv.JWT_SECRET || randomBytes(32).toString('hex'),
    CORS_ORIGINS: [...origins].join(','),
  });
  if (!await ready(`${api}/health`, 'API')) return;
  start('Web', frontend, [vite, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
    ...process.env, VITE_API_URL: api, VITE_USE_MOCKS: 'false', VITE_DEMO_MODE: demoMode,
  });
  if (!await ready(web, 'Web')) return;
  console.log(`\nOpen ${web} · API health ${api}/health · Ctrl+C stops both.\n`);
}

try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Install Node.js 24 or later first.');
  if (process.argv.includes('--setup')) setup();
  else await dev();
} catch (error) {
  console.error(error.message);
  stop(1);
}
