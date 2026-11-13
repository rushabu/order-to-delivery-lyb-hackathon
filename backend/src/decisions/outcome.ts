// Decision ledger outcome (DESIGN.md 6.8): filled when the shipment reaches ARRIVED.
import type { Ctx } from '../ctx';
import { getShipment } from '../shipments/repo';
import { minutesBetween } from '../time';

export interface Predicted {
  chosen_eta: string;
  no_action_eta: string;
}

export function fillOutcomes(ctx: Ctx, shipmentId: string, arrivedAt: string): void {
  const { db } = ctx;
  const s = getShipment(db, shipmentId)!;
  const open = db.prepare('SELECT id, predicted FROM decisions WHERE shipment_id = ? AND outcome IS NULL').all(shipmentId) as {
    id: string;
    predicted: string;
  }[];
  for (const d of open) {
    const predicted = JSON.parse(d.predicted) as Predicted;
    // The simulator knows the road not taken; without it, the predicted no-action ETA is used and labelled an estimate.
    const simulated = ctx.counterfactual?.noActionArrival(shipmentId, s.planned_route_id) ?? null;
    const noAction = simulated ?? predicted.no_action_eta;
    const outcome = {
      actual_arrival: arrivedAt,
      on_time_against_original_promise: arrivedAt <= s.original_promised_by,
      eta_error_min: Math.round(Math.abs(minutesBetween(predicted.chosen_eta, arrivedAt))),
      counterfactual_no_action_arrival: noAction,
      delay_avoided_min: Math.round(minutesBetween(arrivedAt, noAction)),
      counterfactual_kind: simulated ? ('SIMULATED' as const) : ('ESTIMATED' as const),
    };
    db.prepare('UPDATE decisions SET outcome = ? WHERE id = ?').run(JSON.stringify(outcome), d.id);
  }
}
