// Test harness: an in-memory app in demo mode on the stub fixtures, with the simulator driven by hand.
import { randomUUID } from 'node:crypto';
import { buildApp, type Built } from '../src/app';
import type { AppConfig } from '../src/config';
import { loadFixtures, STUB_FIXTURES_DIR } from '../src/sim/fixtures';

export const T = {
  '08:50': '2026-11-16T03:20:00Z',
  '09:15': '2026-11-16T03:45:00Z',
  '09:30': '2026-11-16T04:00:00Z',
};

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    jwtSecret: 'test-secret-not-used-anywhere-else',
    corsOrigins: ['http://localhost:5173'],
    databaseFile: ':memory:',
    demoMode: true,
    validateResponses: true,
    ...over,
  };
}

export interface TestApp extends Built {
  login(userId: string): Promise<string>;
  req(method: 'GET' | 'POST', url: string, token?: string, body?: unknown): Promise<{ status: number; body: any }>;
  advanceTo(iso: string): void;
}

/** An app on the stub fixtures by default; pass database/seed (REAL_FIXTURES_DIR) to run on the real seed. */
export async function makeApp(over: Partial<AppConfig> = {}, fixturesDir: string = STUB_FIXTURES_DIR): Promise<TestApp> {
  const fixtures = loadFixtures(fixturesDir);
  const built = await buildApp({ config: testConfig(over), fixturesDir, autoTick: false });
  const tokens = new Map<string, string>();
  const req: TestApp['req'] = async (method, url, token, body) => {
    const res = await built.app.inject({
      method,
      url: url.startsWith('/api') || url.startsWith('/openapi') || url.startsWith('/health') ? url : `/api/v1${url}`,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return {
    ...built,
    req,
    async login(userId: string) {
      const cached = tokens.get(userId);
      if (cached) return cached;
      const u = fixtures.users.find((x) => x.id === userId)!;
      const r = await req('POST', '/auth/login', undefined, { email: u.email, password: u.password });
      if (r.status !== 200) throw new Error(`login failed for ${userId}: ${JSON.stringify(r.body)}`);
      tokens.set(userId, r.body.token);
      return r.body.token;
    },
    advanceTo(iso: string) {
      // Keep going through pause beats until the target time is reached.
      while (built.clock!.nowIso() < iso) built.sim!.advanceTo(iso);
    },
  };
}

export const ACCIDENT_EVENT = {
  event_id: '5f0c2c1e-8a4b-4f6d-9a57-2f3f1f0b7a11',
  type: 'DISRUPTION_REPORTED',
  payload: {
    disruption_id: '9b1d6c70-3c55-4f0e-8d0a-6f1f5a2c4e22',
    category: 'ACCIDENT',
    expected_delay_min: 60,
    at_km: 75,
    note: 'Accident ahead, one lane closed',
  },
};

export const uuid = () => randomUUID();
export const COORD = 'USR-COORD-01';
export const DRIVER1 = 'USR-DRV-01';
export const DRIVER2 = 'USR-DRV-02';
export const CUST1 = 'USR-CUST-01';
export const CUST2 = 'USR-CUST-02';
