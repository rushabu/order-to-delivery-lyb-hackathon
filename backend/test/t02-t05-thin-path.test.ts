// Milestone M1 and tests T2 to T5 (DESIGN.md 10.2, PHASES.md phase 1).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCIDENT_EVENT, COORD, CUST1, DRIVER1, makeApp, T, uuid, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

async function startAndRunTo(iso: string) {
  const c = await t.login(COORD);
  expect((await t.req('POST', '/demo/scenarios/main/start', c)).status).toBe(200);
  t.advanceTo(iso);
}

describe('M1 thin path', () => {
  it('after reset and start, SHP-1001 reads 11:45 IST with 25 min congestion at 09:15, no human input', async () => {
    const c = await t.login(COORD);
    await t.req('POST', '/demo/reset', c);
    await startAndRunTo(T['09:15']);
    expect(t.clock!.nowIso()).toBe(T['09:15']);
    const r = await t.req('GET', '/shipments/SHP-1001', c);
    expect(r.status).toBe(200);
    const eta = r.body.current_eta;
    expect(eta.eta).toBe('2026-11-16T06:15:00Z'); // 11:45 IST
    expect(eta.factors.find((f: any) => f.code === 'CONGESTION').minutes).toBe(25);
    expect(eta.risk_level).toBe('MEDIUM');
    expect(eta.headline).toBe('At risk: slow traffic adds 25 min');
    expect(r.body.open_alert.id).toBe('ALT-0001');
    expect(r.body.last_position.progress_km).toBe(50);
  });

  it('T2: posting the 5.7.1 event gives 12:25, HIGH, factors sum to 175; coordinator and customer notified', async () => {
    await startAndRunTo(T['09:30']);
    const d = await t.login(DRIVER1);
    const post = await t.req('POST', '/shipments/SHP-1001/events', d, ACCIDENT_EVENT);
    expect(post.status).toBe(201);
    expect(post.body).toMatchObject({ apply_status: 'APPLIED', shipment_id: 'SHP-1001', occurred_at: T['09:30'] });

    const c = await t.login(COORD);
    const detail = (await t.req('GET', '/shipments/SHP-1001', c)).body;
    expect(detail.current_eta.id).toBe(post.body.eta_snapshot_id);
    expect(detail.current_eta.eta).toBe('2026-11-16T06:55:00Z'); // 12:25 IST
    expect(detail.current_eta.risk_level).toBe('HIGH');
    expect(detail.current_eta.factors.reduce((a: number, f: any) => a + f.minutes, 0)).toBe(175);
    expect(detail.current_eta.trigger_event_id).toBe(ACCIDENT_EVENT.event_id);
    expect(detail.open_alert).toMatchObject({ id: 'ALT-0001', level: 'HIGH' });

    const coordN = (await t.req('GET', '/notifications', c)).body;
    expect(coordN.map((n: any) => n.kind)).toEqual(['RISK_HIGH', 'RISK_MEDIUM']);
    const cu = await t.login(CUST1);
    const custN = (await t.req('GET', '/notifications', cu)).body;
    expect(custN).toHaveLength(1);
    expect(custN[0]).toMatchObject({ kind: 'RISK_HIGH', shipment_id: 'SHP-1001' });
    expect(custN[0].body).toContain('accident ahead at km 75');
    expect(custN[0].body).not.toContain('Vikram'); // no driver name to customers
  });

  it('T3: the same event_id twice gives one stored event and one snapshot', async () => {
    await startAndRunTo(T['09:30']);
    const d = await t.login(DRIVER1);
    const first = await t.req('POST', '/shipments/SHP-1001/events', d, ACCIDENT_EVENT);
    const countSnaps = () => (t.ctx.db.prepare(`SELECT COUNT(*) n FROM eta_snapshots WHERE shipment_id = 'SHP-1001'`).get() as any).n;
    const snapsBefore = countSnaps();
    const second = await t.req('POST', '/shipments/SHP-1001/events', d, ACCIDENT_EVENT);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, apply_status: 'DUPLICATE' });
    expect(countSnaps()).toBe(snapsBefore);
    const stored = t.ctx.db.prepare('SELECT COUNT(*) n FROM shipment_events WHERE event_id = ?').get(ACCIDENT_EVENT.event_id) as any;
    expect(stored.n).toBe(1);
    const c = await t.login(COORD);
    const detail = (await t.req('GET', '/shipments/SHP-1001', c)).body;
    expect(detail.current_eta.id).toBe(first.body.eta_snapshot_id);
    expect(detail.active_disruptions).toHaveLength(1);
  });

  it('T4: a position with an earlier occurred_at is stored but the marker does not move', async () => {
    // Device time matters only outside demo mode, where the client's occurred_at is used.
    await t.close();
    t = await makeApp({ demoMode: false });
    const d = await t.login(DRIVER1);
    const before = (await t.req('GET', '/shipments/SHP-1001', d)).body;
    const res = await t.req('POST', '/shipments/SHP-1001/events', d, {
      event_id: uuid(),
      type: 'POSITION',
      occurred_at: '2026-11-16T03:00:00Z', // earlier than the last position (03:20)
      payload: { lat: 18.8, lng: 73.5 },
    });
    expect(res.status).toBe(201);
    expect(res.body.apply_status).toBe('STORED_NOT_APPLIED');
    const after = (await t.req('GET', '/shipments/SHP-1001', d)).body;
    expect(after.last_position).toEqual(before.last_position);
    expect(after.current_eta.id).toBe(before.current_eta.id);
    const events = (await t.req('GET', '/shipments/SHP-1001/events', d)).body;
    expect(events.some((e: any) => e.event_id === res.body.event_id && e.apply_status === 'STORED_NOT_APPLIED')).toBe(true);
  });

  it('T5: DELIVERED posted while PLANNED returns 409 and is audited', async () => {
    const d3 = await t.login('USR-DRV-03');
    const res = await t.req('POST', '/shipments/SHP-1003/events', d3, {
      event_id: uuid(),
      type: 'MILESTONE',
      payload: { to_status: 'DELIVERED' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_TRANSITION');
    const audit = t.ctx.db.prepare(`SELECT COUNT(*) n FROM audit_events WHERE action = 'EVENT_REJECTED'`).get() as any;
    expect(audit.n).toBe(1);
  });

  it('malformed payload is 422; repeated milestone to the current state is DUPLICATE', async () => {
    const d = await t.login(DRIVER1);
    const bad = await t.req('POST', '/shipments/SHP-1001/events', d, { event_id: uuid(), type: 'POSITION', payload: { lat: 'x' } });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    const dup = await t.req('POST', '/shipments/SHP-1001/events', d, { event_id: uuid(), type: 'MILESTONE', payload: { to_status: 'IN_TRANSIT' } });
    expect(dup.status).toBe(200);
    expect(dup.body.apply_status).toBe('DUPLICATE');
  });
});
