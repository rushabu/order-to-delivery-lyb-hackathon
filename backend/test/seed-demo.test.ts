// The four-minute demo (DESIGN.md 10.5) replayed by the real engine on the real seed in database/seed.
// The other tests use test/fixtures-stub; this one proves the committed seed reproduces 6.6 end to end.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_FIXTURES_DIR } from '../src/sim/fixtures';
import { ACCIDENT_EVENT, COORD, CUST1, DRIVER1, makeApp, T, uuid, type TestApp } from './helpers';

let t: TestApp;
let c: string;
beforeEach(async () => {
  t = await makeApp({}, REAL_FIXTURES_DIR);
  c = await t.login(COORD);
  await t.req('POST', '/demo/scenarios/main/start', c);
});
afterEach(async () => {
  await t.close();
});

const shipment = async (id: string) => (await t.req('GET', `/shipments/${id}`, c)).body;
const openAlert = async (id: string) => (await t.req('GET', '/alerts?status=OPEN', c)).body.find((a: any) => a.shipment_id === id);
const factors = (snap: any) => Object.fromEntries(snap.factors.map((f: any) => [f.code, f.minutes]));

async function reportAccidentAt0930() {
  t.advanceTo(T['09:30']);
  expect((await t.req('POST', '/shipments/SHP-1001/events', await t.login(DRIVER1), ACCIDENT_EVENT)).status).toBe(201);
}

describe('real seed: SHP-1001 main story', () => {
  it('08:50 LOW; 09:15 MEDIUM with 11:45 from slow traffic; 09:30 HIGH with 12:25 after the accident', async () => {
    expect((await shipment('SHP-1001')).current_eta.risk_level).toBe('LOW');
    t.advanceTo(T['09:15']);
    const a = (await shipment('SHP-1001')).current_eta;
    expect([a.eta, a.risk_level, factors(a)]).toEqual(['2026-11-16T06:15:00Z', 'MEDIUM', { BASE_TRAVEL: 110, DWELL: 15, CONGESTION: 25 }]);
    await reportAccidentAt0930();
    const b = (await shipment('SHP-1001')).current_eta;
    expect([b.eta, b.risk_level, factors(b)]).toEqual(['2026-11-16T06:55:00Z', 'HIGH', { BASE_TRAVEL: 100, DWELL: 15, ACCIDENT: 60 }]);
  });

  it('options, approval and ledger: 11:39 predicted, 11:43 actual, 12:40 without action, 57 min avoided', async () => {
    await reportAccidentAt0930();
    const alert = await openAlert('SHP-1001');
    const opts = (await t.req('GET', `/alerts/${alert.id}/options`, c)).body;
    expect(opts.recommended_option_id).toBe('OPT-REROUTE-RTE-01B');
    expect(opts.options.find((o: any) => o.id === 'OPT-REROUTE-RTE-01B')).toMatchObject({
      label: 'Reroute via Pune-Shikrapur road (RTE-01B)', projected_eta: '2026-11-16T06:09:00Z', added_km: 16, added_cost_inr: 720, improvement_min: 46,
    });
    const res = await t.req('POST', '/shipments/SHP-1001/decisions', c, { decision_id: uuid(), option_set_id: opts.id, option_id: opts.recommended_option_id });
    expect(res.status).toBe(201);
    const custNote = (await t.req('GET', '/notifications', await t.login(CUST1))).body[0];
    expect(custNote.body).toContain('11:39 IST');
    t.advanceTo('2026-11-16T07:30:00Z');
    const s = await shipment('SHP-1001');
    expect(s.status).toBe('DELIVERED');
    const ledger = (await t.req('GET', '/decisions?shipment_id=SHP-1001', c)).body;
    expect(ledger[0].outcome).toMatchObject({
      actual_arrival: '2026-11-16T06:13:00Z',
      on_time_against_original_promise: true,
      eta_error_min: 4,
      counterfactual_no_action_arrival: '2026-11-16T07:10:00Z',
      delay_avoided_min: 57,
    });
  });
});

describe('real seed: the driver screen report has no location', () => {
  it('places the accident 15 km ahead (km 75), so the reroute is still recommended', async () => {
    t.advanceTo(T['09:30']);
    const report = { event_id: uuid(), type: 'DISRUPTION_REPORTED', payload: { disruption_id: uuid(), category: 'ACCIDENT', expected_delay_min: 60 } };
    expect((await t.req('POST', '/shipments/SHP-1001/events', await t.login(DRIVER1), report)).status).toBe(201);
    const s = await shipment('SHP-1001');
    expect(s.active_disruptions[0].at_km).toBe(75);
    expect(s.current_eta.eta).toBe('2026-11-16T06:55:00Z');
    const opts = (await t.req('GET', `/alerts/${(await openAlert('SHP-1001')).id}/options`, c)).body;
    expect(opts.recommended_option_id).toBe('OPT-REROUTE-RTE-01B');
    expect(opts.options.find((o: any) => o.id === 'OPT-REROUTE-RTE-01B').projected_eta).toBe('2026-11-16T06:09:00Z');
  });
});

describe('real seed: SHP-1002 and SHP-1003', () => {
  it('SHP-1002 is HIGH after the scripted weather report; reroute barred by weight; RESCHEDULE recommended', async () => {
    expect((await shipment('SHP-1002')).current_eta.risk_level).toBe('LOW');
    t.advanceTo('2026-11-16T04:05:00Z'); // 09:35 IST
    expect((await shipment('SHP-1002')).current_eta.risk_level).toBe('HIGH');
    const alert = await openAlert('SHP-1002');
    const opts = (await t.req('GET', `/alerts/${alert.id}/options`, c)).body;
    expect(opts.recommended_option_id).toBe('OPT-RESCHEDULE');
    const reroute = opts.options.find((o: any) => o.type === 'REROUTE');
    expect(reroute.feasible).toBe(false);
    expect(reroute.infeasible_reason).toMatch(/20 t/);
  });

  it('SHP-1003 has an open alert at reset and the split is feasible and recommended', async () => {
    const alert = await openAlert('SHP-1003');
    expect(alert).toBeDefined();
    const opts = (await t.req('GET', `/alerts/${alert.id}/options`, c)).body;
    expect(opts.options.find((o: any) => o.type === 'SPLIT_SHIPMENT').feasible).toBe(true);
    expect(opts.recommended_option_id).toBe('OPT-SPLIT');
  });
});
