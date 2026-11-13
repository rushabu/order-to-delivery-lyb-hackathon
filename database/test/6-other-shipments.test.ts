// Check 6: SHP-1002 meets every condition under DESIGN.md 6.3 to 6.7; also the split case and quiet shipments.
import { describe, expect, it } from 'vitest';
import { addMin, istHhmm, minutesBetween, simulateBranch } from '../scripts/seed-lib';
import { computeEta, evaluateOptions, positions, type Disruption } from './eta-reference';
import { alternatives, at, cfg, live, orders, promiseOf, routes, sc } from './helpers';

const ev = sc.scripted_events[0];
const weather: Disruption = { ...ev.payload, reported_at: ev.at };

function state1002(hhmm: string, withReport = true) {
  const now = at(hhmm);
  const pos = positions(sc.ground_truth['SHP-1002'].derived_from, 'RTE-02', now, cfg.demo.position_interval_min);
  const disruptions = withReport ? [weather] : [];
  const snap = computeEta(cfg, routes.get('RTE-02'), {
    status: 'IN_TRANSIT', progress_km: pos.at(-1)!.km, pos, disruptions,
    planned_departure: live.get('SHP-1002').planned_departure, promised_by: promiseOf('SHP-1002'), now,
  });
  return { now, pos, snap, disruptions };
}

describe('SHP-1002: alternative unavailable', () => {
  it('set-up: 34 t gross on RTE-02, RTE-02B limited to 20 t, different driver from SHP-1001', () => {
    const s = live.get('SHP-1002');
    expect([s.route_id, s.transporter_id, s.gross_t, s.status]).toEqual(['RTE-02', 'TRN-02', 34, 'IN_TRANSIT']);
    expect(routes.get('RTE-02B').restrictions.max_gross_t).toBe(20);
    expect(s.driver_user_id).not.toBe(live.get('SHP-1001').driver_user_id);
  });

  it('LOW until the scripted report', () => {
    expect(['08:50', '09:00', '09:15'].map((t) => state1002(t, false).snap.risk_level)).toEqual(['LOW', 'LOW', 'LOW']);
  });

  it('scripted WEATHER report with an estimate fires before 09:35', () => {
    expect([ev.shipment_id, ev.type, ev.payload.category]).toEqual(['SHP-1002', 'DISRUPTION_REPORTED', 'WEATHER']);
    expect(ev.payload.expected_delay_min).toBeGreaterThan(0);
    expect(minutesBetween(ev.at, at('09:35'))).toBeGreaterThan(0);
  });

  it.each(['09:20', '09:25', '09:30', '09:35'])('HIGH with an open alert and before the exit at %s', (hhmm) => {
    const { pos, snap } = state1002(hhmm);
    expect(snap.risk_level).toBe('HIGH');
    expect(pos.at(-1)!.km).toBeLessThan(46);
  });

  it('options: reroute barred by weight, split unavailable, nothing improves 10 min, RESCHEDULE recommended', () => {
    const { now, pos, snap, disruptions } = state1002('09:35');
    const { options, recommended } = evaluateOptions(cfg, routes, alternatives, sc.standby_vehicles, live.get('SHP-1002'), {
      progress_km: pos.at(-1)!.km, slowdown: 1, current: snap, disruptions, promised_by: promiseOf('SHP-1002'), now,
    });
    const byType = Object.fromEntries(options.map((o: any) => [o.type, o]));
    expect([byType.REROUTE.feasible, byType.REROUTE.reason]).toEqual([false, 'Gross weight 34 t exceeds the 20 t limit on RTE-02B']);
    expect([byType.SPLIT_SHIPMENT.feasible, byType.SPLIT_SHIPMENT.reason]).toEqual([false, 'Load is already in transit on one vehicle']);
    expect(options.filter((o: any) => o.feasible).every((o: any) => o.improvement_min < cfg.options.improvement_threshold_min)).toBe(true);
    expect(recommended.type).toBe('RESCHEDULE');
  });

  it('ground truth arrives 13:42, 42 min late against the original promise', () => {
    const src = sc.ground_truth['SHP-1002'].derived_from;
    const arrival = addMin(src.departure, simulateBranch(src.branches['RTE-02'], src.departure).at(-1)!.t);
    expect(istHhmm(arrival)).toBe('13:42');
    expect(minutesBetween(promiseOf('SHP-1002'), arrival)).toBe(42);
  });
});

describe('SHP-1003: split shipment', () => {
  it('PLANNED, at least 20 t, MEDIUM at reset; split feasible and recommended', () => {
    const s = live.get('SHP-1003');
    const now = sc.clock_start;
    const snap = computeEta(cfg, routes.get('RTE-02'), {
      status: 'PLANNED', progress_km: 0, pos: [], disruptions: s.disruptions, planned_departure: s.planned_departure, promised_by: promiseOf('SHP-1003'), now,
    });
    expect([s.status, s.quantity_t >= 20, snap.risk_level]).toEqual(['PLANNED', true, 'MEDIUM']);
    const { options, recommended } = evaluateOptions(cfg, routes, alternatives, sc.standby_vehicles, s, {
      progress_km: 0, slowdown: null, current: snap, disruptions: s.disruptions, promised_by: promiseOf('SHP-1003'), now,
    });
    const split = options.find((o: any) => o.type === 'SPLIT_SHIPMENT');
    expect(split.feasible).toBe(true);
    expect(split.improvement_min).toBeGreaterThanOrEqual(cfg.options.improvement_threshold_min);
    expect(recommended.type).toBe('SPLIT_SHIPMENT');
  });
});

describe('quiet shipments', () => {
  it.each(['SHP-1004', 'SHP-1005'])('%s is LOW at reset', (id) => {
    const s = live.get(id);
    const snap = computeEta(cfg, routes.get(s.route_id), {
      status: s.status, progress_km: 0, pos: [], disruptions: [], planned_departure: s.planned_departure, promised_by: promiseOf(id), now: sc.clock_start,
    });
    expect(snap.risk_level).toBe('LOW');
  });

  it('each customer has shipments the other customer must not see', () => {
    const byCustomer: Record<string, string[]> = {};
    for (const s of live.values()) (byCustomer[orders.get(s.order_id).customer_id] ??= []).push(s.id);
    expect(Object.keys(byCustomer).sort()).toEqual(['CUS-01', 'CUS-02']);
    expect(Object.values(byCustomer).every((ids) => ids.length >= 2)).toBe(true);
  });
});
