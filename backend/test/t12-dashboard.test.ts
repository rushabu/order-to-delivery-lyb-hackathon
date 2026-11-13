// T12: dashboard totals equal a direct count over fixtures plus replay (DESIGN.md 10.2, 10.3).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixtures, STUB_FIXTURES_DIR } from '../src/sim/fixtures';
import { ACCIDENT_EVENT, COORD, DRIVER1, makeApp, T, type TestApp } from './helpers';

const fx = loadFixtures(STUB_FIXTURES_DIR);
let t: TestApp;
let c: string;

beforeAll(async () => {
  t = await makeApp();
  c = await t.login(COORD);
  await t.req('POST', '/demo/scenarios/main/start', c);
  t.advanceTo(T['09:30']);
  await t.req('POST', '/shipments/SHP-1001/events', await t.login(DRIVER1), ACCIDENT_EVENT);
  const opts = (await t.req('GET', '/alerts/ALT-0001/options', c)).body;
  await t.req('POST', '/shipments/SHP-1001/decisions', c, {
    decision_id: 'c2a4e9d0-7b1f-4c3a-b6e2-0d9f8a7c6b55',
    option_set_id: opts.id,
    option_id: opts.recommended_option_id,
  });
  t.advanceTo('2026-11-16T07:30:00Z');
});
afterAll(async () => {
  await t.close();
});

describe('T12 dashboard', () => {
  it('on-time totals by route and by transporter equal a direct count of fixtures plus replay', async () => {
    // Direct count: history fixture plus the two replay shipments that arrived.
    const replay = [
      { route_id: 'RTE-01', transporter_id: 'TRN-01', arrived: '2026-11-16T06:13:00Z', promised: '2026-11-16T06:15:00Z' }, // SHP-1001
      { route_id: 'RTE-02', transporter_id: 'TRN-02', arrived: '2026-11-16T06:12:00Z', promised: '2026-11-16T06:00:00Z' }, // SHP-1002
    ];
    const all = [
      ...fx.history.map((h) => ({ route_id: h.route_id, transporter_id: h.transporter_id, arrived: h.actual_arrival, promised: h.original_promised_by })),
      ...replay,
    ];
    for (const groupBy of ['route', 'transporter'] as const) {
      const r = await t.req('GET', `/dashboard/on-time?group_by=${groupBy}`, c);
      expect(r.status).toBe(200);
      const key = groupBy === 'route' ? 'route_id' : 'transporter_id';
      const ids = [...new Set(all.map((x) => x[key]))].sort();
      expect(r.body.map((g: any) => g.group_id)).toEqual(ids);
      for (const g of r.body) {
        const mine = all.filter((x) => x[key] === g.group_id);
        expect(g.delivered).toBe(mine.length);
        expect(g.on_time).toBe(mine.filter((x) => x.arrived <= x.promised).length);
        expect(g.late).toBe(g.delivered - g.on_time);
      }
      expect(r.body.reduce((a: number, g: any) => a + g.delivered, 0)).toBe(all.length);
      expect(r.body.reduce((a: number, g: any) => a + g.on_time, 0)).toBe(all.filter((x) => x.arrived <= x.promised).length);
    }
  });

  it('delay-cause minutes include the history fixture and the replay shipments', async () => {
    const r = (await t.req('GET', '/dashboard/delay-causes?group_by=route', c)).body;
    const rte01 = r.find((g: any) => g.group_id === 'RTE-01');
    const historyRte01 = fx.history.filter((h) => h.route_id === 'RTE-01').flatMap((h) => h.delay_causes);
    const accident = rte01.minutes_by_cause.ACCIDENT;
    const historyAccident = historyRte01.filter((x) => x.cause === 'ACCIDENT').reduce((a, x) => a + x.minutes, 0);
    expect(accident).toBe(historyAccident + 60); // SHP-1001's accident added at most 60 min in any snapshot
    expect(rte01.total_min).toBe(Object.values<number>(rte01.minutes_by_cause).reduce((a, x) => a + x, 0));
  });

  it('impact metrics: lead time 150 min for SHP-1001, 57 min avoided', async () => {
    const m = (await t.req('GET', '/metrics/impact', c)).body;
    expect(m.warning_lead_time.per_shipment.find((x: any) => x.shipment_id === 'SHP-1001')).toMatchObject({
      first_alert_at: T['09:15'],
      lead_time_min: 150,
    });
    expect(m.delay_avoided.total_min).toBe(57);
    expect(m.delay_avoided_total_min).toBe(57); // the flat figure the dashboard reads
    expect(m.on_time_delivery).toEqual({ arrived: 2, with_decisions_pct: 50, without_decisions_pct: 0 });
    expect(m.cost_of_lateness_avoided).toMatchObject({ kind: 'MODELED_ESTIMATE', inr: 1425 });
    const drv = await t.login(DRIVER1);
    expect((await t.req('GET', '/metrics/impact', drv)).status).toBe(403);
  });
});
