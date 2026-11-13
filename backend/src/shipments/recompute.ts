// Recalculate a shipment's ETA, store the snapshot and run the alert rules.
// Always called inside the transaction of the change that triggered it (DESIGN.md 4.3).
import { audit } from '../audit';
import { nextSeq } from '../db/db';
import type { Ctx } from '../ctx';
import { computeEta } from '../eta/computeEta';
import type { EtaTrigger } from '../eta/types';
import { evaluateAlerts } from '../alerts/alerts';
import type { PendingHint } from '../stream/hub';
import { buildEtaState, getShipment, getSnapshot, type ShipmentRow } from './repo';

export function etaStateFor(ctx: Ctx, s: ShipmentRow, now: string) {
  const w = ctx.config.demoMode ? undefined : ctx.weather.forRoute(s.active_route_id);
  const forecast = w && w.worst && w.suggested_delay_min > 0 ? { minutes: w.suggested_delay_min, at_km: w.worst.km, reasons: w.worst.reasons } : null;
  const state = buildEtaState(ctx.db, s, now, ctx.fixtures.config.eta, forecast);
  const live = ctx.liveRouteDemo;
  if (live?.isLiveShipment(s.id)) state.liveRouting = { drive: live.drive(s.active_route_id, s.last_progress_km) };
  else {
    // Only with a fresh TomTom quote; otherwise baseline speeds and observed pace, as before.
    const drive = ctx.routeTraffic?.drive(s);
    if (drive) state.liveRouting = { drive };
  }
  return state;
}

/** Returns the new snapshot id, or null when the shipment has arrived (the last snapshot stands). */
export function recomputeEta(
  ctx: Ctx,
  shipmentId: string,
  now: string,
  triggerEventId: string | null,
  trigger: EtaTrigger,
  hints: PendingHint[],
): string | null {
  const { db } = ctx;
  const s = getShipment(db, shipmentId)!;
  if (s.status === 'ARRIVED' || s.status === 'DELIVERED' || s.status === 'CANCELLED') return null;
  const cfg = ctx.fixtures.config.eta;
  const prev = getSnapshot(db, s.current_eta_snapshot_id);
  const res = computeEta(etaStateFor(ctx, s, now), now, cfg, trigger);

  const seq = nextSeq(db, 'ETA');
  const id = `ETA-${String(seq).padStart(6, '0')}`;
  db.prepare(
    `INSERT INTO eta_snapshots (id, seq, shipment_id, computed_at, trigger_event_id, route_id, progress_km, remaining_km, eta,
       eta_earliest, eta_latest, promised_by, slack_min, margin_min, risk_score, risk_level, confidence, position_age_min,
       factors, headline, stale)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, seq, s.id, res.computed_at, triggerEventId, res.route_id, res.progress_km, res.remaining_km, res.eta,
    res.eta_window.earliest, res.eta_window.latest, res.promised_by, res.slack_min, res.margin_min, res.risk_score,
    res.risk_level, res.confidence, res.position_age_min, JSON.stringify(res.factors), res.headline, res.stale ? 1 : 0,
  );
  db.prepare('UPDATE shipments SET current_eta_snapshot_id = ? WHERE id = ?').run(id, s.id);
  audit(db, now, null, 'ETA_RECALCULATED', 'eta_snapshot', id, {
    shipment_id: s.id,
    previous_eta: prev?.eta ?? null,
    new_eta: res.eta,
  });

  const kinds = ['eta', ...evaluateAlerts(ctx, { ...s, current_eta_snapshot_id: id }, prev, res, id, now, hints)];
  hints.push({
    hint: { entity: 'shipment', id: s.id, version: s.version, kinds },
    audience: { kind: 'shipment', customer_id: s.customer_id, driver_user_id: s.driver_user_id },
  });
  return id;
}
