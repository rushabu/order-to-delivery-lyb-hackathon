// Option evaluator (DESIGN.md 6.7). Pure: builds every option, checks feasibility, projects each
// feasible option by running computeEta on a copy of the state with the option applied, ranks them
// and picks the recommendation. No database, no clock.
import { computeEta, DEFAULT_ETA_CONFIG } from '../eta/computeEta';
import type { EtaConfig, EtaResult, EtaRoute, EtaState, LiveDrive } from '../eta/types';
import type { Option } from '../http/schemas';
import { minutesBetween } from '../time';

export interface AlternativeInput {
  alt_route_id: string;
  exit_km: number;
  name: string;
  route: EtaRoute;
  total_km: number;
  current_total_km: number;
  max_gross_t: number | null;
  closed: boolean;
  liveDrive?: LiveDrive | null;
}

export interface OptionInput {
  state: EtaState; // live state; state.promised_by is the current (agreed) promise
  now: string;
  status: EtaState['status'];
  gross_t: number;
  quantity_t: number;
  original_promised_by: string;
  alternatives: AlternativeInput[];
  standby_vehicle_available: boolean;
  cost_per_km_inr: number;
  standby_vehicle_cost_inr: number;
  split_min_quantity_t: number;
  improvement_threshold_min: number;
  etaConfig?: EtaConfig;
}

export interface OptionResult {
  options: Option[];
  recommended_option_id: string;
  recommendation_reason: string;
  continue_projection: EtaResult;
}

const TYPE_ORDER = ['REROUTE', 'SPLIT_SHIPMENT', 'CONTINUE', 'RESCHEDULE'];
const lateMin = (eta: string, promise: string) => Math.max(0, Math.round(minutesBetween(promise, eta)));

export function rerouteReason(status: EtaState['status'], progress: number | null, grossTonnes: number, alt: Pick<AlternativeInput, 'exit_km' | 'alt_route_id' | 'closed' | 'max_gross_t'>): string | null {
  if (status !== 'IN_TRANSIT') return 'Shipment is not in transit';
  if (progress === null) return 'Truck position is unknown';
  if (progress > alt.exit_km) return `Truck has passed the exit at km ${alt.exit_km}`;
  if (alt.closed) return `${alt.alt_route_id} is closed`;
  if (alt.max_gross_t !== null && grossTonnes > alt.max_gross_t) return `Gross weight ${grossTonnes} t exceeds the ${alt.max_gross_t} t limit on ${alt.alt_route_id}`;
  return null;
}

export function evaluateOptions(input: OptionInput): OptionResult {
  const cfg = input.etaConfig ?? DEFAULT_ETA_CONFIG;
  const { state, now } = input;
  const cont = computeEta(state, now, cfg);
  const options: Option[] = [];

  // CONTINUE: always feasible.
  options.push({
    id: 'OPT-CONTINUE',
    type: 'CONTINUE',
    feasible: true,
    label: 'Continue on current route and monitor',
    projected_eta: cont.eta,
    projected_late_min: lateMin(cont.eta, state.promised_by),
    projected_risk_level: cont.risk_level,
    improvement_min: 0,
    added_km: 0,
    added_cost_inr: 0,
    params: {},
  });

  // REROUTE: one option per pre-defined alternative.
  if (input.alternatives.length === 0) {
    options.push({
      id: 'OPT-REROUTE',
      type: 'REROUTE',
      feasible: false,
      label: 'Reroute',
      infeasible_reason: `No alternative route is defined for ${state.route.id}`,
    });
  }
  for (const alt of input.alternatives) {
    const id = `OPT-REROUTE-${alt.alt_route_id}`;
    const label = `Reroute via ${alt.name} (${alt.alt_route_id})`;
    const reason = rerouteReason(input.status, state.progress_km, input.gross_t, alt)
      ?? (state.liveRouting && (!state.liveRouting.drive || !alt.liveDrive) ? 'Refresh live traffic to compare routes' : null);
    if (reason) {
      options.push({ id, type: 'REROUTE', feasible: false, label, infeasible_reason: reason });
      continue;
    }
    const hypo: EtaState = {
      ...state,
      route: alt.route,
      liveRouting: state.liveRouting && { drive: alt.liveDrive ?? null },
      forecast: null,
      diverted_from: { route_id: state.route.id, at_km: alt.exit_km },
      previous: null,
    };
    const p = computeEta(hypo, now, cfg);
    const addedKm = Math.round((alt.total_km - alt.current_total_km) * 10) / 10; // live routes give metres; show 0.1 km
    options.push({
      id,
      type: 'REROUTE',
      feasible: true,
      label,
      projected_eta: p.eta,
      projected_late_min: lateMin(p.eta, state.promised_by),
      projected_risk_level: p.risk_level,
      improvement_min: Math.round(minutesBetween(p.eta, cont.eta)),
      added_km: addedKm,
      added_cost_inr: Math.round(Math.max(0, addedKm) * input.cost_per_km_inr),
      params: { alt_route_id: alt.alt_route_id },
    });
  }

  // SPLIT_SHIPMENT: send part of the load now, the rest later.
  {
    const loading = state.disruptions.filter((d) => d.category === 'LOADING_DELAY');
    let reason: string | null = null;
    if (input.status === 'IN_TRANSIT' || input.status === 'ARRIVED') reason = 'Load is already in transit on one vehicle';
    else if (input.status !== 'PLANNED') reason = 'Shipment has already been dispatched';
    else if (loading.length === 0) reason = 'No loading delay is holding the shipment';
    else if (input.quantity_t < input.split_min_quantity_t) reason = `Load is under ${input.split_min_quantity_t} t`;
    else if (!input.standby_vehicle_available) reason = 'No standby vehicle is available';
    if (reason) {
      options.push({ id: 'OPT-SPLIT', type: 'SPLIT_SHIPMENT', feasible: false, label: 'Split shipment', infeasible_reason: reason });
    } else {
      // The part already loaded leaves without waiting for the loading delay.
      const nowPart = Math.floor(input.quantity_t / 2);
      const p = computeEta({ ...state, disruptions: state.disruptions.filter((d) => d.category !== 'LOADING_DELAY') }, now, cfg);
      options.push({
        id: 'OPT-SPLIT',
        type: 'SPLIT_SHIPMENT',
        feasible: true,
        label: `Split shipment: send ${nowPart} t now, ${input.quantity_t - nowPart} t on a standby vehicle`,
        projected_eta: p.eta,
        projected_late_min: lateMin(p.eta, state.promised_by),
        projected_risk_level: p.risk_level,
        improvement_min: Math.round(minutesBetween(p.eta, cont.eta)),
        added_km: 0,
        added_cost_inr: input.standby_vehicle_cost_inr,
        params: { quantity_now_t: nowPart, quantity_later_t: input.quantity_t - nowPart },
      });
    }
  }

  // RESCHEDULE: arrival unchanged; new agreed time = ETA + margin; lateness still against the original promise.
  {
    const newAgreed = cont.eta_window.latest;
    const p = computeEta({ ...state, promised_by: newAgreed }, now, cfg);
    options.push({
      id: 'OPT-RESCHEDULE',
      type: 'RESCHEDULE',
      feasible: true,
      label: 'Accept delay and agree a new delivery time with the customer',
      projected_eta: cont.eta,
      projected_late_min: lateMin(cont.eta, input.original_promised_by),
      projected_risk_level: p.risk_level,
      improvement_min: 0,
      added_km: 0,
      added_cost_inr: 0,
      params: { new_agreed_delivery_by: newAgreed },
    });
  }

  // Ranking: feasible first, then lateness, then cost, then the fixed type order.
  options.sort(
    (a, b) =>
      Number(b.feasible) - Number(a.feasible) ||
      (a.projected_late_min ?? 0) - (b.projected_late_min ?? 0) ||
      (a.added_cost_inr ?? 0) - (b.added_cost_inr ?? 0) ||
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type),
  );

  const top = options[0];
  const continueLate = lateMin(cont.eta, state.promised_by);
  let recommended: Option;
  let reason: string;
  if (top.type === 'CONTINUE' && continueLate === 0) {
    recommended = top;
    reason = 'The shipment is still expected on time. Recommended: continue and monitor.';
  } else if (top.type !== 'CONTINUE' && top.type !== 'RESCHEDULE' && (top.improvement_min ?? 0) >= input.improvement_threshold_min) {
    recommended = top;
    reason = `${top.label} improves arrival by ${top.improvement_min} min.`;
  } else {
    recommended = options.find((o) => o.type === 'RESCHEDULE')!;
    reason = 'No available action brings this shipment back on time. Recommended: agree a new delivery time and inform the customer now.';
  }
  return { options, recommended_option_id: recommended.id, recommendation_reason: reason, continue_projection: cont };
}
