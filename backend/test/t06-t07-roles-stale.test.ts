// Milestone M2: T6 (access), T7 (stale position) and the security checklist items.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { staleTick } from '../src/shipments/staleTick';
import { StreamHub } from '../src/stream/hub';
import { COORD, CUST1, CUST2, DRIVER1, makeApp, uuid, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe('T6 access control', () => {
  it('customer A requesting customer B’s shipment gets 404; driver posting to an unassigned shipment gets 403', async () => {
    const cu = await t.login(CUST1);
    expect((await t.req('GET', '/shipments/SHP-1002', cu)).status).toBe(404);
    expect((await t.req('GET', '/shipments/SHP-1002/eta-history', cu)).status).toBe(404);
    const d = await t.login(DRIVER1);
    const post = await t.req('POST', '/shipments/SHP-1002/events', d, { event_id: uuid(), type: 'POSITION', payload: { lat: 19, lng: 73.3 } });
    expect(post.status).toBe(403);
    // An id that does not exist answers the same way, so drivers cannot probe ids.
    const ghost = await t.req('POST', '/shipments/SHP-9999/events', d, { event_id: uuid(), type: 'POSITION', payload: { lat: 19, lng: 73.3 } });
    expect(ghost.status).toBe(403);
    // Driver reading a shipment that is not theirs: 404.
    expect((await t.req('GET', '/shipments/SHP-1002', d)).status).toBe(404);
  });

  it('each role sees only its own shipments; customers never get driver details', async () => {
    const list = async (u: string) => (await t.req('GET', '/shipments', await t.login(u))).body.map((s: any) => s.id).sort();
    expect(await list(COORD)).toEqual(expect.arrayContaining(['SHP-1001', 'SHP-1002', 'SHP-1003', 'SHP-0901']));
    expect(await list(DRIVER1)).toEqual(['SHP-1001']);
    expect(await list(CUST2)).toEqual(['SHP-0905', 'SHP-0906', 'SHP-0907', 'SHP-0908', 'SHP-1002', 'SHP-1003']);
    const cu = await t.login(CUST1);
    const detail = (await t.req('GET', '/shipments/SHP-1001', cu)).body;
    expect(detail.driver).toBeNull();
    expect(JSON.stringify(detail)).not.toMatch(/Vikram|\+91/);
    const coordView = (await t.req('GET', '/shipments/SHP-1001', await t.login(COORD))).body;
    expect(coordView.driver.name).toBe('Vikram Patil');
  });

  it('forbidden actions are 403 and audited; customers cannot post events or read alerts', async () => {
    const cu = await t.login(CUST1);
    expect((await t.req('POST', '/shipments/SHP-1001/events', cu, { event_id: uuid(), type: 'MILESTONE', payload: { to_status: 'ARRIVED' } })).status).toBe(403);
    expect((await t.req('GET', '/alerts', cu)).status).toBe(403);
    expect((await t.req('GET', '/shipments/SHP-1001/events', cu)).status).toBe(403);
    const d = await t.login(DRIVER1);
    expect((await t.req('POST', '/demo/reset', d)).status).toBe(403);
    // A coordinator may not post a driver-only milestone.
    const c = await t.login(COORD);
    expect((await t.req('POST', '/shipments/SHP-1001/events', c, { event_id: uuid(), type: 'MILESTONE', payload: { to_status: 'ARRIVED' } })).status).toBe(403);
    const n = (t.ctx.db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE action = 'ACCESS_DENIED'`).get() as any).n;
    expect(n).toBeGreaterThanOrEqual(5);
  });

  it('a route is visible only through a visible shipment', async () => {
    const cu = await t.login(CUST1);
    expect((await t.req('GET', '/routes/RTE-01', cu)).status).toBe(200);
    expect((await t.req('GET', '/routes/RTE-01B', cu)).status).toBe(200); // alternative of their route
    const d2 = await t.login('USR-DRV-03');
    expect((await t.req('GET', '/routes/RTE-01', d2)).status).toBe(404);
  });

  it('notifications are private to their recipient', async () => {
    const c = await t.login(COORD);
    await t.req('POST', '/demo/scenarios/main/start', c);
    t.advanceTo('2026-11-16T03:45:00Z');
    const mine = (await t.req('GET', '/notifications', c)).body;
    expect(mine.length).toBeGreaterThan(0);
    const cu = await t.login(CUST1);
    expect((await t.req('POST', `/notifications/${mine[0].id}/read`, cu)).status).toBe(404);
    const read = await t.req('POST', `/notifications/${mine[0].id}/read`, c);
    expect(read.status).toBe(200);
    expect(read.body.read_at).toBe('2026-11-16T03:45:00Z');
  });
});

describe('T7 stale position', () => {
  it('11 min without position: LOW confidence, ETA held, wider margin; 31 min: tracking-lost alert', async () => {
    const c = await t.login(COORD);
    const before = (await t.req('GET', '/shipments/SHP-1001', c)).body.current_eta;
    expect(before.eta).toBe('2026-11-16T05:45:00Z');
    expect(before.margin_min).toBe(20);

    // The simulator is not running, so no positions arrive. Only the clock tick runs.
    t.clock!.set(Date.parse('2026-11-16T03:31:00Z'));
    staleTick(t.ctx);
    const s11 = (await t.req('GET', '/shipments/SHP-1001', c)).body.current_eta;
    expect(s11.confidence).toBe('LOW');
    expect(s11.eta).toBe(before.eta);
    expect(s11.margin_min).toBe(21);
    expect(s11.position_age_min).toBe(11);
    expect(s11.factors).toContainEqual({ code: 'POSITION_STALE', label: 'No position for 11 min', minutes: 0 });
    expect(s11.factors.reduce((a: number, f: any) => a + f.minutes, 0)).toBe(134); // eta = now + sum still holds

    t.clock!.set(Date.parse('2026-11-16T03:51:00Z'));
    staleTick(t.ctx);
    const d31 = (await t.req('GET', '/shipments/SHP-1001', c)).body;
    expect(d31.current_eta.eta).toBe(before.eta);
    expect(d31.current_eta.risk_level).toBe('MEDIUM');
    expect(d31.open_alert.title).toBe('Tracking lost');
    const notes = (await t.req('GET', '/notifications', c)).body;
    expect(notes.some((n: any) => n.kind === 'TRACKING_LOST' && n.shipment_id === 'SHP-1001')).toBe(true);
  });
});

describe('security checklist', () => {
  it('login is rate-limited to 10 attempts per minute per address', async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await t.req('POST', '/auth/login', undefined, { email: 'nobody@example.com', password: 'wrong' })).status;
      if (i < 10) expect(last).toBe(401);
    }
    expect(last).toBe(429);
  });

  it('CORS allows only CORS_ORIGINS', async () => {
    const ok = await t.app.inject({ method: 'OPTIONS', url: '/api/v1/me', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const bad = await t.app.inject({ method: 'OPTIONS', url: '/api/v1/me', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('demo endpoints do not exist when DEMO_MODE is off', async () => {
    await t.close();
    t = await makeApp({ demoMode: false });
    const c = await t.login(COORD);
    expect((await t.req('POST', '/demo/reset', c)).status).toBe(404);
    expect((await t.req('GET', '/demo/state', c)).status).toBe(404);
  });

  it('every registered route declares its roles', async () => {
    const api = (await t.req('GET', '/openapi.json')).body;
    for (const [path, methods] of Object.entries<any>(api.paths)) {
      for (const [m, op] of Object.entries<any>(methods)) {
        expect(op['x-roles'], `${m} ${path}`).toBeDefined();
      }
    }
  });

  it('a tampered or foreign token is refused', async () => {
    const c = await t.login(COORD);
    const parts = c.split('.');
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'USR-COORD-01', role: 'COORDINATOR', iat: 1, exp: 9999999999 })).toString('base64url')}.${parts[2]}`;
    expect((await t.req('GET', '/me', forged)).status).toBe(401);
  });
});

describe('stream hub', () => {
  it('sends a shipment hint only to users who may see the shipment', () => {
    const hub = new StreamHub();
    const got: Record<string, string[]> = { coord: [], cust1: [], cust2: [], drv1: [] };
    const sub = (key: string, user: any) => hub.subscribe({ user, write: (c) => got[key].push(c) });
    sub('coord', { id: 'USR-COORD-01', role: 'COORDINATOR', customer_id: null });
    sub('cust1', { id: 'USR-CUST-01', role: 'CUSTOMER', customer_id: 'CUS-01' });
    sub('cust2', { id: 'USR-CUST-02', role: 'CUSTOMER', customer_id: 'CUS-02' });
    sub('drv1', { id: 'USR-DRV-01', role: 'DRIVER', customer_id: null });
    hub.publish([
      {
        hint: { entity: 'shipment', id: 'SHP-1001', version: 43, kinds: ['eta', 'alert'] },
        audience: { kind: 'shipment', customer_id: 'CUS-01', driver_user_id: 'USR-DRV-01' },
      },
    ]);
    expect(got.coord).toHaveLength(1);
    expect(got.cust1[0]).toBe('event: change\ndata: {"entity":"shipment","id":"SHP-1001","version":43,"kinds":["eta","alert"]}\n\n');
    expect(got.drv1).toHaveLength(1);
    expect(got.cust2).toHaveLength(0);
  });
});
