// Seed loader: replaces every row with the fictional fixtures (DESIGN.md 10.1 and 10.4).
import { audit } from '../audit';
import { hashPassword } from '../auth/password';
import { clearAll } from '../db/db';
import type { Ctx } from '../ctx';
import { pointAtKm, type LngLat } from '../shipments/geometry';
import { recomputeEta } from '../shipments/recompute';
import type { PendingHint } from '../stream/hub';
import { addMinutes, toIso } from '../time';
import type { Fixtures, GroundTruth, Waypoint } from './fixtures';
import { stableUuid } from './ids';

// scrypt is deliberately slow; hash each fixture password once per process so a reset stays fast.
const hashCache = new Map<string, string>();
function cachedHash(key: string, password: string): string {
  let h = hashCache.get(key);
  if (!h) {
    h = hashPassword(password);
    hashCache.set(key, h);
  }
  return h;
}

/** Ground-truth km at time t, linear between waypoints; the branch depends on the route being driven. */
export function groundTruthKm(gt: GroundTruth, routeId: string, t: string): number {
  const pts = waypointsFor(gt, routeId);
  if (t <= pts[0].at) return pts[0].km;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].at) {
      const a = pts[i - 1], b = pts[i];
      const f = (Date.parse(t) - Date.parse(a.at)) / (Date.parse(b.at) - Date.parse(a.at));
      return a.km + f * (b.km - a.km);
    }
  }
  return pts[pts.length - 1].km;
}

export function waypointsFor(gt: GroundTruth, routeId: string): Waypoint[] {
  return [...gt.common, ...(gt.branches[routeId] ?? [])];
}

function insertFixtureUser(db: Ctx['db'], u: Fixtures['users'][number]) {
  db.prepare(`INSERT INTO users (id, name, email, password_hash, role, customer_id, transporter_id, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(u.id, u.name, u.email.toLowerCase(), cachedHash(`${u.id}:${u.password}`, u.password), u.role,
      u.customer_id ?? null, u.transporter_id ?? null, u.phone ?? null);
}

/** Add missing catalog entries to an existing demo database without replacing accounts or orders. */
export function addDemoCatalog(ctx: Ctx): void {
  const { db, fixtures } = ctx;
  db.transaction(() => {
    const insert = db.prepare('INSERT INTO customers VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING');
    for (const c of fixtures.customers) insert.run(c.id, c.name, c.delivery_lat, c.delivery_lng);
    const exists = db.prepare('SELECT 1 FROM users WHERE id = ? OR email = ?');
    for (const u of fixtures.users) {
      if (u.role === 'CUSTOMER' && !exists.get(u.id, u.email.toLowerCase())) insertFixtureUser(db, u);
    }
    insertRoutes(ctx);
    const addAlternative = db.prepare('INSERT INTO route_alternatives VALUES (?, ?, ?) ON CONFLICT DO NOTHING');
    for (const a of fixtures.alternatives) addAlternative.run(a.route_id, a.alt_route_id, a.exit_km);
  })();
}

function insertRoutes({ db, fixtures }: Ctx): void {
  const insert = db.prepare(`INSERT INTO routes (id, name, origin, destination, total_km, geometry, max_gross_t, closed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
  const insertSegment = db.prepare('INSERT INTO route_segments VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of fixtures.routes) {
    const result = insert.run(r.id, r.name, r.origin, r.destination, r.total_km, r.geometry ? JSON.stringify(r.geometry) : null,
      r.restrictions.max_gross_t ?? null, r.restrictions.closed ? 1 : 0);
    if (result.changes) {
      for (const s of r.segments) insertSegment.run(r.id, s.seq, s.start_km, s.end_km, s.baseline_speed_kmph, s.dwell_after_min);
    }
  }
}

export function seedDatabase(ctx: Ctx, actorUserId: string | null): void {
  const { db } = ctx;
  const f: Fixtures = ctx.fixtures;
  const sc = f.scenario;
  const now = sc.clock_start;
  const hints: PendingHint[] = [];

  db.transaction(() => {
    clearAll(db);
    const ins = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);

    for (const c of f.customers) ins('INSERT INTO customers VALUES (?, ?, ?, ?)', c.id, c.name, c.delivery_lat, c.delivery_lng);
    for (const t of f.transporters) ins('INSERT INTO transporters VALUES (?, ?)', t.id, t.name);
    for (const u of f.users) insertFixtureUser(db, u);
    insertRoutes(ctx);
    for (const a of f.alternatives) ins('INSERT INTO route_alternatives VALUES (?, ?, ?)', a.route_id, a.alt_route_id, a.exit_km);
    for (const v of sc.standby_vehicles) ins('INSERT INTO standby_vehicles VALUES (?, ?, ?)', v.vehicle_reg, v.transporter_id, v.available ? 1 : 0);
    if (ctx.config.seedSampleOrders === false) return;

    // History: delivered shipments for the dashboard.
    for (const h of f.history) {
      ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)', h.order_id, h.customer_id, h.product, h.quantity_t, h.original_promised_by, h.original_promised_by);
      ins(
        `INSERT INTO shipments (id, order_id, transporter_id, driver_user_id, vehicle_reg, quantity_t, gross_t, status,
           planned_route_id, active_route_id, planned_departure, created_at, departed_at, arrived_at, delivered_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'DELIVERED', ?, ?, ?, ?, ?, ?, ?)`,
        h.shipment_id, h.order_id, h.transporter_id, h.vehicle_reg, h.quantity_t, h.gross_t, h.route_id, h.route_id,
        h.planned_departure, addMinutes(h.planned_departure, -24 * 60), h.planned_departure, h.actual_arrival,
        addMinutes(h.actual_arrival, 15),
      );
      for (const c of h.delay_causes) ins('INSERT INTO shipment_delay_causes VALUES (?, ?, ?)', h.shipment_id, c.cause, c.minutes);
    }

    // Live scenario.
    for (const o of sc.orders) {
      ins('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?)', o.id, o.customer_id, o.product, o.quantity_t, o.original_promised_by, o.agreed_delivery_by);
    }
    const posInterval = f.config.demo.position_interval_min;
    for (const s of sc.shipments) {
      const departed = s.milestones.find((m) => m.status === 'IN_TRANSIT')?.at ?? null;
      ins(
        `INSERT INTO shipments (id, order_id, transporter_id, driver_user_id, vehicle_reg, quantity_t, gross_t, status,
           planned_route_id, active_route_id, planned_departure, created_at, departed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        s.id, s.order_id, s.transporter_id, s.driver_user_id, s.vehicle_reg, s.quantity_t, s.gross_t, s.status,
        s.route_id, s.route_id, s.planned_departure, s.created_at, departed,
      );
      for (const m of s.milestones) seedEvent(ctx, s.id, 'MILESTONE', m.at, { to_status: m.status });
      for (const d of s.disruptions) {
        const est = d.expected_delay_min;
        ins(
          `INSERT INTO disruptions (id, shipment_id, route_id, category, at_km, expected_delay_min, estimate_source, note, reported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          d.id, s.id, s.route_id, d.category, d.at_km, est ?? f.config.category_default_delay_min[d.category] ?? 30,
          est ? 'DRIVER' : 'DEFAULT', d.note ?? null, d.reported_at,
        );
        seedEvent(ctx, s.id, 'DISRUPTION_REPORTED', d.reported_at, {
          disruption_id: d.id, category: d.category, ...(d.at_km !== null ? { at_km: d.at_km } : {}), ...(est ? { expected_delay_min: est } : {}),
        });
      }
      // Positions for the trailing window before the clock start, from the ground truth.
      const gt = sc.ground_truth[s.id];
      const route = f.routes.find((r) => r.id === s.route_id)!;
      if (gt && s.status === 'IN_TRANSIT' && route.geometry) {
        const startMs = Date.parse(now) - f.config.eta.pace_window_min * 60_000;
        for (let t = startMs; t <= Date.parse(now); t += posInterval * 60_000) {
          const at = toIso(t);
          const km = Math.round(groundTruthKm(gt, s.route_id, at) * 1000) / 1000;
          const [lng, lat] = pointAtKm(route.geometry.coordinates as LngLat[], route.total_km, km, route.geometry.chainage_km);
          seedEvent(ctx, s.id, 'POSITION', at, { lat, lng }, s.route_id, km);
          ins('UPDATE shipments SET last_lat = ?, last_lng = ?, last_progress_km = ?, last_position_at = ? WHERE id = ?', lat, lng, km, at, s.id);
        }
      }
    }
    // First snapshot for every live shipment at the clock start (may open alerts, e.g. SHP-1002).
    for (const s of sc.shipments) recomputeEta(ctx, s.id, now, null, 'EVENT', hints);
    audit(db, now, actorUserId, 'DEMO_RESET', 'demo', sc.scenario_id, { fixtures: f.dir.endsWith('fixtures-stub') ? 'stub' : 'fixtures' });
  })();
  hints.push({ hint: { entity: 'demo', id: sc.scenario_id, kinds: ['reset'] }, audience: { kind: 'all' } });
  ctx.hub.publish(hints);
}

function seedEvent(
  ctx: Ctx,
  shipmentId: string,
  type: string,
  at: string,
  payload: Record<string, unknown>,
  routeId: string | null = null,
  km: number | null = null,
) {
  const eventId = stableUuid(`seed:${shipmentId}:${type}:${at}`);
  const result = { event_id: eventId, apply_status: 'APPLIED', shipment_id: shipmentId, shipment_version: 1, occurred_at: at, eta_snapshot_id: null };
  ctx.db
    .prepare(
      `INSERT INTO shipment_events (event_id, shipment_id, type, occurred_at, received_at, source, actor_user_id, payload,
         apply_status, route_id, progress_km, result)
       VALUES (?, ?, ?, ?, ?, 'SEED', NULL, ?, 'APPLIED', ?, ?, ?)`,
    )
    .run(eventId, shipmentId, type, at, at, JSON.stringify(payload), routeId, km, JSON.stringify(result));
}
