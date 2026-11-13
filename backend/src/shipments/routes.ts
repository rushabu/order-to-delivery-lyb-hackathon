// Shipment and route read endpoints, and POST /shipments/:id/events (DESIGN.md 5.5).
// Every query goes through scopeFor(user); out-of-scope ids answer 404.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { alertToApi, type AlertRow } from '../alerts/alerts';
import type { AuthUser } from '../auth/policy';
import type { Ctx } from '../ctx';
import { checkEventPermission, ingestEvent } from '../events/ingest';
import { ApiError, notFound } from '../http/errors';
import { defineRoute, type RegisteredRoute } from '../http/route';
import {
  ErrorResponse,
  EtaSnapshot,
  EventRequest,
  EventResponse,
  RiskLevel,
  RoadConditionsResponse,
  RouteDetail,
  ShipmentDetail,
  ShipmentStatus,
  ShipmentSummary,
  StoredEvent,
} from '../http/schemas';
import {
  getAlternatives,
  getRoute,
  getShipment,
  getSnapshot,
  getVisibleShipment,
  listVisibleShipments,
  snapshotToApi,
  type ShipmentRow,
  type SnapshotRow,
} from './repo';
import { RoadConditions } from './roadConditions';
import { invoiceMeta } from '../invoices/routes';
import { extraOrders } from '../orders/plan';

const IdParams = z.object({ id: z.string().min(1).max(40) });
const ALL = ['COORDINATOR', 'DRIVER', 'CUSTOMER'] as const;

function names(ctx: Ctx, s: ShipmentRow) {
  const c = ctx.db.prepare('SELECT name FROM customers WHERE id = ?').get(s.customer_id) as { name: string };
  const t = ctx.db.prepare('SELECT name FROM transporters WHERE id = ?').get(s.transporter_id) as { name: string };
  const r = ctx.db.prepare('SELECT destination FROM routes WHERE id = ?').get(s.planned_route_id) as { destination: string } | undefined;
  return { customer_name: c.name, transporter_name: t.name, destination_name: r?.destination ?? '' };
}

/** The open alert as this user may see it: customers see it only at HIGH (DESIGN.md 5.4). */
function visibleOpenAlert(ctx: Ctx, user: AuthUser, shipmentId: string): AlertRow | undefined {
  const a = ctx.db.prepare(`SELECT * FROM alerts WHERE shipment_id = ? AND status = 'OPEN'`).get(shipmentId) as AlertRow | undefined;
  if (!a) return undefined;
  if (user.role === 'CUSTOMER' && a.level !== 'HIGH') return undefined;
  return a;
}

function lastPosition(s: ShipmentRow) {
  return s.last_position_at !== null && s.last_lat !== null && s.last_lng !== null
    ? { lat: s.last_lat, lng: s.last_lng, progress_km: s.last_progress_km, occurred_at: s.last_position_at }
    : null;
}

export function shipmentSummary(ctx: Ctx, user: AuthUser, s: ShipmentRow) {
  const snap = getSnapshot(ctx.db, s.current_eta_snapshot_id);
  const n = names(ctx, s);
  const alert = visibleOpenAlert(ctx, user, s.id);
  return {
    id: s.id,
    order_id: s.order_id,
    customer_id: s.customer_id,
    customer_name: n.customer_name,
    transporter_name: n.transporter_name,
    destination_name: n.destination_name,
    vehicle_reg: s.vehicle_reg,
    status: s.status,
    active_route_id: s.active_route_id,
    promised_by: s.agreed_delivery_by,
    original_promised_by: s.original_promised_by,
    arrived_at: s.arrived_at,
    last_position: lastPosition(s),
    current_eta: snap ? snapshotToApi(snap) : null,
    open_alert: alert ? alertToApi(alert) : null,
    open_alert_id: alert?.id ?? null,
    extra_order_ids: extraOrders(ctx.db, s.id).map((o) => o.id),
    version: s.version,
    ...(ctx.liveRouteDemo?.isLiveShipment(s.id) ? { live_demo: true } : {}),
  };
}

export function shipmentDetail(ctx: Ctx, user: AuthUser, s: ShipmentRow) {
  const { db } = ctx;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(s.order_id) as {
    id: string;
    customer_id: string;
    product: string;
    quantity_t: number;
    original_promised_by: string;
    agreed_delivery_by: string;
  };
  const n = names(ctx, s);
  const driver =
    user.role !== 'CUSTOMER' && s.driver_user_id
      ? (db.prepare('SELECT id, name, phone FROM users WHERE id = ?').get(s.driver_user_id) as { id: string; name: string; phone: string | null })
      : null; // customers never receive driver names or phone numbers (DESIGN.md 9.2)
  const milestones = [
    { status: 'PLANNED', at: s.created_at },
    ...(db
      .prepare(
        `SELECT json_extract(payload, '$.to_status') AS status, occurred_at AS at FROM shipment_events
         WHERE shipment_id = ? AND type = 'MILESTONE' AND apply_status = 'APPLIED' ORDER BY occurred_at`,
      )
      .all(s.id) as { status: string; at: string }[]),
  ];
  const snap = getSnapshot(db, s.current_eta_snapshot_id);
  const alert = visibleOpenAlert(ctx, user, s.id);
  const disruptions = db
    .prepare('SELECT * FROM disruptions WHERE shipment_id = ? AND cleared_at IS NULL ORDER BY reported_at, id')
    .all(s.id) as Record<string, unknown>[];
  return {
    id: s.id,
    status: s.status,
    version: s.version,
    order: { ...order, customer_name: n.customer_name },
    customer_name: n.customer_name,
    destination_name: n.destination_name,
    transporter: { id: s.transporter_id, name: n.transporter_name },
    transporter_id: s.transporter_id,
    transporter_name: n.transporter_name,
    vehicle_reg: s.vehicle_reg,
    driver,
    // Absent for customers: they never receive driver details (DESIGN.md 5.4).
    ...(driver ? { driver_name: driver.name } : {}),
    quantity_t: s.quantity_t,
    gross_t: s.gross_t,
    planned_route_id: s.planned_route_id,
    active_route_id: s.active_route_id,
    alternative_route_ids: getAlternatives(db, s.planned_route_id).map((a) => a.alt_route_id),
    planned_departure: s.planned_departure,
    milestones,
    last_position: lastPosition(s),
    current_eta: snap ? snapshotToApi(snap) : null,
    open_alert: alert ? alertToApi(alert) : null,
    active_disruptions: disruptions.map((d) => ({
      id: d.id,
      category: d.category,
      at_km: d.at_km,
      route_id: d.route_id,
      expected_delay_min: d.expected_delay_min,
      estimate_source: d.estimate_source,
      note: d.note,
      reported_at: d.reported_at,
      cleared_at: d.cleared_at,
    })),
    ...(ctx.liveRouteDemo?.isLiveShipment(s.id) ? { live_traffic: ctx.liveRouteDemo.traffic(s.active_route_id, s.last_progress_km) }
      : ctx.routeTraffic ? { live_traffic: ctx.routeTraffic.traffic(s) } : {}),
    ...(user.role !== 'DRIVER' ? { invoice: invoiceMeta(db, s.id) } : {}),
    // Orders added to this truck at dispatch; quantity_t above already includes them.
    extra_orders: extraOrders(db, s.id),
  };
}

export function registerShipmentRoutes(app: FastifyInstance, ctx: Ctx, reg: RegisteredRoute[]) {
  const { db } = ctx;
  const roadConditions = ctx.config.tomTomApiKey && new RoadConditions(ctx.config.tomTomApiKey);

  defineRoute<Record<string, never>, { status?: string; risk_level?: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments',
    roles: [...ALL],
    summary: 'Shipments visible to the caller, with current ETA summary, sorted by risk score (highest first)',
    query: z.object({ status: ShipmentStatus.optional(), risk_level: RiskLevel.optional() }),
    responses: { 200: z.array(ShipmentSummary) },
    handler: ({ user, query }) => {
      const rows = listVisibleShipments(db, user!, query.status ? 's.status = ?' : '1 = 1', query.status ? [query.status] : []);
      let list = rows.map((s) => shipmentSummary(ctx, user!, s));
      if (query.risk_level) list = list.filter((s) => s.current_eta?.risk_level === query.risk_level);
      list.sort((a, b) => (b.current_eta?.risk_score ?? -1) - (a.current_eta?.risk_score ?? -1) || a.id.localeCompare(b.id));
      return { status: 200, body: list };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id',
    roles: [...ALL],
    summary: 'Shipment detail: order, route, milestones, last position, current ETA snapshot, open alert, active disruptions',
    params: IdParams,
    responses: { 200: ShipmentDetail, 404: ErrorResponse },
    handler: ({ user, params }) => {
      const s = getVisibleShipment(db, user!, params.id);
      if (!s) throw notFound('Shipment not found');
      return { status: 200, body: shipmentDetail(ctx, user!, s) };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/traffic/refresh',
    roles: ['COORDINATOR'],
    summary: 'Ask TomTom again for drive time and traffic on the remaining route, then recalculate the ETA',
    params: IdParams,
    responses: { 200: ShipmentDetail, 404: ErrorResponse, 409: ErrorResponse, 502: ErrorResponse, 503: ErrorResponse },
    handler: async ({ user, params }) => {
      const s = getVisibleShipment(db, user!, params.id);
      if (!s) throw notFound('Shipment not found');
      if (ctx.liveRouteDemo?.isLiveShipment(s.id)) await ctx.liveRouteDemo.refresh(s.id);
      else if (ctx.routeTraffic) await ctx.routeTraffic.refresh(s.id);
      else throw new ApiError(503, 'LIVE_ROUTING_UNCONFIGURED', 'Set TOMTOM_API_KEY on the API server to use live traffic');
      return { status: 200, body: shipmentDetail(ctx, user!, getShipment(db, s.id)!) };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/road-conditions',
    roles: [...ALL],
    summary: 'TomTom traffic flow samples and reported incidents near the remaining route',
    params: IdParams,
    responses: { 200: RoadConditionsResponse, 404: ErrorResponse },
    handler: async ({ user, params }) => {
      const shipment = getVisibleShipment(db, user!, params.id);
      if (!roadConditions || !shipment || shipment.status !== 'IN_TRANSIT') {
        throw notFound('Road conditions are available for shipments in transit');
      }
      const route = getRoute(db, shipment.active_route_id);
      if (!route?.geometry) throw notFound('The active route has no geometry');
      const progress = Math.min(route.total_km, Math.max(0, shipment.last_progress_km ?? 0));
      return { status: 200, body: await roadConditions.forRoute({ id: route.id, totalKm: route.total_km, geometry: JSON.parse(route.geometry) }, progress) };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/events',
    roles: ['COORDINATOR', 'DRIVER'],
    summary: 'Event history, oldest first',
    params: IdParams,
    responses: { 200: z.array(StoredEvent), 404: ErrorResponse },
    handler: ({ user, params }) => {
      const s = getVisibleShipment(db, user!, params.id);
      if (!s) throw notFound('Shipment not found');
      const rows = db
        .prepare(
          `SELECT event_id, shipment_id, type, occurred_at, received_at, source, actor_user_id, payload, apply_status
           FROM shipment_events WHERE shipment_id = ? ORDER BY occurred_at, received_at`,
        )
        .all(s.id) as (Record<string, unknown> & { payload: string })[];
      return { status: 200, body: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) };
    },
  });

  defineRoute<{ id: string }, Record<string, never>, EventRequest>(app, ctx, reg, {
    method: 'POST',
    url: '/shipments/:id/events',
    roles: ['COORDINATOR', 'DRIVER'],
    summary: 'Submit a shipment event (position, milestone, disruption). Idempotent on event_id',
    params: IdParams,
    body: EventRequest,
    responses: { 200: EventResponse, 201: EventResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 422: ErrorResponse },
    handler: ({ user, params, body }) => {
      // Drivers: 403 for any shipment not assigned to them. Coordinators: 404 if it does not exist.
      if (user!.role === 'DRIVER') checkEventPermission(user!, getShipment(db, params.id), body);
      const r = ingestEvent(ctx, { shipment_id: params.id, event: body, source: 'HTTP', actor: user });
      return { status: r.status, body: r.body };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/shipments/:id/eta-history',
    roles: [...ALL],
    summary: 'ETA snapshots, newest first',
    params: IdParams,
    responses: { 200: z.array(EtaSnapshot), 404: ErrorResponse },
    handler: ({ user, params }) => {
      const s = getVisibleShipment(db, user!, params.id);
      if (!s) throw notFound('Shipment not found');
      const rows = db.prepare('SELECT * FROM eta_snapshots WHERE shipment_id = ? ORDER BY seq DESC').all(s.id) as SnapshotRow[];
      return { status: 200, body: rows.map(snapshotToApi) };
    },
  });

  defineRoute<{ id: string }>(app, ctx, reg, {
    method: 'GET',
    url: '/routes/:id',
    roles: [...ALL],
    summary: 'Route geometry and segments (only routes of shipments the caller can see, and their alternatives)',
    params: IdParams,
    responses: { 200: RouteDetail, 404: ErrorResponse },
    handler: ({ user, params }) => {
      const visible = new Set<string>();
      for (const s of listVisibleShipments(db, user!)) {
        visible.add(s.planned_route_id);
        visible.add(s.active_route_id);
        for (const a of getAlternatives(db, s.planned_route_id)) visible.add(a.alt_route_id);
      }
      const r = getRoute(db, params.id);
      if (!r || (user!.role !== 'COORDINATOR' && !visible.has(r.id))) throw notFound('Route not found');
      return {
        status: 200,
        body: {
          id: r.id,
          name: r.name,
          origin: r.origin,
          destination: r.destination,
          total_km: r.total_km,
          geometry: r.geometry ? JSON.parse(r.geometry) : null,
          restrictions: { max_gross_t: r.max_gross_t, closed: r.closed === 1 },
          segments: r.eta.segments,
          alternatives: getAlternatives(db, r.id),
        },
      };
    },
  });
}
