// Plain-arithmetic reference for DESIGN.md sections 6.3 to 6.7, used only to check the seed data.
// This is not the backend's ETA engine (backend/src/eta/computeEta.ts); it lets the seed tests show,
// without the API, that the committed numbers reproduce the worked example. Minutes are rounded
// half up at each factor, as section 6.3 says.
import { addMin, minutesBetween, positionAt, simulateBranch, type Branch } from '../scripts/seed-lib';

const TYPE_ORDER = ['REROUTE', 'SPLIT_SHIPMENT', 'CONTINUE', 'RESCHEDULE'];
export const roundHalfUp = (x: number) => Math.floor(x + 0.5);

export function baseMinutes(route: any, a: number, b: number): number {
  let total = 0;
  for (const s of route.segments) {
    const lo = Math.max(a, s.start_km);
    const hi = Math.min(b, s.end_km);
    if (hi > lo) total += ((hi - lo) / s.baseline_speed_kmph) * 60;
  }
  return total;
}

export const dwellAhead = (route: any, km: number) =>
  route.segments.filter((s: any) => s.end_km > km).reduce((a: number, s: any) => a + s.dwell_after_min, 0);

const segmentAt = (route: any, km: number) =>
  route.segments.find((s: any) => s.start_km <= km && km < s.end_km) ?? route.segments.at(-1);

export interface Pos { at: string; route_id: string; km: number }

/** Position events every intervalMin from departure up to now, from a ground-truth branch. */
export function positions(source: { departure: string; branches: Record<string, Branch> }, branch: string, now: string, intervalMin: number): Pos[] {
  const pts = simulateBranch(source.branches[branch], source.departure);
  const out: Pos[] = [];
  for (let t = 0; t <= minutesBetween(source.departure, now) + 1e-9; t += intervalMin) {
    const p = positionAt(pts, t);
    out.push({ at: addMin(source.departure, t), route_id: p.route_id, km: Math.round(p.km * 1e6) / 1e6 });
  }
  return out;
}

export function slowdown(cfg: any, route: any, pos: Pos[], now: string): number | null {
  const e = cfg.eta;
  const w = pos.filter((p) => { const m = minutesBetween(p.at, now); return m >= 0 && m <= e.pace_window_min; });
  if (w.length < e.pace_min_positions) return null;
  const base = baseMinutes(route, w[0].km, w.at(-1)!.km);
  if (base <= 0) return null;
  return Math.min(e.slowdown_max, Math.max(e.slowdown_min, minutesBetween(w[0].at, w.at(-1)!.at) / base));
}

export function risk(cfg: any, now: string, eta: string, promised: string) {
  const slack = minutesBetween(eta, promised);
  const margin = Math.max(cfg.eta.margin_floor_min, (cfg.eta.margin_pct / 100) * minutesBetween(now, eta));
  const score = Math.max(0, Math.min(100, roundHalfUp(50 - (50 * slack) / margin)));
  const level = score >= cfg.eta.risk_high_from ? 'HIGH' : score >= cfg.eta.risk_medium_from ? 'MEDIUM' : 'LOW';
  return { slack_min: slack, margin_min: margin, risk_score: score, risk_level: level };
}

export interface Disruption { category: string; at_km: number | null; expected_delay_min?: number; reported_at: string }

export function computeEta(cfg: any, route: any, s: {
  status: string; progress_km: number; pos: Pos[]; disruptions: Disruption[]; planned_departure: string; promised_by: string; now: string;
}) {
  const departed = s.status === 'IN_TRANSIT';
  const start = departed || minutesBetween(s.planned_departure, s.now) > 0 ? s.now : s.planned_departure;
  const factors: [string, number][] = [['BASE_TRAVEL', roundHalfUp(baseMinutes(route, s.progress_km, route.total_km))]];
  const dwell = dwellAhead(route, s.progress_km);
  if (dwell) factors.push(['DWELL', dwell]);
  let confidence = 'HIGH';
  if (departed) {
    const sd = slowdown(cfg, route, s.pos, s.now);
    if (sd !== null) {
      const seg = segmentAt(route, s.progress_km);
      const suppressed = s.disruptions.some((d) => d.at_km !== null && seg.start_km <= d.at_km && d.at_km <= seg.end_km);
      const horizon = Math.min(s.progress_km + cfg.eta.pace_horizon_km, route.total_km);
      const pace = suppressed ? 0 : roundHalfUp((sd - 1) * baseMinutes(route, s.progress_km, horizon));
      if (Math.abs(pace) >= cfg.eta.pace_min_factor_min) {
        factors.push(['CONGESTION', pace]);
        confidence = 'MEDIUM';
      }
    }
  }
  for (const d of s.disruptions) {
    if (d.at_km !== null && d.at_km < s.progress_km) continue;
    const expected = d.expected_delay_min ?? cfg.category_default_delay_min[d.category];
    if (d.expected_delay_min === undefined) confidence = 'MEDIUM';
    const remaining = Math.max(expected - minutesBetween(d.reported_at, s.now), cfg.eta.disruption_floor_min);
    factors.push([d.category, roundHalfUp(remaining)]);
  }
  const eta = addMin(start, factors.reduce((a, [, m]) => a + m, 0));
  return { eta, factors: Object.fromEntries(factors) as Record<string, number>, confidence, ...risk(cfg, s.now, eta, s.promised_by) };
}

/** DESIGN.md 6.7: build every option, mark feasibility, rank, recommend. */
export function evaluateOptions(cfg: any, routes: Map<string, any>, alternatives: any[], standby: any[], shipment: any, o: {
  progress_km: number; slowdown: number | null; current: ReturnType<typeof computeEta>; disruptions: Disruption[]; promised_by: string; now: string;
}) {
  const route = routes.get(shipment.route_id);
  const options: any[] = [{ type: 'CONTINUE', feasible: true, eta: o.current.eta, cost: 0, added_km: 0 }];
  for (const alt of alternatives.filter((a) => a.route_id === route.id)) {
    const other = routes.get(alt.alt_route_id);
    const limit = other.restrictions.max_gross_t;
    let reason: string | null = null;
    if (shipment.status !== 'IN_TRANSIT') reason = 'Shipment is not in transit';
    else if (o.progress_km >= alt.exit_km) reason = `Truck has passed the exit at km ${alt.exit_km}`;
    else if (other.restrictions.closed) reason = `${other.id} is closed`;
    else if (limit !== null && shipment.gross_t > limit) reason = `Gross weight ${shipment.gross_t} t exceeds the ${limit} t limit on ${other.id}`;
    const opt: any = { type: 'REROUTE', alt_route_id: other.id, feasible: reason === null, reason };
    if (reason === null) {
      const toExit = roundHalfUp(baseMinutes(route, o.progress_km, alt.exit_km) * (o.slowdown ?? 1));
      const rest = roundHalfUp(baseMinutes(other, alt.exit_km, other.total_km) + dwellAhead(other, alt.exit_km));
      const addedKm = other.total_km - route.total_km;
      Object.assign(opt, { eta: addMin(o.now, toExit + rest), added_km: addedKm, cost: addedKm * cfg.options.cost_per_km_inr });
    }
    options.push(opt);
  }
  const vehicle = standby.find((v) => v.transporter_id === shipment.transporter_id && v.available);
  let splitReason: string | null = null;
  if (shipment.status !== 'PLANNED') splitReason = 'Load is already in transit on one vehicle';
  else if (!o.disruptions.some((d) => d.category === 'LOADING_DELAY')) splitReason = 'No loading delay to work around';
  else if (shipment.quantity_t < cfg.options.split_min_quantity_t) splitReason = 'Load is too small to split';
  else if (!vehicle) splitReason = 'No standby vehicle available';
  const split: any = { type: 'SPLIT_SHIPMENT', feasible: splitReason === null, reason: splitReason };
  if (splitReason === null) {
    // Assumption (database/README.md): the loaded part leaves at the planned departure without the
    // loading delay; the balance follows on the standby vehicle.
    const projected = computeEta(cfg, route, {
      status: 'PLANNED', progress_km: 0, pos: [], disruptions: o.disruptions.filter((d) => d.category !== 'LOADING_DELAY'),
      planned_departure: shipment.planned_departure, promised_by: o.promised_by, now: o.now,
    });
    Object.assign(split, { eta: projected.eta, cost: cfg.options.standby_vehicle_cost_inr, added_km: 0, standby_vehicle_reg: vehicle.vehicle_reg });
  }
  options.push(split);
  const newAgreed = addMin(o.current.eta, Math.ceil(o.current.margin_min));
  options.push({ type: 'RESCHEDULE', feasible: true, eta: o.current.eta, cost: 0, added_km: 0, new_agreed_delivery_by: newAgreed });
  for (const opt of options.filter((x) => x.feasible)) {
    opt.late_min = Math.max(0, minutesBetween(o.promised_by, opt.eta));
    opt.improvement_min = minutesBetween(opt.eta, o.current.eta);
    opt.risk = risk(cfg, o.now, opt.eta, opt.type === 'RESCHEDULE' ? newAgreed : o.promised_by);
  }
  const ranked = options.filter((x) => x.feasible)
    .sort((a, b) => a.late_min - b.late_min || a.cost - b.cost || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
  const top = ranked[0];
  const recommended = top.improvement_min >= cfg.options.improvement_threshold_min ? top : options.find((x) => x.type === 'RESCHEDULE');
  return { options, recommended };
}
