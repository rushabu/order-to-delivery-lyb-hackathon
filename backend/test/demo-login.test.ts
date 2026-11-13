// One-tap demo sign-in exists only in demo mode and signs in as the chosen seeded account.
import { afterEach, describe, expect, it } from 'vitest';
import { COORD, DRIVER1, makeApp, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

describe('demo sign-in', () => {
  it('lists seeded accounts and signs in as one of them without a password', async () => {
    t = await makeApp();
    const list = await t.req('GET', '/auth/demo-accounts');
    expect(list.status).toBe(200);
    expect(list.body.map((a: any) => a.id)).toContain(DRIVER1);
    expect(list.body[0].role).toBe('COORDINATOR');

    const r = await t.req('POST', '/auth/demo-login', undefined, { user_id: DRIVER1 });
    expect(r.status).toBe(200);
    expect(r.body.user.role).toBe('DRIVER');
    expect((await t.req('GET', '/me', r.body.token)).body.id).toBe(DRIVER1);
    expect((await t.req('POST', '/auth/demo-login', undefined, { user_id: 'USR-NOPE' })).status).toBe(404);
  });

  it('does not exist when demo mode is off', async () => {
    t = await makeApp({ demoMode: false });
    expect((await t.req('GET', '/auth/demo-accounts')).status).toBe(404);
    expect((await t.req('POST', '/auth/demo-login', undefined, { user_id: COORD })).status).toBe(404);
  });
});
