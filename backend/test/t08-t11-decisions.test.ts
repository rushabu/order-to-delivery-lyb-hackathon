// Milestone M3: T8, T9, T10, T11 (DESIGN.md 5.7.3, 6.6 step C and D, 6.7, 6.8) and the T6 decision case.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCIDENT_EVENT, COORD, CUST1, DRIVER1, makeApp, T, uuid, type TestApp } from './helpers';

let t: TestApp;
let c: string;
beforeEach(async () => {
  t = await makeApp();
  c = await t.login(COORD);
  await t.req('POST', '/demo/scenarios/main/start', c);
});
afterEach(async () => {
  await t.close();
});

async function reportAccidentAt0930() {
  t.advanceTo(T['09:30']);
  const d = await t.login(DRIVER1);
  expect((await t.req('POST', '/shipments/SHP-1001/events', d, ACCIDENT_EVENT)).status).toBe(201);
}

const DECISION_ID = 'c2a4e9d0-7b1f-4c3a-b6e2-0d9f8a7c6b55';

describe('options for SHP-1001 (6.6 step C over HTTP)', () => {
  it('match the worked example', async () => {
    await reportAccidentAt0930();
    const r = await t.req('GET', '/alerts/ALT-0001/options', c);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      id: 'OPS-0001',
      alert_id: 'ALT-0001',
      shipment_id: 'SHP-1001',
      generated_at: T['09:30'],
      valid_until: '2026-11-16T04:10:00Z',
      recommended_option_id: 'OPT-REROUTE-RTE-01B',
    });
    const reroute = r.body.options[0];
    expect(reroute).toMatchObject({ id: 'OPT-REROUTE-RTE-01B', projected_eta: '2026-11-16T06:09:00Z', added_km: 16, added_cost_inr: 720, improvement_min: 46 });
    expect(r.body.options.find((o: any) => o.type === 'SPLIT_SHIPMENT')).toMatchObject({ feasible: false, infeasible_reason: 'Load is already in transit on one vehicle' });
    // Asking again returns the same, still-valid set.
    expect((await t.req('GET', '/alerts/ALT-0001/options', c)).body.id).toBe('OPS-0001');
  });
});

describe('T8 approve reroute', () => {
  it('changes the route, writes a snapshot, two notifications and an audit row; a repeat has no second effect', async () => {
    await reportAccidentAt0930();
    const opts = (await t.req('GET', '/alerts/ALT-0001/options', c)).body;
    const before = (await t.req('GET', '/shipments/SHP-1001', c)).body;
    const body = { decision_id: DECISION_ID, option_set_id: opts.id, option_id: 'OPT-REROUTE-RTE-01B', note: 'Bypass clear per transporter desk' };
    const res = await t.req('POST', '/shipments/SHP-1001/decisions', c, body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'DEC-0001',
      decision_id: DECISION_ID,
      shipment_id: 'SHP-1001',
      option_type: 'REROUTE',
      decided_by: 'USR-COORD-01',
      decided_at: T['09:30'],
      notifications_created: 2,
      predicted: { chosen_eta: '2026-11-16T06:09:00Z', no_action_eta: '2026-11-16T06:55:00Z' },
      outcome: null,
    });
    const after = (await t.req('GET', '/shipments/SHP-1001', c)).body;
    expect(after.active_route_id).toBe('RTE-01B');
    expect(after.current_eta.id).toBe(res.body.eta_snapshot_id);
    expect(after.current_eta.id).not.toBe(before.current_eta.id);
    expect(after.current_eta.eta).toBe('2026-11-16T06:09:00Z'); // 11:39 IST, same arithmetic as the option
    expect(after.current_eta.risk_level).toBe('MEDIUM');
    expect(after.version).toBe(before.version + 1);
    expect(after.open_alert).toBeNull(); // alert is DECIDED

    const custNotes = (await t.req('GET', '/notifications', await t.login(CUST1))).body;
    expect(custNotes[0]).toMatchObject({ kind: 'DECISION_APPLIED' });
    expect(custNotes[0].body).toContain('11:39 IST');
    const drvNotes = (await t.req('GET', '/notifications', await t.login(DRIVER1))).body;
    expect(drvNotes[0].body).toBe('New instruction: new route via Khalapur bypass; take the exit at km 66.');
    const auditRows = t.ctx.db.prepare(`SELECT * FROM audit_events WHERE action = 'DECISION_APPROVED'`).all() as any[];
    expect(auditRows).toHaveLength(1);
    expect(JSON.parse(auditRows[0].detail)).toMatchObject({ option_id: 'OPT-REROUTE-RTE-01B', coordinator: 'USR-COORD-01', note: 'Bypass clear per transporter desk' });

    const counts = () => t.ctx.db.prepare('SELECT (SELECT COUNT(*) FROM decisions) d, (SELECT COUNT(*) FROM notifications) n, (SELECT COUNT(*) FROM eta_snapshots) e').get();
    const c1 = counts();
    const again = await t.req('POST', '/shipments/SHP-1001/decisions', c, body);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(res.body);
    expect(counts()).toEqual(c1);
    // A different decision on the decided alert is refused.
    const other = await t.req('POST', '/shipments/SHP-1001/decisions', c, { ...body, decision_id: uuid(), option_id: 'OPT-CONTINUE' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('ALERT_ALREADY_DECIDED');
  });

  it('T6 (decision part): a customer posting a decision gets 403; infeasible option is 409', async () => {
    await reportAccidentAt0930();
    const opts = (await t.req('GET', '/alerts/ALT-0001/options', c)).body;
    const cu = await t.login(CUST1);
    const r = await t.req('POST', '/shipments/SHP-1001/decisions', cu, { decision_id: uuid(), option_set_id: opts.id, option_id: 'OPT-CONTINUE' });
    expect(r.status).toBe(403);
    expect((await t.req('GET', '/alerts/ALT-0001/options', cu)).status).toBe(403);
    const split = await t.req('POST', '/shipments/SHP-1001/decisions', c, { decision_id: uuid(), option_set_id: opts.id, option_id: 'OPT-SPLIT' });
    expect(split.status).toBe(409);
    expect(split.body.error.code).toBe('OPTION_INFEASIBLE');
  });
});

describe('T9 no-improvement case', () => {
  it('SHP-1002: reroute infeasible with the weight reason; recommendation is RESCHEDULE', async () => {
    t.advanceTo('2026-11-16T04:10:00Z'); // background weather report on SHP-1002
    const alerts = (await t.req('GET', '/alerts?status=OPEN', c)).body;
    const a = alerts.find((x: any) => x.shipment_id === 'SHP-1002');
    expect(a).toMatchObject({ id: 'ALT-0002', level: 'HIGH' });
    const opts = (await t.req('GET', `/alerts/${a.id}/options`, c)).body;
    const reroute = opts.options.find((o: any) => o.type === 'REROUTE');
    expect(reroute).toMatchObject({ feasible: false, infeasible_reason: 'Gross weight 34 t exceeds the 20 t limit on RTE-02B' });
    expect(opts.recommended_option_id).toBe('OPT-RESCHEDULE');
    expect(opts.recommendation_reason).toBe(
      'No available action brings this shipment back on time. Recommended: agree a new delivery time and inform the customer now.',
    );
    const resched = opts.options.find((o: any) => o.id === 'OPT-RESCHEDULE');
    const res = await t.req('POST', '/shipments/SHP-1002/decisions', c, { decision_id: uuid(), option_set_id: opts.id, option_id: 'OPT-RESCHEDULE' });
    expect(res.status).toBe(201);
    const d = (await t.req('GET', '/shipments/SHP-1002', c)).body;
    expect(d.order.agreed_delivery_by).toBe(resched.params.new_agreed_delivery_by);
    expect(d.order.original_promised_by).toBe('2026-11-16T06:00:00Z'); // never changes
    expect(d.current_eta.risk_level).toBe('LOW');
  });
});

describe('T10 stale options', () => {
  it('deciding on an expired option set is 409 OPTIONS_STALE', async () => {
    await reportAccidentAt0930();
    const opts = (await t.req('GET', '/alerts/ALT-0001/options', c)).body;
    t.advanceTo('2026-11-16T04:10:00Z'); // 10 minutes later: expired
    const r = await t.req('POST', '/shipments/SHP-1001/decisions', c, { decision_id: uuid(), option_set_id: opts.id, option_id: opts.recommended_option_id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OPTIONS_STALE');
    const fresh = (await t.req('GET', '/alerts/ALT-0001/options', c)).body;
    expect(fresh.id).not.toBe(opts.id);
  });

  it('a new disruption makes the set stale even inside 10 minutes', async () => {
    await reportAccidentAt0930();
    const opts = (await t.req('GET', '/alerts/ALT-0001/options', c)).body;
    await t.req('POST', '/shipments/SHP-1001/events', c, {
      event_id: uuid(),
      type: 'DISRUPTION_REPORTED',
      payload: { disruption_id: uuid(), category: 'WEATHER', at_km: 120 },
    });
    const r = await t.req('POST', '/shipments/SHP-1001/decisions', c, { decision_id: uuid(), option_set_id: opts.id, option_id: opts.recommended_option_id });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('OPTIONS_STALE');
  });
});

describe('T11 full replay with the scripted decision reproduces 6.6 step D', () => {
  it('ledger: predicted 11:39, actual 11:43, would have been 12:40, 57 min avoided', async () => {
    await reportAccidentAt0930();
    const opts = (await t.req('GET', '/alerts/ALT-0001/options', c)).body;
    await t.req('POST', '/shipments/SHP-1001/decisions', c, { decision_id: DECISION_ID, option_set_id: opts.id, option_id: opts.recommended_option_id });
    t.advanceTo('2026-11-16T07:30:00Z');
    const s = (await t.req('GET', '/shipments/SHP-1001', c)).body;
    expect(s.status).toBe('DELIVERED');
    expect(s.milestones.find((m: any) => m.status === 'ARRIVED').at).toBe('2026-11-16T06:13:00Z');
    const ledger = (await t.req('GET', '/decisions?shipment_id=SHP-1001', c)).body;
    expect(ledger).toHaveLength(1);
    expect(ledger[0].predicted).toEqual({ chosen_eta: '2026-11-16T06:09:00Z', no_action_eta: '2026-11-16T06:55:00Z' });
    expect(ledger[0].outcome).toEqual({
      actual_arrival: '2026-11-16T06:13:00Z',
      on_time_against_original_promise: true,
      eta_error_min: 4,
      counterfactual_no_action_arrival: '2026-11-16T07:10:00Z',
      delay_avoided_min: 57,
      counterfactual_kind: 'SIMULATED',
    });
    expect(ledger[0].options).toHaveLength(4);
    expect((await t.req('GET', `/decisions/${ledger[0].id}`, c)).body.outcome.delay_avoided_min).toBe(57);
    // The counterfactual ran without touching the database: SHP-1001 never had a position on RTE-01 past km 66.
    const maxKmOnRte01 = (t.ctx.db.prepare(`SELECT MAX(progress_km) k FROM shipment_events WHERE shipment_id = 'SHP-1001' AND route_id = 'RTE-01'`).get() as any).k;
    expect(maxKmOnRte01).toBeLessThanOrEqual(66);
  });
});

describe('SPLIT_SHIPMENT', () => {
  it('is feasible for the planned SHP-1003 with a loading delay and creates the balance shipment', async () => {
    // SHP-1003 is LOW, so no alert exists; open one by reporting a long loading delay as coordinator.
    await t.req('POST', '/shipments/SHP-1003/events', c, {
      event_id: uuid(),
      type: 'DISRUPTION_REPORTED',
      payload: { disruption_id: uuid(), category: 'LOADING_DELAY', expected_delay_min: 240 },
    });
    const alert = (await t.req('GET', '/alerts?status=OPEN', c)).body.find((a: any) => a.shipment_id === 'SHP-1003');
    expect(alert).toBeDefined();
    const opts = (await t.req('GET', `/alerts/${alert.id}/options`, c)).body;
    const split = opts.options.find((o: any) => o.type === 'SPLIT_SHIPMENT');
    expect(split.feasible).toBe(true);
    const res = await t.req('POST', '/shipments/SHP-1003/decisions', c, { decision_id: uuid(), option_set_id: opts.id, option_id: 'OPT-SPLIT' });
    expect(res.status).toBe(201);
    const original = (await t.req('GET', '/shipments/SHP-1003', c)).body;
    const balance = (await t.req('GET', '/shipments/SHP-1004', c)).body;
    expect(original.quantity_t + balance.quantity_t).toBe(16);
    expect(original.active_disruptions).toHaveLength(0);
    expect(balance.active_disruptions.length).toBeGreaterThan(0);
    expect(balance.vehicle_reg).toBe('MH-00-PX-2001');
  });
});
