// Truck choice for a new order: share a planned truck to the same customer when the rules allow,
// otherwise a separate truck; the coordinator approves. Runs on the real seed at the 08:50 start:
//   SHP-1004 (Deccan, CUS-01): planned for 17 Nov, 28 t truck carrying 20 t, promised 13:00
//   SHP-1001 (Deccan): already on the road
//   SHP-1003 / SHP-1005 (Godavari, CUS-02): planned, 2 t and 6 t spare
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REAL_FIXTURES_DIR } from '../src/sim/fixtures';
import { COORD, CUST1, DRIVER1, makeApp, type TestApp } from './helpers';

const DEEPAK = 'USR-DRV-06'; // idle in the seed: no scripted trip

const DECCAN = 'CUS-01';
const order = (over: Record<string, unknown> = {}) => ({
  customer_id: DECCAN,
  product: 'Polypropylene homopolymer, bagged',
  quantity_t: 6,
  promised_by: '2026-11-17T09:30:00Z', // 17 Nov 15:00 IST
  ...over,
});

describe('new orders and truck choice', () => {
  let t: TestApp;
  let coord: string;
  beforeEach(async () => {
    t = await makeApp({}, REAL_FIXTURES_DIR);
    coord = await t.login(COORD);
  });
  afterEach(() => t.close());

  const plan = async (over: Record<string, unknown> = {}) => (await t.req('POST', '/orders/plan', coord, order(over))).body;
  const option = (p: any, id: string) => p.options.find((o: any) => o.id === id);

  it('shows Kasara truck availability when the Wada gross limit blocks the load', async () => {
    const load = { customer_id: 'CUS-02', route_id: 'RTE-02B', quantity_t: 15 };
    const wada = await plan(load);
    expect(wada.routes).toEqual([
      { id: 'RTE-02', eligible_options: expect.any(Number) },
      { id: 'RTE-02B', eligible_options: 0 },
    ]);
    expect(wada.routes[0].eligible_options).toBeGreaterThan(0);
    expect(wada.options.some((o: any) => o.feasible)).toBe(false);
    const kasara = await plan({ ...load, route_id: 'RTE-02' });
    expect(kasara.recommended_option_id).toBeTruthy();
    const customer = await t.login('USR-CUST-03');
    expect((await t.req('GET', '/routes/RTE-02B', customer)).status).toBe(200);
    expect((await t.req('GET', '/routes/RTE-01', customer)).status).toBe(404);
  });

  it('recommends the planned truck to the same customer, and explains every candidate', async () => {
    const p = await plan();
    // Never another customer's truck; one separate-truck option per idle driver, by name. Ravi, Gurpreet and Sunil have trips.
    expect(p.options.map((o: any) => o.id)).toEqual(['ADD-SHP-1001', 'ADD-SHP-1004', 'NEW-USR-DRV-06', 'NEW-USR-DRV-05', 'NEW-USR-DRV-04']);
    expect(p.recommended_option_id).toBe('ADD-SHP-1004');
    expect(option(p, 'ADD-SHP-1004')).toMatchObject({
      type: 'ADD_TO_TRUCK', feasible: true, recommended: true, shipment_id: 'SHP-1004', vehicle_reg: 'MH 99 SB 4385',
      capacity_t: 28, load_after_t: 26, spare_after_t: 2, km_saved: 150, cost_saved_inr: 6750, // 150 km at INR 45 per km
    });
    expect(option(p, 'ADD-SHP-1004').margin_min).toBeGreaterThan(0);
    expect(option(p, 'ADD-SHP-1001')).toMatchObject({ feasible: false, infeasible_reason: 'This truck has already left the plant' });
    // Each driver gets the smallest free vehicle of their transporter that fits, planned to arrive an hour before the promise.
    expect(option(p, 'NEW-USR-DRV-06')).toMatchObject({
      type: 'NEW_TRUCK', feasible: true, recommended: false, vehicle_reg: 'MH 99 KR 3048', capacity_t: 20, spare_after_t: 14, km_saved: null, driver_name: 'Deepak More',
    });
    expect(option(p, 'NEW-USR-DRV-06').margin_min).toBeGreaterThanOrEqual(55);
    expect(option(p, 'NEW-USR-DRV-05')).toMatchObject({ vehicle_reg: 'MH 99 KR 3315', driver_name: 'Imran Shaikh' });
    expect(option(p, 'NEW-USR-DRV-04')).toMatchObject({ vehicle_reg: 'MH 99 SB 6131', driver_name: 'Prakash Jadhav' });
    const offered = p.options.filter((o: any) => o.type === 'NEW_TRUCK' && o.vehicle_reg).map((o: any) => o.vehicle_reg);
    expect(new Set(offered).size).toBe(offered.length); // no truck offered twice
    // Planning changes nothing.
    expect((await t.req('GET', '/shipments', coord)).body.some((s: any) => s.id.startsWith('SHP-2'))).toBe(false);
    expect((await t.req('GET', '/shipments/SHP-1004', coord)).body.quantity_t).toBe(20);
  });

  it('gives the reason when a truck cannot take the order, and falls back to a separate truck', async () => {
    const tooBig = await plan({ quantity_t: 9 });
    expect(option(tooBig, 'ADD-SHP-1004').infeasible_reason).toBe('Only 8 t spare: a 28 t truck already carrying 20 t');
    expect(tooBig.recommended_option_id).toMatch(/^NEW-USR-DRV-/);

    const tooEarly = await plan({ promised_by: '2026-11-17T06:30:00Z' }); // 12:00 IST, before the truck's own 13:00 promise
    expect(option(tooEarly, 'ADD-SHP-1004').infeasible_reason).toBe("This order is promised before the truck's own promise of 13:00 IST");
    expect(tooEarly.recommended_option_id).toMatch(/^NEW-USR-DRV-/);

    const huge = await plan({ quantity_t: 30 });
    expect(option(huge, 'NEW-USR-DRV-06')).toMatchObject({ feasible: false, infeasible_reason: 'No free Konkan Roadlines truck can carry 30 t' });
    expect(huge.recommended_option_id).toBeNull();
  });

  it('approving the shared truck adds the order to it: load, customer view, notification and invoice', async () => {
    const made = await t.req('POST', '/orders', coord, { ...order(), option_id: 'ADD-SHP-1004' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ order_id: 'ORD-6001', shipment_id: 'SHP-1004' });

    const s = (await t.req('GET', '/shipments/SHP-1004', coord)).body;
    expect(s).toMatchObject({ quantity_t: 26, gross_t: 36.8, status: 'PLANNED' });
    expect(s.order.id).toBe('ORD-5004');
    expect(s.extra_orders).toEqual([{ id: 'ORD-6001', product: 'Polypropylene homopolymer, bagged', quantity_t: 6, promised_by: '2026-11-17T09:30:00Z' }]);

    const cust = await t.login(CUST1);
    expect((await t.req('GET', '/shipments/SHP-1004', cust)).body.extra_orders).toHaveLength(1);
    const note = (await t.req('GET', '/notifications', cust)).body.find((n: any) => n.kind === 'ORDER_CONFIRMED');
    expect(note).toMatchObject({ shipment_id: 'SHP-1004', title: 'Order ORD-6001 confirmed' });
    expect(note.body).toContain('will travel with order ORD-5004 on MH 99 SB 4385');

    // The truck now has 2 t spare, so the same order again no longer fits and the stale approval is refused.
    const again = await t.req('POST', '/orders', coord, { ...order(), option_id: 'ADD-SHP-1004' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'ORDER_PLAN_STALE', message: 'Only 2 t spare: a 28 t truck already carrying 26 t' });

    // One invoice for the truck, one line per order: 20 t copolymer + 6 t homopolymer.
    expect((await t.req('POST', '/shipments/SHP-1004/invoice/generate', coord)).status).toBe(201);
    const pdf = (await t.app.inject({ method: 'GET', url: '/api/v1/shipments/SHP-1004/invoice', headers: { authorization: `Bearer ${cust}` } })).rawPayload.toString('latin1');
    for (const part of ['(ORD-5004: Polypropylene copolymer, bagged)', '(ORD-6001: Polypropylene homopolymer, bagged)', '(20.00)', '(6.00)', '(28,64,000.00)', '(33,79,520.00)']) {
      expect(pdf, part).toContain(part);
    }
  });

  it('approving a separate truck creates a planned shipment with an ETA, and that vehicle is then taken', async () => {
    const made = await t.req('POST', '/orders', coord, { ...order({ quantity_t: 9 }), option_id: 'NEW-USR-DRV-06' });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ order_id: 'ORD-6001', shipment_id: 'SHP-2001' });
    const s = (await t.req('GET', '/shipments/SHP-2001', coord)).body;
    expect(s).toMatchObject({ status: 'PLANNED', vehicle_reg: 'MH 99 KR 3048', quantity_t: 9, gross_t: 17.2, planned_route_id: 'RTE-01', extra_orders: [] });
    expect(s.driver.name).toBe('Deepak More');
    expect(s.current_eta.eta).toBe(made.body.option.eta); // the preview showed exactly what was created
    expect((await t.req('GET', '/shipments/SHP-2001', await t.login(CUST1))).status).toBe(200);
    // The driver is told and sees the new trip.
    const drv = await t.login(DEEPAK);
    expect((await t.req('GET', '/notifications', drv)).body.find((n: any) => n.kind === 'NEW_TRIP')).toMatchObject({ shipment_id: 'SHP-2001', title: 'New trip SHP-2001' });
    expect((await t.req('GET', '/shipments', drv)).body.map((x: any) => x.id)).toContain('SHP-2001');
    // Deepak is no longer idle, so he is not offered again; the next order can share his truck instead.
    const next = await plan({ quantity_t: 3 });
    expect(option(next, 'NEW-USR-DRV-06')).toBeUndefined();
    expect(option(next, 'NEW-USR-DRV-05').vehicle_reg).toBe('MH 99 KR 3315');
    expect(option(next, 'ADD-SHP-2001')).toMatchObject({ feasible: true, spare_after_t: 8 });
  });

  it('lets a customer order for their own company with an idle driver, and tells the coordinators', async () => {
    const cust = await t.login(CUST1);
    const form = (await t.req('GET', '/orders/new', cust)).body;
    expect(form.customers.map((c: any) => c.id)).toEqual(['CUS-01']); // only their own company
    const p = (await t.req('POST', '/orders/plan', cust, order())).body;
    expect(p.options.map((o: any) => o.id)).toEqual(['NEW-USR-DRV-06', 'NEW-USR-DRV-05', 'NEW-USR-DRV-04']); // drivers only, no truck sharing
    expect((await t.req('POST', '/orders/plan', cust, order({ customer_id: 'CUS-02' }))).status).toBe(403);
    expect((await t.req('POST', '/orders', cust, { ...order(), option_id: 'ADD-SHP-1004' })).status).toBe(422); // sharing is the coordinator's call

    const made = await t.req('POST', '/orders', cust, { ...order(), option_id: 'NEW-USR-DRV-04' });
    expect(made.status).toBe(201);
    expect(made.body.option.driver_name).toBe('Prakash Jadhav');
    const placed = (await t.req('GET', '/notifications', coord)).body.find((n: any) => n.kind === 'ORDER_PLACED');
    expect(placed).toMatchObject({ shipment_id: made.body.shipment_id, title: `Deccan Mouldings Pvt Ltd placed order ${made.body.order_id}` });
    expect((await t.req('GET', '/notifications', await t.login('USR-DRV-04'))).body.some((n: any) => n.kind === 'NEW_TRIP')).toBe(true);
    expect((await t.req('GET', '/shipments', cust)).body.map((x: any) => x.id)).toContain(made.body.shipment_id);
  });

  it('is for coordinators and customers only, validates input, and a reset removes the new orders', async () => {
    expect((await t.req('POST', '/orders/plan', await t.login(DRIVER1), order())).status).toBe(403);
    expect((await t.req('POST', '/orders', await t.login(DRIVER1), { ...order(), option_id: 'NEW-USR-DRV-06' })).status).toBe(403);
    expect((await t.req('POST', '/orders/plan', coord, order({ customer_id: 'CUS-99' }))).status).toBe(422);
    expect((await t.req('POST', '/orders/plan', coord, order({ quantity_t: 0 }))).status).toBe(422);
    expect((await t.req('POST', '/orders/plan', coord, order({ promised_by: '2026-11-16T03:00:00Z' }))).body.error.message).toBe('The promised delivery time must be in the future');
    expect((await t.req('POST', '/orders', coord, { ...order(), option_id: 'ADD-SHP-1002' })).status).toBe(422); // another customer's truck is not an option

    const form = (await t.req('GET', '/orders/new', coord)).body;
    expect(form.now).toBe('2026-11-16T03:20:00Z');
    expect(form.customers).toEqual([
      { id: 'CUS-01', name: 'Deccan Mouldings Pvt Ltd', deliver_to: 'Deccan Mouldings, Ranjangaon MIDC' },
      { id: 'CUS-02', name: 'Godavari Flexipack Pvt Ltd', deliver_to: 'Godavari Flexipack, Satpur MIDC' },
      { id: 'CUS-03', name: 'Plant X Demo Customer · Vikhroli', deliver_to: 'Vikhroli West, Mumbai · Sample receiving bay' },
      { id: 'CUS-04', name: 'Plant X Demo Customer · Powai', deliver_to: 'Powai, Mumbai · Sample receiving bay' },
      { id: 'CUS-05', name: 'Plant X Demo Customer · Chakan', deliver_to: 'Chakan MIDC, Pune district · Bulk receiving gate' },
    ]);
    expect(form.products).toContain('HDPE pellets, bagged');

    await t.req('POST', '/orders', coord, { ...order(), option_id: 'ADD-SHP-1004' });
    await t.req('POST', '/demo/reset', coord);
    expect((await t.req('GET', '/shipments/SHP-1004', coord)).body).toMatchObject({ quantity_t: 20, extra_orders: [] });
  });
});
