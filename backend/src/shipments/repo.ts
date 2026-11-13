// Reading shipments, routes and the ETA engine's input state from the database.
import { scopeFor, type AuthUser } from '../auth/policy';
import type { Db } from '../db/db';
import type { EtaConfig, EtaDisruption, EtaRoute, EtaState, Factor, ShipmentStatusName } from '../eta/types';
import { addMinutes } from '../time';

export interface ShipmentRow {
  id: string;
  order_id: string;
  transporter_id: string;
  driver_user_id: string | null;
  vehicle_reg: string;
  quantity_t: number;
  gross_t: number;
  status: ShipmentStatusName;
  planned_route_id: string;
  active_route_id: string;
  diverted_from_route_id: string | null;
  diverted_at_km: number | null;
  planned_departure: string;
  created_at: string;
  departed_at: string | null;
  arrived_at: string | null;
  delivered_at: string | null;
  last_lat: number | null;
  last_lng: number | null;
  last_progress_km: number | null;
  last_position_at: string | null;
  current_eta_snapshot_id: string | null;
  version: number;
  plan_version: number;
  // from orders
  customer_id: string;
  original_promised_by: string;
  agreed_delivery_by: string;
}

const SHIPMENT_SELECT = `
  SELECT s.*, o.customer_id, o.original_promised_by, o.agreed_delivery_by
  FROM shipments s JOIN orders o ON o.id = s.order_id`;

export function getShipment(db: Db, id: string): ShipmentRow | undefined {
  return db.prepare(`${SHIPMENT_SELECT} WHERE s.id = ?`).get(id) as ShipmentRow | undefined;
}

/** The shipment if the user may see it (scopeFor), else undefined. Callers answer 404. */
export function getVisibleShipment(db: Db, user: AuthUser, id: string): ShipmentRow | undefined {
  const sc = scopeFor(user);
  return db.prepare(`${SHIPMENT_SELECT} WHERE s.id = ? AND ${sc.where}`).get(id, ...sc.params) as ShipmentRow | undefined;
}

export function listVisibleShipments(db: Db, user: AuthUser, extraWhere = '1 = 1', extraParams: unknown[] = []): ShipmentRow[] {
  const sc = scopeFor(user);
  return db
    .prepare(`${SHIPMENT_SELECT} WHERE ${sc.where} AND ${extraWhere} ORDER BY s.id`)
    .all(...sc.params, ...extraParams) as ShipmentRow[];
}

export interface RouteRow {
  id: string;
  name: string;
  origin: string;
  destination: string;
  total_km: number;
  geometry: string | null;
  max_gross_t: number | null;
  closed: number;
}

export function getRoute(db: Db, id: string): (RouteRow & { eta: EtaRoute }) | undefined {
  const r = db.prepare('SELECT * FROM routes WHERE id = ?').get(id) as RouteRow | undefined;
  if (!r) return undefined;
  const segments = db
    .prepare('SELECT seq, start_km, end_km, baseline_speed_kmph, dwell_after_min FROM route_segments WHERE route_id = ? ORDER BY start_km')
    .all(id) as EtaRoute['segments'];
  return { ...r, eta: { id: r.id, total_km: r.total_km, segments } };
}

export function getAlternatives(db: Db, routeId: string): { alt_route_id: string; exit_km: number }[] {
  return db
    .prepare('SELECT alt_route_id, exit_km FROM route_alternatives WHERE route_id = ? ORDER BY alt_route_id')
    .all(routeId) as { alt_route_id: string; exit_km: number }[];
}

export function activeDisruptions(db: Db, shipmentId: string): EtaDisruption[] {
  return db
    .prepare(
      `SELECT id, route_id, category, at_km, expected_delay_min, estimate_source, reported_at
       FROM disruptions WHERE shipment_id = ? AND cleared_at IS NULL ORDER BY reported_at, id`,
    )
    .all(shipmentId) as EtaDisruption[];
}

export interface SnapshotRow {
  id: string;
  seq: number;
  shipment_id: string;
  computed_at: string;
  trigger_event_id: string | null;
  route_id: string;
  progress_km: number | null;
  remaining_km: number | null;
  eta: string;
  eta_earliest: string;
  eta_latest: string;
  promised_by: string;
  slack_min: number;
  margin_min: number;
  risk_score: number;
  risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  position_age_min: number | null;
  factors: string;
  headline: string;
  stale: number;
}

export function getSnapshot(db: Db, id: string | null): SnapshotRow | undefined {
  if (!id) return undefined;
  return db.prepare('SELECT * FROM eta_snapshots WHERE id = ?').get(id) as SnapshotRow | undefined;
}

export function snapshotToApi(r: SnapshotRow) {
  return {
    id: r.id,
    shipment_id: r.shipment_id,
    computed_at: r.computed_at,
    trigger_event_id: r.trigger_event_id,
    route_id: r.route_id,
    progress_km: r.progress_km,
    remaining_km: r.remaining_km,
    eta: r.eta,
    eta_window: { earliest: r.eta_earliest, latest: r.eta_latest },
    promised_by: r.promised_by,
    slack_min: r.slack_min,
    margin_min: r.margin_min,
    risk_score: r.risk_score,
    risk_level: r.risk_level,
    confidence: r.confidence,
    position_age_min: r.position_age_min,
    factors: JSON.parse(r.factors) as Factor[],
    headline: r.headline,
  };
}

/** Everything computeEta needs, read from the database at time `now`. */
export function buildEtaState(db: Db, s: ShipmentRow, now: string, cfg: EtaConfig, forecast: EtaState['forecast'] = null): EtaState {
  const route = getRoute(db, s.active_route_id)!;
  const since = addMinutes(now, -cfg.pace_window_min);
  const positions = db
    .prepare(
      `SELECT occurred_at AS at, progress_km AS km FROM shipment_events
       WHERE shipment_id = ? AND type = 'POSITION' AND apply_status = 'APPLIED' AND progress_km IS NOT NULL
         AND occurred_at >= ? AND occurred_at <= ?
       ORDER BY occurred_at`,
    )
    .all(s.id, since, now) as { at: string; km: number }[];
  const prev = getSnapshot(db, s.current_eta_snapshot_id);
  return {
    shipment_id: s.id,
    status: s.status,
    planned_departure: s.planned_departure,
    departed_at: s.departed_at,
    promised_by: s.agreed_delivery_by,
    route: route.eta,
    diverted_from:
      s.diverted_from_route_id !== null && s.diverted_at_km !== null
        ? { route_id: s.diverted_from_route_id, at_km: s.diverted_at_km }
        : null,
    progress_km: s.last_progress_km,
    position_at: s.last_position_at,
    positions,
    disruptions: activeDisruptions(db, s.id),
    forecast,
    previous: prev
      ? { computed_at: prev.computed_at, eta: prev.eta, route_id: prev.route_id, factors: JSON.parse(prev.factors) as Factor[] }
      : null,
  };
}
