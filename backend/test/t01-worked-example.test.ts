// T1: DESIGN.md section 6.6 steps A, B and C, to the minute. Times in UTC (IST - 5:30).
import { describe, expect, it } from 'vitest';
import { computeEta } from '../src/eta/computeEta';
import type { EtaRoute, EtaState } from '../src/eta/types';
import { evaluateOptions } from '../src/options/evaluate';

const RTE_01: EtaRoute = {
  id: 'RTE-01',
  total_km: 150,
  segments: [
    { seq: 1, start_km: 0, end_km: 40, baseline_speed_kmph: 40, dwell_after_min: 0 },
    { seq: 2, start_km: 40, end_km: 100, baseline_speed_kmph: 60, dwell_after_min: 15 },
    { seq: 3, start_km: 100, end_km: 150, baseline_speed_kmph: 50, dwell_after_min: 0 },
  ],
};
const RTE_01B: EtaRoute = {
  id: 'RTE-01B',
  total_km: 166,
  segments: [
    { seq: 1, start_km: 0, end_km: 40, baseline_speed_kmph: 40, dwell_after_min: 0 },
    { seq: 2, start_km: 40, end_km: 66, baseline_speed_kmph: 60, dwell_after_min: 0 },
    { seq: 3, start_km: 66, end_km: 166, baseline_speed_kmph: 50, dwell_after_min: 0 },
  ],
};

// Positions every 5 minutes: 40 km/h on S1 (on time), then 40 km/h from km 40 at 09:00 (slow on S2).
function positionsUntil(untilUtc: string) {
  const out: { at: string; km: number }[] = [];
  for (let m = 0; ; m += 5) {
    const t = new Date(Date.parse('2026-11-16T02:30:00Z') + m * 60000).toISOString().replace('.000Z', 'Z');
    if (t > untilUtc) break;
    out.push({ at: t, km: (m * 40) / 60 });
  }
  return out;
}

function stateAt(nowUtc: string, extra: Partial<EtaState> = {}): EtaState {
  const positions = positionsUntil(nowUtc);
  const last = positions[positions.length - 1];
  return {
    shipment_id: 'SHP-1001',
    status: 'IN_TRANSIT',
    planned_departure: '2026-11-16T02:30:00Z',
    departed_at: '2026-11-16T02:30:00Z',
    promised_by: '2026-11-16T06:15:00Z',
    route: RTE_01,
    diverted_from: null,
    progress_km: last.km,
    position_at: last.at,
    positions,
    disruptions: [],
    previous: null,
    ...extra,
  };
}

const ACCIDENT = {
  id: '9b1d6c70-3c55-4f0e-8d0a-6f1f5a2c4e22',
  route_id: 'RTE-01',
  category: 'ACCIDENT',
  at_km: 75,
  expected_delay_min: 60,
  estimate_source: 'DRIVER' as const,
  reported_at: '2026-11-16T04:00:00Z',
};

describe('T1 worked example (DESIGN.md 6.6)', () => {
  it('planned: arrive 11:15 IST, 0 LOW', () => {
    const s = computeEta(
      { ...stateAt('2026-11-16T02:30:00Z'), status: 'DISPATCHED', progress_km: null, position_at: null, positions: [] },
      '2026-11-16T02:30:00Z',
    );
    expect(s.eta).toBe('2026-11-16T05:45:00Z');
    expect(s.slack_min).toBe(30);
    expect(s.margin_min).toBe(20);
    expect(s.risk_score).toBe(0);
    expect(s.risk_level).toBe('LOW');
  });

  it('step A at 09:15 IST: 11:45, slow traffic adds 25 min, 50 MEDIUM', () => {
    const s = computeEta(stateAt('2026-11-16T03:45:00Z'), '2026-11-16T03:45:00Z');
    expect(s.progress_km).toBe(50);
    expect(s.factors.map((f) => [f.code, f.minutes])).toEqual([
      ['BASE_TRAVEL', 110],
      ['DWELL', 15],
      ['CONGESTION', 25],
    ]);
    expect(s.eta).toBe('2026-11-16T06:15:00Z');
    expect(s.slack_min).toBe(0);
    expect(s.margin_min).toBe(20);
    expect(s.risk_score).toBe(50);
    expect(s.risk_level).toBe('MEDIUM');
    expect(s.confidence).toBe('MEDIUM');
    expect(s.headline).toBe('At risk: slow traffic adds 25 min');
  });

  it('step B at 09:30 IST: accident at km 75, 12:25, 100 HIGH, factors sum to 175', () => {
    const s = computeEta(stateAt('2026-11-16T04:00:00Z', { disruptions: [ACCIDENT] }), '2026-11-16T04:00:00Z');
    expect(s.progress_km).toBe(60);
    expect(s.factors).toEqual([
      { code: 'BASE_TRAVEL', label: 'Remaining drive at normal speed', minutes: 100 },
      { code: 'DWELL', label: 'Checkpoint stop at km 100', minutes: 15 },
      { code: 'ACCIDENT', label: 'Accident ahead at km 75 (driver estimate)', minutes: 60 },
    ]);
    expect(s.factors.reduce((a, f) => a + f.minutes, 0)).toBe(175);
    expect(s.eta).toBe('2026-11-16T06:55:00Z');
    expect(s.eta_window).toEqual({ earliest: '2026-11-16T06:35:00Z', latest: '2026-11-16T07:15:00Z' });
    expect(s.slack_min).toBe(-40);
    expect(s.margin_min).toBe(20);
    expect(s.risk_score).toBe(100);
    expect(s.risk_level).toBe('HIGH');
    expect(s.confidence).toBe('HIGH');
    expect(s.remaining_km).toBe(90);
    expect(s.headline).toBe('Expected 40 min late: accident ahead at km 75 adds 60 min');
  });

  it('step C at 09:30 IST: options and recommendation', () => {
    const now = '2026-11-16T04:00:00Z';
    const state = stateAt(now, { disruptions: [ACCIDENT] });
    const result = evaluateOptions({
      state,
      now,
      status: 'IN_TRANSIT',
      gross_t: 33,
      quantity_t: 24,
      original_promised_by: '2026-11-16T06:15:00Z',
      alternatives: [
        {
          alt_route_id: 'RTE-01B',
          exit_km: 66,
          name: 'Khalapur bypass',
          route: RTE_01B,
          total_km: 166,
          current_total_km: 150,
          max_gross_t: null,
          closed: false,
        },
      ],
      standby_vehicle_available: false,
      cost_per_km_inr: 45,
      standby_vehicle_cost_inr: 4000,
      split_min_quantity_t: 2,
      improvement_threshold_min: 10,
    });
    expect(result.recommended_option_id).toBe('OPT-REROUTE-RTE-01B');
    expect(result.options.map((o) => o.id)).toEqual(['OPT-REROUTE-RTE-01B', 'OPT-CONTINUE', 'OPT-RESCHEDULE', 'OPT-SPLIT']);
    const [reroute, cont, resched, split] = result.options;
    expect(reroute).toMatchObject({
      type: 'REROUTE',
      feasible: true,
      label: 'Reroute via Khalapur bypass (RTE-01B)',
      projected_eta: '2026-11-16T06:09:00Z',
      projected_late_min: 0,
      projected_risk_level: 'MEDIUM',
      improvement_min: 46,
      added_km: 16,
      added_cost_inr: 720,
      params: { alt_route_id: 'RTE-01B' },
    });
    expect(cont).toMatchObject({
      type: 'CONTINUE',
      projected_eta: '2026-11-16T06:55:00Z',
      projected_late_min: 40,
      projected_risk_level: 'HIGH',
      improvement_min: 0,
    });
    expect(resched).toMatchObject({
      type: 'RESCHEDULE',
      projected_eta: '2026-11-16T06:55:00Z',
      projected_late_min: 40,
      projected_risk_level: 'LOW',
      params: { new_agreed_delivery_by: '2026-11-16T07:15:00Z' },
    });
    expect(split).toMatchObject({
      type: 'SPLIT_SHIPMENT',
      feasible: false,
      infeasible_reason: 'Load is already in transit on one vehicle',
    });
  });
});
