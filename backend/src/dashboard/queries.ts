// Dashboard and impact queries (DESIGN.md 1.3 C5 and 10.3). Coordinators only.
// On-time is always measured against orders.original_promised_by, never the rescheduled time.
// Shipments are grouped by their planned route (the lane), so a rerouted truck stays in its lane's figures.
import type { Ctx } from '../ctx';
import { LIVE_SHIPMENT_PREFIX } from '../liveRouting/scenarios';
import { minutesBetween } from '../time';

type GroupBy = 'route' | 'transporter';

const GROUP_SQL: Record<GroupBy, { id: string; name: string; join: string }> = {
  route: { id: 's.planned_route_id', name: 'g.name', join: 'JOIN routes g ON g.id = s.planned_route_id' },
  transporter: { id: 's.transporter_id', name: 'g.name', join: 'JOIN transporters g ON g.id = s.transporter_id' },
};

const pct = (num: number, den: number) => (den === 0 ? null : Math.round((1000 * num) / den) / 10);

export function onTime(ctx: Ctx, groupBy: GroupBy) {
  const g = GROUP_SQL[groupBy];
  const rows = ctx.db
    .prepare(
      `SELECT ${g.id} AS group_id, ${g.name} AS group_name,
              COUNT(*) AS arrived,
              SUM(CASE WHEN s.arrived_at <= o.original_promised_by THEN 1 ELSE 0 END) AS on_time
       FROM shipments s JOIN orders o ON o.id = s.order_id ${g.join}
       WHERE s.arrived_at IS NOT NULL AND s.id NOT LIKE ?
       GROUP BY ${g.id} ORDER BY ${g.id}`,
    )
    .all(`${LIVE_SHIPMENT_PREFIX}%`) as { group_id: string; group_name: string; arrived: number; on_time: number }[];
  // One row per group; delivered counts arrivals, on time is against the original promise.
  return rows.map((r) => ({
    group_id: r.group_id,
    group_name: r.group_name,
    delivered: r.arrived,
    on_time: r.on_time,
    late: r.arrived - r.on_time,
    on_time_pct: pct(r.on_time, r.arrived),
  }));
}

const CAUSES = ['CONGESTION', 'ACCIDENT', 'BREAKDOWN', 'WEATHER', 'LOADING_DELAY', 'ROAD_CLOSURE', 'OTHER'] as const;

export function delayCauses(ctx: Ctx, groupBy: GroupBy) {
  const g = GROUP_SQL[groupBy];
  const rows = ctx.db
    .prepare(
      `SELECT ${g.id} AS group_id, ${g.name} AS group_name, c.cause, SUM(c.minutes) AS minutes
       FROM shipment_delay_causes c JOIN shipments s ON s.id = c.shipment_id ${g.join}
       WHERE s.arrived_at IS NOT NULL
       GROUP BY ${g.id}, c.cause ORDER BY ${g.id}, c.cause`,
    )
    .all() as { group_id: string; group_name: string; cause: string; minutes: number }[];
  // One row per group with minutes for every cause (0 when none), so charts stack the same causes.
  const byGroup = new Map<string, { group_id: string; group_name: string; minutes_by_cause: Record<string, number>; total_min: number }>();
  for (const r of rows) {
    const e = byGroup.get(r.group_id) ?? {
      group_id: r.group_id,
      group_name: r.group_name,
      minutes_by_cause: Object.fromEntries(CAUSES.map((c) => [c, 0])),
      total_min: 0,
    };
    e.minutes_by_cause[r.cause] = (e.minutes_by_cause[r.cause] ?? 0) + r.minutes;
    e.total_min += r.minutes;
    byGroup.set(r.group_id, e);
  }
  return [...byGroup.values()];
}

interface Outcome {
  actual_arrival: string;
  counterfactual_no_action_arrival: string;
  delay_avoided_min: number;
}

export function impact(ctx: Ctx) {
  const { db } = ctx;
  const costPerHour = ctx.fixtures.config.impact.cost_per_late_hour_inr;
  // Replay shipments: those the ETA engine has run on (history fixtures have no snapshots).
  const live = db
    .prepare(
      `SELECT s.id, s.arrived_at, o.original_promised_by FROM shipments s JOIN orders o ON o.id = s.order_id
       WHERE s.id NOT LIKE ? AND EXISTS (SELECT 1 FROM eta_snapshots e WHERE e.shipment_id = s.id) ORDER BY s.id`,
    )
    .all(`${LIVE_SHIPMENT_PREFIX}%`) as { id: string; arrived_at: string | null; original_promised_by: string }[];
  const firstAlert = (id: string) =>
    db.prepare('SELECT a.*, e.eta AS first_eta FROM alerts a JOIN eta_snapshots e ON e.id = a.first_snapshot_id WHERE a.shipment_id = ? ORDER BY a.opened_at, a.id LIMIT 1').get(id) as
      | { opened_at: string; first_eta: string }
      | undefined;
  const decisionsOf = (id: string) =>
    db.prepare('SELECT id, predicted, outcome FROM decisions WHERE shipment_id = ? ORDER BY id').all(id) as { id: string; predicted: string; outcome: string | null }[];

  // Warning lead time: original promise minus first alert, per alerted shipment.
  const lead = live
    .map((s) => ({ s, a: firstAlert(s.id) }))
    .filter((x) => x.a)
    .map(({ s, a }) => ({
      shipment_id: s.id,
      first_alert_at: a!.opened_at,
      original_promised_by: s.original_promised_by,
      lead_time_min: Math.round(minutesBetween(a!.opened_at, s.original_promised_by)),
    }));
  const sorted = lead.map((l) => l.lead_time_min).sort((a, b) => a - b);
  const median =
    sorted.length === 0 ? null : sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  // ETA error and the no-action arrival per arrived replay shipment.
  const errors: number[] = [];
  const perDecision: { decision_id: string; shipment_id: string; delay_avoided_min: number }[] = [];
  let highAlerted = 0, highAndLateWithout = 0, lateWithout = 0, lateWithoutAlertedInTime = 0, arrived = 0, onWith = 0, onWithout = 0;
  for (const s of live) {
    if (!s.arrived_at) continue;
    arrived++;
    const decs = decisionsOf(s.id);
    const lastOutcome = decs.map((d) => (d.outcome ? (JSON.parse(d.outcome) as Outcome) : null)).filter(Boolean).pop() ?? null;
    for (const d of decs) {
      if (d.outcome) perDecision.push({ decision_id: d.id, shipment_id: s.id, delay_avoided_min: (JSON.parse(d.outcome) as Outcome).delay_avoided_min });
    }
    const a = firstAlert(s.id);
    if (decs.length > 0) errors.push(Math.abs(minutesBetween(JSON.parse(decs[0].predicted).chosen_eta, s.arrived_at)));
    else if (a) errors.push(Math.abs(minutesBetween(a.first_eta, s.arrived_at)));
    const noAction = lastOutcome ? lastOutcome.counterfactual_no_action_arrival : s.arrived_at;
    const lateNoAction = noAction > s.original_promised_by;
    if (s.arrived_at <= s.original_promised_by) onWith++;
    if (!lateNoAction) onWithout++;
    const wasHigh = db.prepare(`SELECT 1 FROM alerts WHERE shipment_id = ? AND level = 'HIGH'`).get(s.id) !== undefined;
    if (wasHigh) {
      highAlerted++;
      if (lateNoAction) highAndLateWithout++;
    }
    if (lateNoAction) {
      lateWithout++;
      if (a && a.opened_at < s.original_promised_by) lateWithoutAlertedInTime++;
    }
  }
  const totalAvoided = perDecision.reduce((acc, d) => acc + d.delay_avoided_min, 0);
  const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 1000);
  const etaErrorMean = errors.length ? Math.round((10 * errors.reduce((x, y) => x + y, 0)) / errors.length) / 10 : null;
  const costAvoided = Math.round((Math.max(0, totalAvoided) / 60) * costPerHour);
  return {
    fictional: true as const,
    // Flat figures the dashboard reads; the detailed blocks below explain each one.
    warning_lead_time_median_min: median,
    eta_error_mean_min: etaErrorMean,
    alert_precision: ratio(highAndLateWithout, highAlerted),
    alert_recall: ratio(lateWithoutAlertedInTime, lateWithout),
    delay_avoided_total_min: perDecision.length ? totalAvoided : null,
    on_time_pct_with_decisions: pct(onWith, arrived),
    on_time_pct_without_decisions: pct(onWithout, arrived),
    cost_of_lateness_avoided_inr: perDecision.length ? costAvoided : null,
    warning_lead_time: { kind: 'OBSERVED_IN_REPLAY' as const, median_min: median, per_shipment: lead },
    eta_error: {
      kind: 'OBSERVED_IN_REPLAY' as const,
      mean_min: etaErrorMean,
      n: errors.length,
    },
    alert_quality: {
      kind: 'REPLAY_PLUS_COUNTERFACTUAL' as const,
      precision: ratio(highAndLateWithout, highAlerted),
      recall: ratio(lateWithoutAlertedInTime, lateWithout),
      high_alerted: highAlerted,
      late_without_action: lateWithout,
    },
    delay_avoided: { kind: 'COUNTERFACTUAL_IN_REPLAY' as const, total_min: totalAvoided, per_decision: perDecision },
    on_time_delivery: { arrived, with_decisions_pct: pct(onWith, arrived), without_decisions_pct: pct(onWithout, arrived) },
    cost_of_lateness_avoided: {
      kind: 'MODELED_ESTIMATE' as const,
      inr: costAvoided,
      cost_per_late_hour_inr: costPerHour,
    },
    assumptions: [
      'Every figure comes from a fictional scenario; it shows the mechanism works, not real performance.',
      'The comparison for lead time is learning of lateness only after it happens: a lead time of zero or less.',
      `The cost per late hour is a fictional ₹${costPerHour} per shipment, used only to show the calculation.`,
      'Counterfactuals exist only because the simulator knows the scenario’s ground truth.',
    ],
  };
}
