// ETA and delay-risk engine (DESIGN.md 6.3 to 6.5). Pure function: state and `now` in, snapshot out.
// Every factor is rounded to whole minutes, and eta = now + sum(factor minutes) always holds.
import { addMinutes, istClock, minutesBetween } from '../time';
import type { EtaConfig, EtaDisruption, EtaResult, EtaRoute, EtaState, EtaTrigger, Factor, Segment } from './types';

export const DEFAULT_ETA_CONFIG: EtaConfig = {
  pace_window_min: 15,
  pace_min_positions: 3,
  pace_horizon_km: 50,
  slowdown_min: 0.8,
  slowdown_max: 2.0,
  pace_min_factor_min: 3,
  disruption_floor_min: 15,
  margin_floor_min: 20,
  margin_pct: 10,
  stale_after_min: 10,
  stale_margin_max_add_min: 60,
  tracking_lost_after_min: 30,
  risk_medium_from: 35,
  risk_high_from: 70,
};

const CATEGORY_WORDS: Record<string, string> = {
  ACCIDENT: 'Accident',
  BREAKDOWN: 'Breakdown',
  WEATHER: 'Bad weather',
  ROAD_CLOSURE: 'Road closure',
  LOADING_DELAY: 'Loading delay',
  OTHER: 'Reported delay',
};

/** Factor codes that are not delays (they do not name a reason in the headline). */
const NON_DELAY_CODES = new Set(['BASE_TRAVEL', 'DWELL', 'POSITION_STALE', 'SCHEDULE_FALLBACK', 'DEPARTURE_WAIT']);

interface DelayFactor extends Factor {
  phrase: string; // lower-case reason used in the headline, e.g. "accident ahead at km 75"
}

const fmtKm = (km: number) => (Number.isInteger(km) ? String(km) : km.toFixed(1));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Minutes to drive from km a to km b along the route at baseline speeds (no dwell). */
export function baseMinutes(route: EtaRoute, fromKm: number, toKm: number): number {
  let total = 0;
  for (const s of route.segments) {
    const lo = Math.max(s.start_km, fromKm);
    const hi = Math.min(s.end_km, toKm);
    if (hi > lo) total += ((hi - lo) / s.baseline_speed_kmph) * 60;
  }
  return total;
}

/** Planned stops (dwell) at segment ends still ahead of km `fromKm`. */
function dwellAhead(route: EtaRoute, fromKm: number): Segment[] {
  return route.segments.filter((s) => s.end_km > fromKm && s.dwell_after_min > 0);
}

function currentSegment(route: EtaRoute, km: number): Segment | undefined {
  return route.segments.find((s) => km >= s.start_km && km < s.end_km) ?? route.segments[route.segments.length - 1];
}

/** Is the disruption on the road the truck will drive? (Section 6.3 clarification for rerouted trucks.) */
function onPath(d: EtaDisruption, state: EtaState): boolean {
  if (d.at_km === null) return true; // at the truck
  if (d.route_id === state.route.id) return true;
  const div = state.diverted_from;
  return div !== null && d.route_id === div.route_id && d.at_km <= div.at_km;
}

function disruptionFactor(d: EtaDisruption, progressKm: number, now: string, cfg: EtaConfig): DelayFactor {
  const word = CATEGORY_WORDS[d.category] ?? 'Reported delay';
  const where = d.at_km !== null && d.at_km > progressKm ? ` ahead at km ${fmtKm(d.at_km)}` : ' reported';
  const since = Math.max(0, minutesBetween(d.reported_at, now));
  let remaining = d.expected_delay_min - since;
  const notes: string[] = [d.estimate_source === 'DRIVER' ? 'driver estimate' : 'default estimate'];
  if (remaining < cfg.disruption_floor_min) {
    remaining = cfg.disruption_floor_min;
    notes.push('running longer than estimated');
  }
  return {
    code: d.category,
    label: `${word}${where} (${notes.join(', ')})`,
    minutes: Math.round(remaining),
    phrase: `${word.toLowerCase()}${where}`,
  };
}

/** Observed slowdown over the trailing window, or null if fewer than the minimum positions. */
export function observedSlowdown(state: EtaState, now: string, cfg: EtaConfig): number | null {
  const windowStart = addMinutes(now, -cfg.pace_window_min);
  const recent = state.positions.filter((p) => p.at >= windowStart && p.at <= now);
  if (recent.length < cfg.pace_min_positions) return null;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const elapsed = minutesBetween(first.at, last.at);
  if (elapsed <= 0) return null;
  if (last.km - first.km <= 0) return cfg.slowdown_max; // not moving
  const expected = baseMinutes(state.route, first.km, last.km);
  return clamp(elapsed / expected, cfg.slowdown_min, cfg.slowdown_max);
}

export function computeEta(
  state: EtaState,
  now: string,
  cfg: EtaConfig = DEFAULT_ETA_CONFIG,
  trigger: EtaTrigger = 'EVENT',
): EtaResult {
  const notDeparted = state.status === 'PLANNED' || state.status === 'DISPATCHED';
  const inTransit = state.status === 'IN_TRANSIT';
  const positionAge = state.position_at === null ? null : Math.floor(minutesBetween(state.position_at, now));
  const stale = inTransit && positionAge !== null && positionAge > cfg.stale_after_min;
  const trackingLost = inTransit && positionAge !== null && positionAge > cfg.tracking_lost_after_min;

  const factors: Factor[] = [];
  const delays: DelayFactor[] = [];
  let confidence: EtaResult['confidence'] = 'HIGH';
  let slowdown: number | null = null;
  let progress: number | null = notDeparted ? 0 : state.progress_km;
  let held = false;

  if (stale && trigger === 'TICK' && state.previous && state.previous.route_id === state.route.id) {
    // 6.5: hold the arrival time. The truck is assumed to continue as planned, so the minutes that
    // have passed since the previous snapshot are taken off its factors, base travel first.
    held = true;
    let toConsume = Math.max(0, Math.round(minutesBetween(state.previous.computed_at, now)));
    for (const f of state.previous.factors) {
      if (f.code === 'POSITION_STALE') continue;
      const take = Math.min(Math.max(f.minutes, 0), toConsume);
      toConsume -= take;
      const minutes = f.minutes - take;
      if (minutes !== 0 || f.code === 'BASE_TRAVEL') factors.push({ code: f.code, label: f.label, minutes });
      if (!NON_DELAY_CODES.has(f.code) && minutes > 0) {
        delays.push({ ...f, minutes, phrase: f.label.replace(/ \(.*\)$/, '').toLowerCase() });
      }
    }
  } else if (inTransit && progress === null) {
    // 6.5 fallback: no projectable position. Planned departure + planned duration + reported disruptions.
    const dep = state.departed_at ?? state.planned_departure;
    const planned =
      baseMinutes(state.route, 0, state.route.total_km) + dwellAhead(state.route, -1).reduce((a, s) => a + s.dwell_after_min, 0);
    const left = Math.max(0, Math.round(minutesBetween(now, addMinutes(dep, planned))));
    factors.push({ code: 'SCHEDULE_FALLBACK', label: 'Schedule-based estimate', minutes: left });
    for (const d of state.disruptions) {
      const f = disruptionFactor(d, 0, now, cfg);
      factors.push(strip(f));
      delays.push(f);
    }
    confidence = 'LOW';
  } else {
    const p = progress ?? 0;
    // Not yet departed: the clock starts at the later of now and the planned departure (step 6).
    if (notDeparted) {
      const wait = Math.round(minutesBetween(now, state.planned_departure));
      if (wait > 0) {
        factors.push({
          code: 'DEPARTURE_WAIT',
          label: `Waiting for planned departure at ${istClock(state.planned_departure)}`,
          minutes: wait,
        });
      }
    }
    // Step 1: base travel.
    const drive = state.liveRouting?.drive;
    if (drive) {
      const traffic = Math.round(drive.trafficMinutes);
      factors.push({ code: 'BASE_TRAVEL', label: 'Remaining drive estimate (TomTom)', minutes: Math.round(drive.minutes) - traffic });
      if (traffic > 0) {
        const f = { code: 'CONGESTION', label: 'Live traffic delay (TomTom)', minutes: traffic, phrase: 'live traffic' };
        factors.push(strip(f));
        delays.push(f);
      }
      confidence = 'MEDIUM';
    } else {
      factors.push({
        code: 'BASE_TRAVEL',
        label: state.liveRouting ? 'Estimated remaining drive (live traffic unavailable)' : 'Remaining drive at normal speed',
        minutes: Math.round(baseMinutes(state.route, p, state.route.total_km)),
      });
      if (state.liveRouting) confidence = 'LOW';
    }
    // Step 2: planned stops.
    const stops = dwellAhead(state.route, p);
    if (stops.length > 0) {
      const kms = stops.map((s) => fmtKm(s.end_km));
      factors.push({
        code: 'DWELL',
        label: stops.length === 1 ? `Checkpoint stop at km ${kms[0]}` : `Checkpoint stops at km ${kms.join(' and ')}`,
        minutes: Math.round(stops.reduce((a, s) => a + s.dwell_after_min, 0)),
      });
    }
    const active = state.disruptions.filter((d) => onPath(d, state) && (d.at_km === null || d.at_km >= p));
    // Step 3: observed pace, only once moving.
    if (inTransit && !state.liveRouting) {
      slowdown = observedSlowdown(state, now, cfg);
      if (slowdown !== null) {
        let horizonEnd = Math.min(p + cfg.pace_horizon_km, state.route.total_km);
        // Congestion is local to the road it was seen on: after a reroute, it is projected only up to the exit.
        if (state.diverted_from && p < state.diverted_from.at_km) horizonEnd = Math.min(horizonEnd, state.diverted_from.at_km);
        const seg = currentSegment(state.route, p);
        const suppressed = active.some((d) => d.at_km === null || (seg !== undefined && d.at_km <= seg.end_km));
        const pace = suppressed ? 0 : Math.round((slowdown - 1) * baseMinutes(state.route, p, horizonEnd));
        if (Math.abs(pace) >= cfg.pace_min_factor_min) {
          const km = fmtKm(Math.round(horizonEnd - p));
          const f: DelayFactor =
            pace > 0
              ? { code: 'CONGESTION', label: `Slow traffic on the next ${km} km (${slowdown.toFixed(1)}x normal time)`, minutes: pace, phrase: 'slow traffic' }
              : { code: 'CONGESTION', label: `Faster than normal on the next ${km} km`, minutes: pace, phrase: 'faster pace' };
          factors.push(strip(f));
          delays.push(f);
          confidence = 'MEDIUM';
        }
      }
    }
    // Step 4: reported disruptions at or ahead of the truck.
    for (const d of active) {
      const km = d.at_km;
      const coveredByTraffic = drive && drive.trafficMinutes > 0 && km !== null && d.route_id === state.route.id
        && drive.affectedSpans.some((span) => km >= span.fromKm && km <= span.toKm);
      if (coveredByTraffic && (d.category === 'ACCIDENT' || d.category === 'ROAD_CLOSURE')) continue;
      const f = disruptionFactor(d, p, now, cfg);
      factors.push(strip(f));
      delays.push(f);
      if (d.estimate_source === 'DEFAULT' && confidence === 'HIGH') confidence = 'MEDIUM';
    }
    // Live mode: forecast weather ahead. A driver's weather report wins, so it is not counted twice.
    const fc = state.forecast;
    if (inTransit && fc && fc.minutes > 0 && fc.at_km >= p && !active.some((d) => d.category === 'WEATHER')) {
      const why = fc.reasons.join(', ');
      const f: DelayFactor = {
        code: 'WEATHER_FORECAST',
        label: `Forecast near km ${fmtKm(Math.round(fc.at_km))}: ${why} (Open-Meteo)`,
        minutes: fc.minutes,
        phrase: `forecast ${fc.reasons[0] ?? 'weather'} near km ${fmtKm(Math.round(fc.at_km))}`,
      };
      factors.push(strip(f));
      delays.push(f);
      confidence = 'MEDIUM';
    }
  }

  if (stale) {
    confidence = 'LOW';
    factors.push({ code: 'POSITION_STALE', label: `No position for ${positionAge} min`, minutes: 0 });
  }

  // Step 5: ETA.
  const total = factors.reduce((a, f) => a + f.minutes, 0);
  const eta = addMinutes(now, total);

  // 6.4: risk.
  let margin = Math.max(cfg.margin_floor_min, Math.round((cfg.margin_pct / 100) * total));
  if (stale && positionAge !== null) margin += Math.min(cfg.stale_margin_max_add_min, positionAge - cfg.stale_after_min);
  const slack = Math.round(minutesBetween(eta, state.promised_by));
  let score = clamp(Math.round(50 - (50 * slack) / margin), 0, 100);
  if (trackingLost) score = Math.max(score, cfg.risk_medium_from); // 6.5: at least MEDIUM
  const level = score >= cfg.risk_high_from ? 'HIGH' : score >= cfg.risk_medium_from ? 'MEDIUM' : 'LOW';

  const top = delays.filter((d) => d.minutes > 0).sort((a, b) => b.minutes - a.minutes)[0];
  const reason = top ? `${top.phrase} adds ${top.minutes} min` : '';
  let headline: string;
  if (trackingLost) headline = `Tracking lost: no position for ${positionAge} min`;
  else if (slack < 0) headline = `Expected ${-slack} min late${reason ? `: ${reason}` : ''}`;
  else if (level !== 'LOW') headline = `At risk${reason ? `: ${reason}` : `: ${slack} min to spare`}`;
  else headline = 'On schedule';

  if (progress !== null) progress = Math.round(progress * 1000) / 1000;
  return {
    computed_at: now,
    route_id: state.route.id,
    progress_km: progress,
    remaining_km: progress === null ? null : Math.round((state.route.total_km - progress) * 10) / 10,
    eta,
    eta_window: { earliest: addMinutes(eta, -margin), latest: addMinutes(eta, margin) },
    promised_by: state.promised_by,
    slack_min: slack,
    margin_min: margin,
    risk_score: score,
    risk_level: level,
    confidence,
    position_age_min: positionAge,
    factors,
    headline,
    stale: held || stale,
    tracking_lost: trackingLost,
    slowdown,
  };
}

function strip(f: DelayFactor): Factor {
  return { code: f.code, label: f.label, minutes: f.minutes };
}
