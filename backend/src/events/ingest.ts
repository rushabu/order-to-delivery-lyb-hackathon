// ingestEvent: the one function through which every change to a shipment arrives, from HTTP or from
// the simulator (DESIGN.md 5.6). Storing the event, applying it, writing the ETA snapshot, alerts,
// notifications and audit rows all happen in one transaction. Stream hints are sent after commit.
import { audit } from '../audit';
import { stableUuid } from '../sim/ids';
import type { AuthUser } from '../auth/policy';
import { shipmentNow, type Ctx } from '../ctx';
import type { ShipmentStatusName } from '../eta/types';
import { ApiError, forbidden, notFound, validationFailed } from '../http/errors';
import type { EventRequest } from '../http/schemas';
import { coordinatorIds, customerUserIds } from '../notify/notifier';
import { MAX_OFF_ROUTE_KM, projectToKm } from '../shipments/geometry';
import { recomputeEta } from '../shipments/recompute';
import { getRoute, getShipment, type ShipmentRow } from '../shipments/repo';
import { canTransition, milestoneRole } from '../shipments/stateMachine';
import type { PendingHint } from '../stream/hub';
import { istClock } from '../time';
import { fillOutcomes } from '../decisions/outcome';
import { recordDelayCauses } from '../dashboard/causes';

export type ApplyStatus = 'APPLIED' | 'STORED_NOT_APPLIED' | 'DUPLICATE';

export interface IngestInput {
  shipment_id: string;
  event: EventRequest;
  source: 'HTTP' | 'SIMULATOR';
  actor: AuthUser | null; // null only for the simulator
  pendingHints?: PendingHint[]; // used by a caller that owns the outer transaction
}

export interface EventResult {
  event_id: string;
  apply_status: ApplyStatus;
  shipment_id: string;
  shipment_version: number;
  occurred_at: string;
  eta_snapshot_id: string | null;
}

/** Role rules for posting events (DESIGN.md 5.4). Throws 403. */
export function checkEventPermission(actor: AuthUser, s: Pick<ShipmentRow, 'driver_user_id'> | undefined, ev: EventRequest): void {
  if (actor.role === 'CUSTOMER') throw forbidden('Customers cannot post shipment events');
  if (actor.role === 'DRIVER') {
    // Drivers may post only to their own shipment. An unassigned or unknown id gets the same 403,
    // so the answer reveals nothing about other shipments.
    if (!s || s.driver_user_id !== actor.id) throw forbidden('This shipment is not assigned to you');
  }
  if (ev.type === 'POSITION' && actor.role !== 'DRIVER') throw forbidden('Only the assigned driver posts positions');
  if (ev.type === 'MILESTONE') {
    const role = milestoneRole(ev.payload.to_status);
    if (role !== actor.role) throw forbidden(`A ${actor.role.toLowerCase()} cannot set status ${ev.payload.to_status}`);
  }
}

export function ingestEvent(ctx: Ctx, input: IngestInput): { status: 200 | 201; body: EventResult } {
  const { db } = ctx;
  const ev = input.event;
  const now = shipmentNow(ctx, input.shipment_id);
  // In demo mode the server stamps every HTTP event, because a phone's clock is not the simulated clock.
  const occurredAt = input.source === 'HTTP' && ctx.config.demoMode ? now : (ev.occurred_at ?? now);
  const actorId = input.actor?.id ?? null;
  const hints: PendingHint[] = [];

  let outcome: { status: 200 | 201; body: EventResult };
  try {
    outcome = db.transaction(() => {
      // Idempotency: the same event_id returns the original result and changes nothing.
      const existing = db.prepare('SELECT shipment_id, result FROM shipment_events WHERE event_id = ?').get(ev.event_id) as
        | { shipment_id: string; result: string }
        | undefined;
      if (existing) {
        if (existing.shipment_id !== input.shipment_id) throw validationFailed('event_id was already used for another shipment');
        audit(db, now, actorId, 'EVENT_DUPLICATE', 'shipment_event', ev.event_id, { type: ev.type });
        return { status: 200 as const, body: { ...(JSON.parse(existing.result) as EventResult), apply_status: 'DUPLICATE' as const } };
      }

      const s = getShipment(db, input.shipment_id);
      if (input.actor) checkEventPermission(input.actor, s, ev);
      if (!s) throw notFound('Shipment not found');

      // Store first (append-only history), then apply; the row is completed with the result below.
      db.prepare(
        `INSERT INTO shipment_events (event_id, shipment_id, type, occurred_at, received_at, source, actor_user_id, payload,
           apply_status, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'STORED_NOT_APPLIED', '{}')`,
      ).run(ev.event_id, s.id, ev.type, occurredAt, now, input.source, actorId, JSON.stringify(ev.payload));

      const applied = applyEvent(ctx, s, ev, occurredAt, now, hints, input);
      const after = getShipment(db, s.id)!;
      const body: EventResult = {
        event_id: ev.event_id,
        apply_status: applied.status,
        shipment_id: s.id,
        shipment_version: after.version,
        occurred_at: occurredAt,
        eta_snapshot_id: applied.snapshotId ?? after.current_eta_snapshot_id,
      };
      db.prepare('UPDATE shipment_events SET apply_status = ?, result = ? WHERE event_id = ?').run(
        applied.status,
        JSON.stringify(body),
        ev.event_id,
      );
      audit(db, now, actorId, applied.status === 'DUPLICATE' ? 'EVENT_DUPLICATE' : 'EVENT_APPLIED', 'shipment_event', ev.event_id, {
        type: ev.type,
        shipment_id: s.id,
        apply_status: applied.status,
      });
      return { status: (applied.status === 'DUPLICATE' ? 200 : 201) as 200 | 201, body };
    })();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 409 || err.status === 403)) {
      // The event is not stored, but the rejection is recorded (DESIGN.md 5.6 and 9.4).
      const action = err.status === 409 ? 'EVENT_REJECTED' : 'ACCESS_DENIED';
      audit(db, now, actorId, action, 'shipment_event', ev.event_id, { type: ev.type, shipment_id: input.shipment_id, reason: err.code });
    }
    throw err;
  }
  if (input.pendingHints) input.pendingHints.push(...hints);
  else ctx.hub.publish(hints);
  return outcome;
}

interface Applied {
  status: ApplyStatus;
  snapshotId?: string | null;
}

function bump(ctx: Ctx, id: string, plan = false) {
  ctx.db.prepare(`UPDATE shipments SET version = version + 1${plan ? ', plan_version = plan_version + 1' : ''} WHERE id = ?`).run(id);
}

function applyEvent(ctx: Ctx, s: ShipmentRow, ev: EventRequest, at: string, now: string, hints: PendingHint[], input: IngestInput): Applied {
  const { db } = ctx;
  switch (ev.type) {
    case 'POSITION': {
      // Positions are applied only while in transit, and never move the marker backwards in time.
      if (s.status !== 'IN_TRANSIT') return { status: 'STORED_NOT_APPLIED' };
      if (s.last_position_at !== null && at < s.last_position_at) return { status: 'STORED_NOT_APPLIED' };
      const route = getRoute(db, s.active_route_id)!;
      let km: number | null = null;
      if (route.geometry) {
        const g = JSON.parse(route.geometry);
        const p = projectToKm(g.coordinates, route.total_km, [ev.payload.lng, ev.payload.lat], g.chainage_km);
        km = p.offKm <= MAX_OFF_ROUTE_KM ? p.km : null;
      }
      db.prepare('UPDATE shipments SET last_lat = ?, last_lng = ?, last_progress_km = ?, last_position_at = ? WHERE id = ?').run(
        ev.payload.lat, ev.payload.lng, km, at, s.id,
      );
      // Mark the stored row as applied before recalculating, so the ETA's trailing window includes it.
      db.prepare(`UPDATE shipment_events SET apply_status = 'APPLIED', route_id = ?, progress_km = ? WHERE event_id = ?`).run(
        route.id, km, ev.event_id,
      );
      const passedExit = km !== null && db.prepare(`SELECT 1 FROM route_alternatives
        WHERE route_id = ? AND exit_km >= ? AND exit_km < ? LIMIT 1`).get(route.id, s.last_progress_km ?? 0, km) !== undefined;
      bump(ctx, s.id, passedExit);
      return { status: 'APPLIED', snapshotId: recomputeEta(ctx, s.id, now, ev.event_id, 'EVENT', hints) };
    }
    case 'MILESTONE': {
      const to = ev.payload.to_status as ShipmentStatusName;
      if (to === s.status) return { status: 'DUPLICATE' };
      if (!canTransition(s.status, to)) {
        throw new ApiError(409, 'INVALID_TRANSITION', `Cannot move from ${s.status} to ${to}`, { from: s.status, to });
      }
      if (to === 'IN_TRANSIT') {
        // A driver is on one trip at a time: the next one cannot leave while another is on the road or unloading.
        const busy = input.actor?.role === 'DRIVER'
          ? (db.prepare(`SELECT id FROM shipments WHERE driver_user_id = ? AND id <> ? AND status IN ('IN_TRANSIT', 'ARRIVED') ORDER BY id LIMIT 1`)
              .get(input.actor.id, s.id) as { id: string } | undefined)
          : undefined;
        if (busy) throw new ApiError(409, 'TRIP_IN_PROGRESS', `Finish ${busy.id} before leaving on another trip`, { shipment_id: busy.id });
        // "Leave the plant" on a trip nobody dispatched: record the dispatch at the same moment, so the
        // milestone history still shows every stage.
        if (s.status === 'PLANNED') {
          const dispatch = { event_id: stableUuid(`auto-dispatch:${ev.event_id}`), apply_status: 'APPLIED', shipment_id: s.id, shipment_version: s.version, occurred_at: at, eta_snapshot_id: null };
          db.prepare(
            `INSERT INTO shipment_events (event_id, shipment_id, type, occurred_at, received_at, source, actor_user_id, payload, apply_status, result)
             VALUES (?, ?, 'MILESTONE', ?, ?, ?, ?, ?, 'APPLIED', ?)`,
          ).run(dispatch.event_id, s.id, at, now, input.source, input.actor?.id ?? null, JSON.stringify({ to_status: 'DISPATCHED', with_departure: true }), JSON.stringify(dispatch));
        }
      }
      const col = { IN_TRANSIT: 'departed_at', ARRIVED: 'arrived_at', DELIVERED: 'delivered_at' }[to as string];
      db.prepare(`UPDATE shipments SET status = ?${col ? `, ${col} = ?` : ''} WHERE id = ?`).run(...(col ? [to, at, s.id] : [to, s.id]));
      if (to === 'IN_TRANSIT' && input.actor?.role === 'DRIVER' && s.last_position_at === null) {
        const route = getRoute(db, s.active_route_id);
        const origin = route?.geometry ? JSON.parse(route.geometry).coordinates[0] : undefined;
        if (origin) db.prepare('UPDATE shipments SET last_lng = ?, last_lat = ?, last_progress_km = 0, last_position_at = ? WHERE id = ?')
          .run(origin[0], origin[1], at, s.id);
      }
      bump(ctx, s.id, to === 'IN_TRANSIT');
      const hint = (kinds: string[]) =>
        hints.push({
          hint: { entity: 'shipment', id: s.id, version: s.version + 1, kinds },
          audience: { kind: 'shipment', customer_id: s.customer_id, driver_user_id: s.driver_user_id },
        });
      if (to === 'ARRIVED' || to === 'CANCELLED') {
        resolveOpenAlert(ctx, s.id, now);
        if (to === 'ARRIVED' && !ctx.liveRouteDemo?.isLiveShipment(s.id)) {
          fillOutcomes(ctx, s.id, at);
          recordDelayCauses(db, s.id);
          hints.push({ hint: { entity: 'dashboard', id: 'dashboard', kinds: ['on_time', 'delay_causes', 'impact'] }, audience: { kind: 'coordinators' } });
        }
        hint(['status']);
        return { status: 'APPLIED', snapshotId: null };
      }
      if (to === 'DELIVERED') {
        for (const u of [...customerUserIds(db, s.customer_id), ...coordinatorIds(db)]) {
          ctx.notifier.send(
            db,
            now,
            { user_id: u, shipment_id: s.id, kind: 'DELIVERED', title: `${s.order_id} delivered`, body: `${s.order_id} delivered at ${istClock(at)}.` },
            hints,
          );
        }
        hint(['status']);
        return { status: 'APPLIED', snapshotId: null };
      }
      // The driver said they have left: the plant and the customer are told. (The replay's own departures stay quiet.)
      if (to === 'IN_TRANSIT' && input.actor?.role === 'DRIVER') {
        for (const u of [...customerUserIds(db, s.customer_id), ...coordinatorIds(db)]) {
          ctx.notifier.send(
            db,
            now,
            { user_id: u, shipment_id: s.id, kind: 'DEPARTED', title: `${s.order_id} has left the plant`, body: `${s.vehicle_reg} left at ${istClock(at)}.` },
            hints,
          );
        }
      }
      return { status: 'APPLIED', snapshotId: recomputeEta(ctx, s.id, now, ev.event_id, 'EVENT', hints) };
    }
    case 'DISRUPTION_REPORTED': {
      if (s.status === 'ARRIVED' || s.status === 'DELIVERED' || s.status === 'CANCELLED') return { status: 'STORED_NOT_APPLIED' };
      const exists = db.prepare('SELECT 1 FROM disruptions WHERE id = ?').get(ev.payload.disruption_id);
      if (exists) return { status: 'DUPLICATE' };
      const p = ev.payload;
      const fallback = ctx.fixtures.config.category_default_delay_min[p.category] ?? 30;
      const atKm = p.at_km ?? reportedAheadKm(ctx, s, p.category);
      db.prepare(
        `INSERT INTO disruptions (id, shipment_id, route_id, category, at_km, expected_delay_min, estimate_source, note, reported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        p.disruption_id, s.id, s.active_route_id, p.category, atKm, p.expected_delay_min ?? fallback,
        p.expected_delay_min ? 'DRIVER' : 'DEFAULT', p.note ?? null, at,
      );
      bump(ctx, s.id, true);
      return { status: 'APPLIED', snapshotId: recomputeEta(ctx, s.id, now, ev.event_id, 'EVENT', hints) };
    }
    case 'DISRUPTION_CLEARED': {
      const d = db.prepare('SELECT cleared_at FROM disruptions WHERE id = ? AND shipment_id = ?').get(ev.payload.disruption_id, s.id) as
        | { cleared_at: string | null }
        | undefined;
      if (!d) throw notFound('Disruption not found on this shipment');
      if (d.cleared_at !== null) return { status: 'DUPLICATE' };
      db.prepare('UPDATE disruptions SET cleared_at = ? WHERE id = ?').run(at, ev.payload.disruption_id);
      bump(ctx, s.id, true);
      return { status: 'APPLIED', snapshotId: recomputeEta(ctx, s.id, now, ev.event_id, 'EVENT', hints) };
    }
  }
}

function resolveOpenAlert(ctx: Ctx, shipmentId: string, now: string) {
  const a = ctx.db.prepare(`SELECT id, level FROM alerts WHERE shipment_id = ? AND status = 'OPEN'`).get(shipmentId) as
    | { id: string; level: string }
    | undefined;
  if (!a) return;
  ctx.db.prepare(`UPDATE alerts SET status = 'RESOLVED', resolved_at = ? WHERE id = ?`).run(now, a.id);
  audit(ctx.db, now, null, 'ALERT_RESOLVED', 'alert', a.id, { shipment_id: shipmentId, level: a.level, reason: 'shipment arrived' });
}

/** Road problems a driver reports from the cab are ahead of the truck. The three-tap report carries no
 * location, so an ACCIDENT, ROAD_CLOSURE or WEATHER report on a moving truck is placed a configured
 * distance ahead (config.disruptions.report_ahead_km, 15 km in the seed). Other categories stay at the truck. */
const ROAD_AHEAD_CATEGORIES = new Set(['ACCIDENT', 'ROAD_CLOSURE', 'WEATHER']);
function reportedAheadKm(ctx: Ctx, s: { status: string; active_route_id: string; last_progress_km: number | null }, category: string): number | null {
  if (s.status !== 'IN_TRANSIT' || s.last_progress_km === null || !ROAD_AHEAD_CATEGORIES.has(category)) return null;
  const route = getRoute(ctx.db, s.active_route_id);
  if (!route) return null;
  const ahead = ctx.fixtures.config.disruptions?.report_ahead_km ?? 15;
  return Math.min(Math.round((s.last_progress_km + ahead) * 1000) / 1000, route.total_km);
}
