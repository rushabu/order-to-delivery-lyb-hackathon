// Check 5: RTE-01 segments plus the SHP-1001 ground truth reproduce DESIGN.md section 6.6.
// Plain arithmetic only (test/eta-reference.ts); no backend involved.
import { describe, expect, it } from 'vitest';
import { addMin, istHhmm, minutesBetween, simulateBranch, timeAtKm } from '../scripts/seed-lib';
import { computeEta, evaluateOptions, positions, type Disruption } from './eta-reference';
import { alternatives, at, cfg, live, promiseOf, routes, sc } from './helpers';

const src = sc.ground_truth['SHP-1001'].derived_from;
const shp = live.get('SHP-1001');
const promise = promiseOf('SHP-1001');
const ref = sc.reference_human_events[0];
const accident: Disruption = { ...ref.payload, reported_at: at('09:30') };

function snapshot(hhmm: string, disruptions: Disruption[] = []) {
  const now = at(hhmm);
  const pos = positions(src, 'RTE-01', now, cfg.demo.position_interval_min);
  const snap = computeEta(cfg, routes.get('RTE-01'), {
    status: 'IN_TRANSIT', progress_km: pos.at(-1)!.km, pos, disruptions, planned_departure: shp.planned_departure, promised_by: promise, now,
  });
  return { pos, snap };
}

describe('DESIGN.md 6.6 worked example', () => {
  it('ground truth: km 40 at 09:00, km 50 at 09:15, km 60 at 09:30', () => {
    const pts = simulateBranch(src.branches['RTE-01'], src.departure);
    expect([40, 50, 60].map((km) => istHhmm(addMin(src.departure, timeAtKm(pts, 'RTE-01', km))))).toEqual(['09:00', '09:15', '09:30']);
  });

  it('reset at 08:50: near km 33, LOW, ETA 11:15', () => {
    const { pos, snap } = snapshot('08:50');
    expect(Math.round(pos.at(-1)!.km * 10) / 10).toBe(33.3);
    expect([snap.risk_level, istHhmm(snap.eta)]).toEqual(['LOW', '11:15']);
  });

  it('step A, 09:15: ETA 11:45 from 110 + 15 + 25 min, MEDIUM, confidence MEDIUM', () => {
    const { snap } = snapshot('09:15');
    expect(snap.factors).toEqual({ BASE_TRAVEL: 110, DWELL: 15, CONGESTION: 25 });
    expect([istHhmm(snap.eta), snap.slack_min, snap.margin_min, snap.risk_score, snap.risk_level, snap.confidence])
      .toEqual(['11:45', 0, 20, 50, 'MEDIUM', 'MEDIUM']);
  });

  it('risk first turns MEDIUM on the 09:15 position (lead time 150 min)', () => {
    expect(['08:50', '08:55', '09:00', '09:05', '09:10'].map((t) => snapshot(t).snap.risk_level)).toEqual(Array(5).fill('LOW'));
    expect(['09:15', '09:20', '09:25'].map((t) => snapshot(t).snap.risk_level)).toEqual(Array(3).fill('MEDIUM'));
  });

  it('step B, 09:30 after the report: ETA 12:25 from 100 + 15 + 60 = 175 min, HIGH', () => {
    const { pos, snap } = snapshot('09:30', [accident]);
    expect(pos.at(-1)!.km).toBe(60);
    expect(snap.factors).toEqual({ BASE_TRAVEL: 100, DWELL: 15, ACCIDENT: 60 });
    expect([istHhmm(snap.eta), snap.slack_min, snap.risk_score, snap.risk_level, snap.confidence]).toEqual(['12:25', -40, 100, 'HIGH', 'HIGH']);
  });

  it('step C: reroute 11:39, +16 km, ₹720, 46 min better, recommended; split unavailable', () => {
    const { pos, snap } = snapshot('09:30', [accident]);
    const { options, recommended } = evaluateOptions(cfg, routes, alternatives, sc.standby_vehicles, shp, {
      progress_km: pos.at(-1)!.km, slowdown: 1.5, current: snap, disruptions: [accident], promised_by: promise, now: at('09:30'),
    });
    const byType = Object.fromEntries(options.map((o: any) => [o.type, o]));
    const r = byType.REROUTE;
    expect([r.feasible, istHhmm(r.eta), r.added_km, r.cost, r.late_min, r.improvement_min, r.risk.risk_score, r.risk.risk_level])
      .toEqual([true, '11:39', 16, 720, 0, 46, 35, 'MEDIUM']);
    expect(istHhmm(byType.RESCHEDULE.new_agreed_delivery_by)).toBe('12:45');
    expect([byType.SPLIT_SHIPMENT.feasible, byType.SPLIT_SHIPMENT.reason]).toEqual([false, 'Load is already in transit on one vehicle']);
    expect(recommended.type).toBe('REROUTE');
  });

  it('step D: continue arrives 12:40, reroute 11:43, exit passed at 09:39', () => {
    const cont = simulateBranch(src.branches['RTE-01'], src.departure);
    const rer = simulateBranch(src.branches['RTE-01B'], src.departure);
    expect(istHhmm(addMin(src.departure, cont.at(-1)!.t))).toBe('12:40');
    expect(istHhmm(addMin(src.departure, rer.at(-1)!.t))).toBe('11:43');
    expect(istHhmm(addMin(src.departure, timeAtKm(rer, 'RTE-01', 66)))).toBe('09:39');
    // The waypoints the backend replays end at the same times.
    const gt = sc.ground_truth['SHP-1001'];
    expect([istHhmm(gt.branches['RTE-01'].at(-1).at), istHhmm(gt.branches['RTE-01B'].at(-1).at)]).toEqual(['12:40', '11:43']);
  });

  it('impact figures', () => {
    expect(minutesBetween(at('11:43'), at('12:40'))).toBe(57); // delay avoided
    expect(minutesBetween(at('11:39'), at('11:43'))).toBe(4); // ETA error at decision
    expect(minutesBetween(at('09:15'), promise)).toBe(150); // coordinator lead time
    expect(minutesBetween(at('09:30'), promise)).toBe(135); // customer lead time
  });
});
