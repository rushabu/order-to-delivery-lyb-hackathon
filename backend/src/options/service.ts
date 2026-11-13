// Option sets (DESIGN.md 5.7.3, 6.7): generate with the pure evaluator, store immutably, reuse while valid.
// A set is valid for 10 minutes and until a disruption or route change bumps the shipment's plan_version.
import { audit } from '../audit';
import type { AlertRow } from '../alerts/alerts';
import { shipmentNow, type Ctx } from '../ctx';
import { nextId } from '../db/db';
import type { Option } from '../http/schemas';
import { getAlternatives, getRoute, getShipment, type ShipmentRow } from '../shipments/repo';
import { etaStateFor } from '../shipments/recompute';
import { addMinutes } from '../time';
import { evaluateOptions } from './evaluate';

export interface OptionSetRow {
  id: string;
  alert_id: string;
  shipment_id: string;
  generated_at: string;
  valid_until: string;
  based_on_snapshot_id: string;
  plan_version: number;
  options: string;
  recommended_option_id: string;
  recommendation_reason: string;
}

export function optionSetToApi(r: OptionSetRow) {
  return {
    id: r.id,
    alert_id: r.alert_id,
    shipment_id: r.shipment_id,
    generated_at: r.generated_at,
    based_on_snapshot_id: r.based_on_snapshot_id,
    valid_until: r.valid_until,
    recommended_option_id: r.recommended_option_id,
    recommendation_reason: r.recommendation_reason,
    options: JSON.parse(r.options) as Option[],
  };
}

export function isStale(set: OptionSetRow, s: ShipmentRow, now: string): boolean {
  return now >= set.valid_until || set.plan_version !== s.plan_version;
}

/** The current valid option set for the alert, generating a new one if none is valid. */
export function currentOptionSet(ctx: Ctx, alert: AlertRow, actorUserId: string): OptionSetRow {
  const { db } = ctx;
  const now = shipmentNow(ctx, alert.shipment_id);
  const s = getShipment(db, alert.shipment_id)!;
  const latest = db.prepare('SELECT * FROM option_sets WHERE alert_id = ? ORDER BY id DESC LIMIT 1').get(alert.id) as
    | OptionSetRow
    | undefined;
  // Once decided, the alert keeps showing the set the decision was made from.
  if (latest && (alert.status !== 'OPEN' || !isStale(latest, s, now))) return latest;
  return db.transaction(() => generate(ctx, alert, s, now, actorUserId))();
}

function generate(ctx: Ctx, alert: AlertRow, s: ShipmentRow, now: string, actorUserId: string): OptionSetRow {
  const { db } = ctx;
  const cfg = ctx.fixtures.config;
  const state = etaStateFor(ctx, s, now);
  const current = getRoute(db, s.active_route_id)!;
  const alternatives = getAlternatives(db, s.active_route_id).map((a) => {
    const r = getRoute(db, a.alt_route_id)!;
    return {
      alt_route_id: r.id,
      exit_km: a.exit_km,
      name: r.name,
      route: r.eta,
      total_km: r.total_km,
      current_total_km: current.total_km,
      max_gross_t: r.max_gross_t,
      closed: r.closed === 1,
      liveDrive: state.liveRouting ? ctx.liveRouteDemo?.drive(r.id, s.last_progress_km) : undefined,
    };
  });
  const standby = db.prepare('SELECT 1 FROM standby_vehicles WHERE available = 1 LIMIT 1').get() !== undefined;
  const result = evaluateOptions({
    state,
    now,
    status: s.status,
    gross_t: s.gross_t,
    quantity_t: s.quantity_t,
    original_promised_by: s.original_promised_by,
    alternatives,
    standby_vehicle_available: standby,
    cost_per_km_inr: cfg.options.cost_per_km_inr,
    standby_vehicle_cost_inr: cfg.options.standby_vehicle_cost_inr,
    split_min_quantity_t: cfg.options.split_min_quantity_t,
    improvement_threshold_min: cfg.options.improvement_threshold_min,
    etaConfig: cfg.eta,
  });
  const id = nextId(db, 'OPS', 4);
  const row: OptionSetRow = {
    id,
    alert_id: alert.id,
    shipment_id: s.id,
    generated_at: now,
    valid_until: addMinutes(now, cfg.options.valid_for_min),
    based_on_snapshot_id: s.current_eta_snapshot_id!,
    plan_version: s.plan_version,
    options: JSON.stringify(result.options),
    recommended_option_id: result.recommended_option_id,
    recommendation_reason: result.recommendation_reason,
  };
  db.prepare(
    `INSERT INTO option_sets (id, alert_id, shipment_id, generated_at, valid_until, based_on_snapshot_id, plan_version, options,
       recommended_option_id, recommendation_reason)
     VALUES (@id, @alert_id, @shipment_id, @generated_at, @valid_until, @based_on_snapshot_id, @plan_version, @options,
       @recommended_option_id, @recommendation_reason)`,
  ).run(row);
  audit(db, now, actorUserId, 'OPTIONS_GENERATED', 'option_set', id, { alert_id: alert.id, recommended: result.recommended_option_id });
  return row;
}
