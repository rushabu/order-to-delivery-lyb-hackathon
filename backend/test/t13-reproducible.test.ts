// T13: POST /demo/reset twice, replay twice: identical snapshots (DESIGN.md 1.5 and 10.2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCIDENT_EVENT, COORD, DRIVER1, makeApp, T, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await makeApp();
});
afterAll(async () => {
  await t.close();
});

async function runOnce() {
  const c = await t.login(COORD);
  expect((await t.req('POST', '/demo/reset', c)).status).toBe(200);
  expect((await t.req('POST', '/demo/scenarios/main/start', c)).status).toBe(200);
  t.advanceTo(T['09:30']);
  const d = await t.login(DRIVER1);
  expect((await t.req('POST', '/shipments/SHP-1001/events', d, ACCIDENT_EVENT)).status).toBe(201);
  await scriptedDecision(c);
  t.advanceTo('2026-11-16T07:30:00Z');
  const snaps = t.ctx.db.prepare('SELECT * FROM eta_snapshots ORDER BY seq').all();
  const alerts = t.ctx.db.prepare('SELECT * FROM alerts ORDER BY id').all();
  const notes = t.ctx.db.prepare('SELECT id, user_id, kind, body, created_at FROM notifications ORDER BY seq').all();
  const decisions = t.ctx.db.prepare('SELECT id, option_id, predicted, outcome FROM decisions ORDER BY id').all();
  return { snaps, alerts, notes, decisions };
}

/** The coordinator's approval, as the presenter does it at the 09:30 beat. */
async function scriptedDecision(c: string) {
  const options = await t.req('GET', '/alerts/ALT-0001/options', c);
  if (options.status !== 200) return; // decision endpoints arrive with milestone M3
  await t.req('POST', '/shipments/SHP-1001/decisions', c, {
    decision_id: 'c2a4e9d0-7b1f-4c3a-b6e2-0d9f8a7c6b55',
    option_set_id: options.body.id,
    option_id: options.body.recommended_option_id,
  });
}

describe('T13 reproducibility', () => {
  it('two resets and two replays give identical snapshots, alerts, notifications and decisions', async () => {
    const a = await runOnce();
    const b = await runOnce();
    expect(a.snaps.length).toBeGreaterThan(20);
    expect(b).toEqual(a);
  });
});
