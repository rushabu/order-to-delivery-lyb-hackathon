// Driver operations: start-of-shift checks, stops, check-ins, documents, trip log and stop detection.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectStops } from '../src/driverOps/routes';
import { COORD, CUST1, CUST2, DRIVER1, DRIVER2, makeApp, uuid, type TestApp } from './helpers';

let t: TestApp;
let c: string;
let d: string;
beforeEach(async () => {
  t = await makeApp();
  c = await t.login(COORD);
  d = await t.login(DRIVER1);
  await t.req('POST', '/demo/scenarios/main/start', c);
});
afterEach(async () => {
  await t.close();
});

const kinds = async (token: string) => (await t.req('GET', '/notifications', token)).body.map((n: any) => n.kind);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');

describe('start-of-shift checks', () => {
  it('records that each check passed and nothing else', async () => {
    expect((await t.req('GET', '/me/checks', d)).body.complete).toBe(false);
    expect((await t.req('POST', '/me/checks', d, { kind: 'LICENCE', licence_number: 'MH01' })).status).toBe(422); // no extra data accepted
    await t.req('POST', '/me/checks', d, { kind: 'LICENCE' });
    const r = await t.req('POST', '/me/checks', d, { kind: 'VOICE' });
    expect(r.body.complete).toBe(true);
    expect((await t.req('GET', '/me/checks', c)).status).toBe(403);
  });
});

describe('stops and driving time', () => {
  it('a declared break notifies coordinators and pauses the driving clock', async () => {
    const s = await t.req('POST', '/shipments/SHP-1001/stops', d, { kind: 'BREAK' });
    expect(s.status).toBe(201);
    expect(await kinds(c)).toContain('DRIVER_STOP');
    const driving = (await t.req('GET', '/shipments/SHP-1001/driving', d)).body;
    expect(driving.on_stop.id).toBe(s.body.id);
    expect(driving.break_due_at).toBeNull();
    expect((await t.req('POST', `/stops/${s.body.id}/end`, d)).body.ended_at).not.toBeNull();
    expect((await t.req('POST', '/shipments/SHP-1001/stops', await t.login(DRIVER2), { kind: 'BREAK' })).status).toBe(404);
  });

  it('detects an unplanned stop from positions that do not move', async () => {
    const now = t.ctx.clock.nowIso();
    const at = (min: number) => new Date(Date.parse(now) - min * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    // The in-memory test database: replace the replay's positions in the window with a truck standing still.
    t.ctx.db.prepare(`UPDATE shipment_events SET occurred_at = '2000-01-01T00:00:00Z' WHERE shipment_id = 'SHP-1001' AND type = 'POSITION' AND occurred_at >= ?`).run(at(11));
    const ins = t.ctx.db.prepare(
      `INSERT INTO shipment_events (event_id, shipment_id, type, occurred_at, received_at, source, payload, apply_status, route_id, progress_km, result)
       VALUES (?, 'SHP-1001', 'POSITION', ?, ?, 'HTTP', '{}', 'APPLIED', 'RTE-01', 57.0, '{}')`,
    );
    ins.run(uuid(), at(9), at(9));
    ins.run(uuid(), at(0), at(0));
    t.ctx.db.transaction(() => detectStops(t.ctx, now, []))();
    const stops = (await t.req('GET', '/shipments/SHP-1001/stops', c)).body;
    expect(stops.at(-1)).toMatchObject({ kind: 'UNPLANNED', source: 'DETECTED', ended_at: null });
    expect(await kinds(c)).toContain('DRIVER_STOP');
  });
});

describe('check-ins', () => {
  it('coordinator asks, driver answers, coordinator is told', async () => {
    expect((await t.req('GET', '/shipments/SHP-1001/driver-contact', c)).body.phone).toBeTruthy();
    const q = await t.req('POST', '/shipments/SHP-1001/checkins', c, { message: 'All good?' });
    expect(q.status).toBe(201);
    expect(await kinds(d)).toContain('CHECKIN_REQUEST');
    const a = await t.req('POST', `/checkins/${q.body.id}/respond`, d, { response: 'PROBLEM', note: 'Tyre pressure low' });
    expect(a.body).toMatchObject({ response: 'PROBLEM', response_note: 'Tyre pressure low' });
    expect(await kinds(c)).toContain('CHECKIN_REPLY');
    expect((await t.req('POST', `/checkins/${q.body.id}/respond`, d, { response: 'OK' })).status).toBe(409);
    expect((await t.req('GET', '/shipments/SHP-1001/checkins', await t.login(CUST1))).status).toBe(403);
  });
});

describe('documents', () => {
  it('delivery photo after arrival, verified by the coordinator, visible to the customer only', async () => {
    const photo = { kind: 'DELIVERY_PHOTO', mime: 'image/png', file_name: 'pod.png', data_base64: PNG };
    expect((await t.req('POST', '/shipments/SHP-1001/documents', d, photo)).status).toBe(409); // still in transit
    await t.req('POST', '/shipments/SHP-1001/events', d, { event_id: uuid(), type: 'MILESTONE', payload: { to_status: 'ARRIVED' } });
    const up = await t.req('POST', '/shipments/SHP-1001/documents', d, photo);
    expect(up.status).toBe(201);
    const cust = await t.login(CUST1);
    expect(await kinds(cust)).toContain('DELIVERY_PHOTO');
    expect((await t.req('POST', `/documents/${up.body.id}/verify`, c)).body.verified_by_name).toBeTruthy();
    expect(await kinds(cust)).toContain('DELIVERY_VERIFIED');
    const file = await t.app.inject({ method: 'GET', url: `/api/v1/documents/${up.body.id}/file`, headers: { authorization: `Bearer ${cust}` } });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect((await t.req('GET', '/shipments/SHP-1001/documents', await t.login(CUST2))).status).toBe(404);
  });
});

describe('trip log', () => {
  it('lists reports, stops and check-ins newest first, for coordinators only', async () => {
    await t.req('POST', '/shipments/SHP-1001/stops', d, { kind: 'FUEL' });
    await t.req('POST', '/shipments/SHP-1001/checkins', c, {});
    const log = (await t.req('GET', '/shipments/SHP-1001/log', c)).body;
    expect(log.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['STOP', 'CHECKIN']));
    expect(log[0].at >= log.at(-1).at).toBe(true);
    expect((await t.req('GET', '/shipments/SHP-1001/log', d)).status).toBe(403);
  });
});
