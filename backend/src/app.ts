// Builds the Fastify app with all routes. One process, one SQLite file (DESIGN.md 4).
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config';
import type { Ctx } from './ctx';
import { openDb } from './db/db';
import { ApiError, errorBody } from './http/errors';
import { buildOpenApi } from './http/openapi';
import { API_PREFIX, defineRoute, type RegisteredRoute } from './http/route';
import { Health } from './http/schemas';
import { InAppNotifier } from './notify/notifier';
import { RealClock, SimulatedClock } from './sim/clock';
import { loadFixtures } from './sim/fixtures';
import { addDemoCatalog, seedDatabase } from './sim/seed';
import { Simulator } from './sim/simulator';
import { StreamHub } from './stream/hub';
import { registerAuthRoutes } from './auth/routes';
import { registerShipmentRoutes } from './shipments/routes';
import { registerAlertRoutes } from './alerts/routes';
import { registerDecisionRoutes } from './decisions/routes';
import { registerDashboardRoutes } from './dashboard/routes';
import { registerNotificationRoutes } from './notify/routes';
import { registerStreamRoutes } from './stream/routes';
import { registerDemoRoutes } from './sim/routes';
import { staleTick } from './shipments/staleTick';
import { DEFAULT_WEATHER_CONFIG, RouteWeather } from './weather/weather';
import { registerWeatherRoutes } from './weather/routes';
import { registerDriverOpsRoutes } from './driverOps/routes';
import { recomputeEta } from './shipments/recompute';
import type { PendingHint } from './stream/hub';
import { LiveRouteDemo } from './liveRouting/demo';
import { registerLiveRouteDemo } from './liveRouting/routes';
import { RouteTraffic, TRAFFIC_REFRESH_MS } from './shipments/routeTraffic';
import { registerAssistantRoutes } from './assistant/routes';
import { registerInvoiceRoutes } from './invoices/routes';
import { registerOrderRoutes } from './orders/routes';

export interface BuildOptions {
  config: AppConfig;
  fixturesDir?: string;
  /** Drive the simulator from a real-time timer. Tests set false and call sim.advanceTo directly. */
  autoTick?: boolean;
  logger?: boolean;
}

export interface Built {
  app: FastifyInstance;
  ctx: Ctx;
  sim: Simulator | null;
  clock: SimulatedClock | null;
  close: () => Promise<void>;
}

export async function buildApp(opts: BuildOptions): Promise<Built> {
  const { config } = opts;
  const fixtures = loadFixtures(opts.fixturesDir);
  const db = openDb(config.databaseFile);
  const simClock = config.demoMode && config.seedSampleOrders !== false ? new SimulatedClock(fixtures.scenario.clock_start) : null;
  const ctx: Ctx = {
    config,
    db,
    clock: simClock ?? new RealClock(),
    fixtures,
    hub: new StreamHub(),
    notifier: new InAppNotifier(),
    counterfactual: null,
    weather: new RouteWeather(
      () => (db.prepare(`SELECT id, name, total_km, geometry FROM routes
        WHERE id NOT LIKE 'LIVE-%' OR id IN (SELECT active_route_id FROM shipments WHERE status = 'IN_TRANSIT')`)
        .all() as { id: string; name: string; total_km: number; geometry: string | null }[])
        .map((r) => ({ ...r, geometry: r.geometry ? JSON.parse(r.geometry) : null })),
      fixtures.config.weather ?? DEFAULT_WEATHER_CONFIG,
    ),
  };
  const sim = simClock ? new Simulator(ctx, simClock, opts.autoTick ?? true) : null;
  if (config.demoMode) ctx.liveRouteDemo = new LiveRouteDemo(ctx, opts.autoTick ?? true);
  if (config.tomTomApiKey) ctx.routeTraffic = new RouteTraffic(ctx, config.tomTomApiKey, opts.autoTick ?? true);
  ctx.counterfactual = sim;

  // Demo mode always starts from the seed; otherwise seed only an empty database.
  if (sim) sim.reset(null);
  else if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) seedDatabase(ctx, null);
  else if (config.demoMode) addDemoCatalog(ctx);

  // 8 MB body limit: a 5 MB delivery photo or invoice arrives base64-encoded (about a third larger).
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 8 * 1024 * 1024 });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(errorBody(err.code, err.message, err.details));
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      // Malformed JSON and similar client errors.
      return reply.status(422).send(errorBody('VALIDATION_FAILED', e.message ?? 'Invalid request'));
    }
    req.log.error(err);
    return reply.status(500).send(errorBody('INTERNAL_ERROR', 'Something went wrong. The change was not applied; retry.'));
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send(errorBody('NOT_FOUND', 'Not found')));

  const reg: RegisteredRoute[] = [];
  defineRoute(app, ctx, reg, {
    method: 'GET',
    url: '/health',
    roles: 'PUBLIC',
    summary: 'Liveness',
    responses: { 200: Health },
    handler: () => ({ status: 200, body: { status: 'ok' as const, demo_mode: config.demoMode, now: ctx.clock.nowIso() } }),
  });
  registerAuthRoutes(app, ctx, reg);
  registerShipmentRoutes(app, ctx, reg);
  registerAlertRoutes(app, ctx, reg);
  registerDecisionRoutes(app, ctx, reg);
  registerDashboardRoutes(app, ctx, reg);
  registerNotificationRoutes(app, ctx, reg);
  registerStreamRoutes(app, ctx, reg);
  registerWeatherRoutes(app, ctx, reg);
  registerDriverOpsRoutes(app, ctx, reg);
  registerAssistantRoutes(app, ctx, reg);
  registerInvoiceRoutes(app, ctx, reg);
  registerOrderRoutes(app, ctx, reg);
  if (sim && simClock) registerDemoRoutes(app, ctx, reg, sim, simClock);
  else if (config.demoMode) registerDemoRoutes(app, ctx, reg);
  if (ctx.liveRouteDemo) registerLiveRouteDemo(app, ctx, reg, ctx.liveRouteDemo);

  const openapi = buildOpenApi(reg);
  app.get('/openapi.json', async () => openapi);
  app.get(`${API_PREFIX}/openapi.json`, async () => openapi);
  app.get('/health', async () => Health.parse({ status: 'ok', demo_mode: config.demoMode, now: ctx.clock.nowIso() }));

  // Real clock: the stale-position check runs every 5 minutes. (In demo mode the simulator runs it.)
  const timers: NodeJS.Timeout[] = [setInterval(() => ctx.hub.keepAlive(), 15_000)];
  if (!sim) timers.push(setInterval(() => staleTick(ctx), fixtures.config.demo.stale_tick_min * 60_000));
  // TomTom: re-quote every active shipment on a timer (new and rerouted ones are also quoted on demand).
  const traffic = ctx.routeTraffic;
  if (traffic && opts.autoTick !== false) {
    void traffic.refreshAll();
    timers.push(setInterval(() => void traffic.refreshAll(), TRAFFIC_REFRESH_MS));
  }
  // Live mode: refresh the forecast on a timer and re-run the ETA of every truck on the road.
  if (!sim && opts.autoTick !== false) {
    const liveWeather = async () => {
      await ctx.weather.refresh(true);
      const hints: PendingHint[] = [];
      const now = ctx.clock.nowIso();
      const moving = db.prepare(`SELECT id FROM shipments WHERE status = 'IN_TRANSIT'`).all() as { id: string }[];
      db.transaction(() => moving.forEach((s) => recomputeEta(ctx, s.id, now, null, 'EVENT', hints)))();
      ctx.hub.publish(hints);
    };
    void liveWeather();
    timers.push(setInterval(() => void liveWeather(), ctx.weather.cfg.refresh_min * 60_000));
  }

  return {
    app,
    ctx,
    sim,
    clock: simClock,
    close: async () => {
      timers.forEach(clearInterval);
      sim?.shutdown();
      ctx.liveRouteDemo?.reset();
      traffic?.close();
      await app.close();
      db.close();
    },
  };
}
