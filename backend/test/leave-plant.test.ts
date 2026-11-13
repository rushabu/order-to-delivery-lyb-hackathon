// "Leave the plant": the assigned driver takes a planned trip straight to IN_TRANSIT.
// On the real seed at 08:50: SHP-1003 is PLANNED for driver 3; driver 1 is on the road with SHP-1001
// and also has SHP-1004 planned.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_FIXTURES_DIR } from '../src/sim/fixtures';
import { COORD, CUST1, DRIVER1, makeApp, uuid, type TestApp } from './helpers';

const DRIVER3 = 'USR-DRV-03';
const leave = () => ({ event_id: uuid(), type: 'MILESTONE', payload: { to_status: 'IN_TRANSIT' } });

it.each([
  ['USR-CUST-01', 'CUS-01', ['RTE-01', 'RTE-01B'], 6],
  ['USR-CUST-03', 'CUS-02', ['RTE-02', 'RTE-02B'], 6],
  ['USR-CUST-04', 'CUS-03', ['RTE-03'], 0.6],
  ['USR-CUST-05', 'CUS-04', ['RTE-04'], 0.6],
  ['USR-CUST-06', 'CUS-05', ['RTE-05'], 6],
] as const)('can book each configured road for %s with no preloaded orders', async (user, customer_id, routes, quantity_t) => {
  const app = await makeApp({ seedSampleOrders: false }, REAL_FIXTURES_DIR);
  try {
    const token = await app.login(user);
    expect((await app.req('GET', '/shipments', token)).body).toEqual([]);
    const form = (await app.req('GET', '/orders/new', token)).body;
    expect(form.routes.map((r: { id: string }) => r.id)).toEqual(routes);
    for (const route_id of routes) {
      expect((await app.req('GET', `/routes/${route_id}`, token)).status).toBe(200);
      const draft = { customer_id, route_id, quantity_t, product: form.products[0], promised_by: new Date(Date.now() + 86_400_000).toISOString() };
      const plan = await app.req('POST', '/orders/plan', token, draft);
      expect(plan.body.recommended_option_id).toBeTruthy();
      const created = await app.req('POST', '/orders', token, { ...draft, option_id: plan.body.recommended_option_id });
      expect(created.status).toBe(201);
      expect((await app.req('GET', `/shipments/${created.body.shipment_id}`, token)).body.active_route_id).toBe(route_id);
    }
  } finally { await app.close(); }
});

it('starts without sample orders and takes a new order on the chosen original route from planning to departure', async () => {
  const app = await makeApp({ seedSampleOrders: false }, REAL_FIXTURES_DIR);
  try {
    const c = await app.login(COORD);
    expect((await app.req('GET', '/shipments', c)).body).toEqual([]);
    const form = (await app.req('GET', '/orders/new', c)).body;
    expect(form.routes.map((r: { id: string }) => r.id)).toEqual(['RTE-01', 'RTE-01B', 'RTE-02', 'RTE-02B', 'RTE-03', 'RTE-04', 'RTE-05']);
    expect(form.products.length).toBeGreaterThan(0);
    const draft = { customer_id: 'CUS-01', route_id: 'RTE-01B', product: form.products[0], quantity_t: 6,
      promised_by: new Date(Date.now() + 86_400_000).toISOString() };
    expect((await app.req('POST', '/orders/plan', c, { ...draft, route_id: 'RTE-02' })).status).toBe(422);
    const plan = await app.req('POST', '/orders/plan', c, draft);
    expect(plan.status).toBe(200);
    const made = await app.req('POST', '/orders', c, { ...draft, option_id: plan.body.recommended_option_id });
    expect(made.status).toBe(201);
    const path = `/shipments/${made.body.shipment_id}`;
    const planned = (await app.req('GET', path, c)).body;
    expect(planned).toMatchObject({ status: 'PLANNED', active_route_id: 'RTE-01B' });
    const driver = await app.login(planned.driver.id);
    expect((await app.req('POST', `${path}/events`, driver, leave())).status).toBe(201);
    const customer = await app.login(CUST1);
    const moving = (await app.req('GET', path, customer)).body;
    expect(moving).toMatchObject({ status: 'IN_TRANSIT', active_route_id: 'RTE-01B', last_position: { progress_km: 0 } });
    expect(moving.milestones.map((m: { status: string }) => m.status)).toEqual(['PLANNED', 'DISPATCHED', 'IN_TRANSIT']);
    expect((await app.req('GET', '/notifications', customer)).body).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'DEPARTED', shipment_id: made.body.shipment_id }),
    ]));
  } finally { await app.close(); }
});

describe('driver leaves the plant', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await makeApp({}, REAL_FIXTURES_DIR);
  });
  afterEach(() => t.close());

  it('a planned trip goes to IN_TRANSIT, the dispatch is recorded with it, and plant and customer are told', async () => {
    const d3 = await t.login(DRIVER3);
    expect((await t.req('GET', '/shipments/SHP-1003', d3)).body.status).toBe('PLANNED');
    const res = await t.req('POST', '/shipments/SHP-1003/events', d3, leave());
    expect(res.status).toBe(201);
    expect(res.body.apply_status).toBe('APPLIED');

    const s = (await t.req('GET', '/shipments/SHP-1003', d3)).body;
    expect(s.status).toBe('IN_TRANSIT');
    // Left at the demo clock's 08:50; every stage is in the history, in order.
    expect(s.milestones.map((m: any) => [m.status, m.at])).toEqual([
      ['PLANNED', s.milestones[0].at],
      ['DISPATCHED', '2026-11-16T03:20:00Z'],
      ['IN_TRANSIT', '2026-11-16T03:20:00Z'],
    ]);
    // The ETA no longer waits for the planned 10:30 departure.
    expect(s.current_eta.factors.some((f: any) => f.code === 'DEPARTURE_WAIT')).toBe(false);

    for (const who of [COORD, 'USR-CUST-03']) {
      const note = (await t.req('GET', '/notifications', await t.login(who))).body.find((n: any) => n.kind === 'DEPARTED');
      expect(note, who).toMatchObject({ shipment_id: 'SHP-1003', title: 'ORD-5003 has left the plant' });
      expect(note.body).toContain('left at 08:50 IST');
    }
    // Tapping twice is harmless.
    expect((await t.req('POST', '/shipments/SHP-1003/events', d3, leave())).body.apply_status).toBe('DUPLICATE');
  });

  it('a driver cannot leave on a second trip while one is on the road', async () => {
    const d1 = await t.login(DRIVER1);
    const res = await t.req('POST', '/shipments/SHP-1004/events', d1, leave());
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'TRIP_IN_PROGRESS', message: 'Finish SHP-1001 before leaving on another trip' });
    expect((await t.req('GET', '/shipments/SHP-1004', d1)).body.status).toBe('PLANNED');
  });

  it('only the assigned driver can do it', async () => {
    expect((await t.req('POST', '/shipments/SHP-1003/events', await t.login(DRIVER1), leave())).status).toBe(403);
    expect((await t.req('POST', '/shipments/SHP-1003/events', await t.login(COORD), leave())).status).toBe(403);
    expect((await t.req('GET', '/shipments/SHP-1003', await t.login(COORD))).body.status).toBe('PLANNED');
  });
});
