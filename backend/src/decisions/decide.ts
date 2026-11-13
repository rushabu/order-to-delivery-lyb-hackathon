// Decision service (DESIGN.md 5.7.3, 6.7, 6.8). Applies exactly one feasible option that a coordinator
// approved. Nothing is ever applied without this call. Idempotent on decision_id.
import { audit } from '../audit';
import type { AlertRow } from '../alerts/alerts';
import type { AuthUser } from '../auth/policy';
import { shipmentNow, type Ctx } from '../ctx';
import { nextId } from '../db/db';
import { ApiError, notFound, validationFailed } from '../http/errors';
import type { Option } from '../http/schemas';
import { customerUserIds } from '../notify/notifier';
import { isStale, type OptionSetRow } from '../options/service';
import { rerouteReason } from '../options/evaluate';
import { recomputeEta } from '../shipments/recompute';
import { getRoute, getShipment, type ShipmentRow } from '../shipments/repo';
import { stableUuid } from '../sim/ids';
import type { PendingHint } from '../stream/hub';
import { istClock } from '../time';

export interface DecisionInput {
  decision_id: string;
  option_set_id: string;
  option_id: string;
  note?: string;
}

const conflict = (code: string, message: string) => new ApiError(409, code, message);

export function decide(ctx: Ctx, user: AuthUser, shipmentId: string, input: DecisionInput): { status: 200 | 201; body: unknown } {
  const { db } = ctx;
  const now = shipmentNow(ctx, shipmentId);
  const hints: PendingHint[] = [];

  const result = db.transaction(() => {
    const prior = db.prepare('SELECT shipment_id, result FROM decisions WHERE decision_id = ?').get(input.decision_id) as
      | { shipment_id: string; result: string }
      | undefined;
    if (prior) {
      if (prior.shipment_id !== shipmentId) throw validationFailed('decision_id was already used for another shipment');
      return { status: 200 as const, body: JSON.parse(prior.result) };
    }
    const s = getShipment(db, shipmentId);
    if (!s) throw notFound('Shipment not found');
    const set = db.prepare('SELECT * FROM option_sets WHERE id = ? AND shipment_id = ?').get(input.option_set_id, s.id) as
      | OptionSetRow
      | undefined;
    if (!set) throw notFound('Option set not found for this shipment');
    const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(set.alert_id) as AlertRow;
    if (alert.status === 'DECIDED') throw conflict('ALERT_ALREADY_DECIDED', 'This alert already has an approved decision');
    if (alert.status !== 'OPEN' || isStale(set, s, now)) {
      throw conflict('OPTIONS_STALE', 'The situation changed since these options were generated. Fetch the options again.');
    }
    const options = JSON.parse(set.options) as Option[];
    const option = options.find((o) => o.id === input.option_id);
    if (!option) throw notFound('Option not found in this option set');
    if (!option.feasible) throw conflict('OPTION_INFEASIBLE', option.infeasible_reason ?? 'This option is not feasible');

    const noAction = options.find((o) => o.type === 'CONTINUE')!;
    const applied = apply(ctx, s, option, now, hints);
    db.prepare(`UPDATE alerts SET status = 'DECIDED' WHERE id = ?`).run(alert.id);

    // Customer and driver are told what changed (DESIGN.md 8, DECISION_APPLIED).
    const after = getShipment(db, s.id)!;
    const snapshot = db.prepare('SELECT eta FROM eta_snapshots WHERE id = ?').get(after.current_eta_snapshot_id) as { eta: string };
    let sent = 0;
    for (const u of customerUserIds(db, s.customer_id)) {
      ctx.notifier.send(
        db,
        now,
        {
          user_id: u,
          shipment_id: s.id,
          kind: 'DECISION_APPLIED',
          title: `Update on ${s.order_id}`,
          body: `Update on ${s.order_id}: ${applied.customerText}. New estimate ${istClock(snapshot.eta)}.`,
        },
        hints,
      );
      sent++;
    }
    if (s.driver_user_id) {
      ctx.notifier.send(
        db,
        now,
        { user_id: s.driver_user_id, shipment_id: s.id, kind: 'DECISION_APPLIED', title: 'New instruction', body: `New instruction: ${applied.driverText}.` },
        hints,
      );
      sent++;
    }

    const id = nextId(db, 'DEC', 4);
    const predicted = { chosen_eta: option.projected_eta!, no_action_eta: noAction.projected_eta! };
    const body = {
      id,
      decision_id: input.decision_id,
      shipment_id: s.id,
      option_type: option.type,
      decided_by: user.id,
      decided_at: now,
      shipment_version: after.version,
      eta_snapshot_id: after.current_eta_snapshot_id,
      notifications_created: sent,
      predicted,
      outcome: null,
    };
    db.prepare(
      `INSERT INTO decisions (id, decision_id, option_set_id, option_id, option_type, shipment_id, decided_by, decided_at, note,
         predicted, outcome, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(id, input.decision_id, set.id, option.id, option.type, s.id, user.id, now, input.note ?? null, JSON.stringify(predicted), JSON.stringify(body));
    audit(db, now, user.id, 'DECISION_APPROVED', 'decision', id, {
      option_id: option.id,
      option_type: option.type,
      coordinator: user.id,
      note: input.note ?? null,
    });
    hints.push({
      hint: { entity: 'shipment', id: s.id, version: after.version, kinds: ['decision', 'eta', 'alert'] },
      audience: { kind: 'shipment', customer_id: s.customer_id, driver_user_id: s.driver_user_id },
    });
    return { status: 201 as const, body };
  })();

  ctx.hub.publish(hints);
  return result;
}

interface Applied {
  customerText: string;
  driverText: string;
}

function apply(ctx: Ctx, s: ShipmentRow, option: Option, now: string, hints: PendingHint[]): Applied {
  const { db } = ctx;
  switch (option.type) {
    case 'REROUTE': {
      const altId = String(option.params!.alt_route_id);
      const exit = db.prepare('SELECT exit_km FROM route_alternatives WHERE route_id = ? AND alt_route_id = ?').get(s.active_route_id, altId) as { exit_km: number } | undefined;
      const alt = getRoute(db, altId);
      if (!exit || !alt) throw conflict('OPTIONS_STALE', 'This alternative route is no longer available');
      const reason = rerouteReason(s.status, s.last_progress_km, s.gross_t, { ...exit, alt_route_id: altId, max_gross_t: alt.max_gross_t, closed: alt.closed === 1 });
      if (reason) throw conflict('OPTIONS_STALE', reason);
      const live = ctx.liveRouteDemo;
      if (live?.isLiveShipment(s.id) && (!live.drive(s.active_route_id, s.last_progress_km) || !live.drive(altId, s.last_progress_km))) {
        throw conflict('OPTIONS_STALE', 'Refresh live traffic before approving the reroute');
      }
      db.prepare(
        `UPDATE shipments SET active_route_id = ?, diverted_from_route_id = ?, diverted_at_km = ?,
           version = version + 1, plan_version = plan_version + 1 WHERE id = ?`,
      ).run(altId, s.active_route_id, exit.exit_km, s.id);
      recomputeEta(ctx, s.id, now, null, 'EVENT', hints);
      return {
        customerText: `the truck has been rerouted via ${alt.name} to avoid the delay`,
        driverText: `new route via ${alt.name}; take the exit at km ${exit.exit_km}`,
      };
    }
    case 'RESCHEDULE': {
      const newTime = String(option.params!.new_agreed_delivery_by);
      db.prepare('UPDATE orders SET agreed_delivery_by = ? WHERE id = ?').run(newTime, s.order_id);
      db.prepare('UPDATE shipments SET version = version + 1 WHERE id = ?').run(s.id);
      recomputeEta(ctx, s.id, now, null, 'EVENT', hints);
      return {
        customerText: `Plant X proposes a new delivery time of ${istClock(newTime)}`,
        driverText: `deliver by ${istClock(newTime)}; no route change`,
      };
    }
    case 'CONTINUE': {
      db.prepare('UPDATE shipments SET version = version + 1 WHERE id = ?').run(s.id);
      return { customerText: 'the truck continues on its current route and Plant X is monitoring it', driverText: 'continue on the current route' };
    }
    case 'SPLIT_SHIPMENT': {
      const nowT = Number(option.params!.quantity_now_t);
      const laterT = Number(option.params!.quantity_later_t);
      const standby = db.prepare('SELECT vehicle_reg FROM standby_vehicles WHERE available = 1 ORDER BY vehicle_reg LIMIT 1').get() as {
        vehicle_reg: string;
      };
      const maxNum = (db.prepare(`SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) n FROM shipments`).get() as { n: number }).n;
      const newId = `SHP-${maxNum + 1}`;
      db.prepare(
        `INSERT INTO shipments (id, order_id, transporter_id, driver_user_id, vehicle_reg, quantity_t, gross_t, status,
           planned_route_id, active_route_id, planned_departure, created_at, split_from_shipment_id)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?)`,
      ).run(newId, s.order_id, s.transporter_id, standby.vehicle_reg, laterT, laterT + (s.gross_t - s.quantity_t), s.planned_route_id, s.active_route_id, s.planned_departure, now, s.id);
      db.prepare('UPDATE standby_vehicles SET available = 0 WHERE vehicle_reg = ?').run(standby.vehicle_reg);
      // The balance waits for the loading delay; the part already loaded leaves without it.
      const loading = db.prepare(`SELECT * FROM disruptions WHERE shipment_id = ? AND category = 'LOADING_DELAY' AND cleared_at IS NULL`).all(s.id) as Record<string, unknown>[];
      for (const d of loading) {
        db.prepare(
          `INSERT INTO disruptions (id, shipment_id, route_id, category, at_km, expected_delay_min, estimate_source, note, reported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(stableUuid(`split:${d.id}:${newId}`), newId, d.route_id, d.category, d.at_km, d.expected_delay_min, d.estimate_source, d.note, d.reported_at);
        db.prepare('UPDATE disruptions SET cleared_at = ? WHERE id = ?').run(now, d.id);
      }
      db.prepare(
        'UPDATE shipments SET quantity_t = ?, gross_t = ?, version = version + 1, plan_version = plan_version + 1 WHERE id = ?',
      ).run(nowT, nowT + (s.gross_t - s.quantity_t), s.id);
      recomputeEta(ctx, s.id, now, null, 'EVENT', hints);
      recomputeEta(ctx, newId, now, null, 'EVENT', hints);
      return {
        customerText: `the order is split: ${nowT} t leaves now on ${s.vehicle_reg} and ${laterT} t follows on ${standby.vehicle_reg} (shipment ${newId})`,
        driverText: `load ${nowT} t only and depart; the balance follows on another vehicle`,
      };
    }
  }
}
