// Order-tracking assistant (Groq): what the model is told, who may ask, and failure handling.
// fetch is stubbed: these tests never call the real API.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REAL_FIXTURES_DIR } from '../src/sim/fixtures';
import { COORD, CUST1, DRIVER1, makeApp, type TestApp } from './helpers';

const KEY = 'test-groq-key';

/** A fake Groq that records each request body and answers with fixed text. */
function fakeGroq(answer = 'It is due at 11:45 IST.') {
  const seen: { auth: string; body: any }[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes('api.groq.com')) throw new Error(`unexpected request to ${String(url)}`);
    seen.push({ auth: String((init!.headers as Record<string, string>).Authorization), body: JSON.parse(String(init!.body)) });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }), { status: 200 });
  });
  return { f, seen };
}

describe('assistant', () => {
  let t: TestApp;
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t?.close();
  });

  it('says when it is not configured, and never calls out', async () => {
    const { f } = fakeGroq();
    vi.stubGlobal('fetch', f);
    t = await makeApp({}, REAL_FIXTURES_DIR);
    const c = await t.login(COORD);
    expect((await t.req('GET', '/assistant', c)).body).toMatchObject({ configured: false, provider: 'Groq' });
    const r = await t.req('POST', '/assistant/ask', c, { question: 'Where is SHP-1001?' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('ASSISTANT_UNCONFIGURED');
    expect(f).not.toHaveBeenCalled();
    expect((await t.req('POST', '/assistant/ask', undefined, { question: 'x' })).status).toBe(401);
  });

  it('answers from the asker\'s own shipments and sends the key only in the header', async () => {
    const { f, seen } = fakeGroq();
    vi.stubGlobal('fetch', f);
    t = await makeApp({ groqApiKey: KEY, groqModel: 'test-model' }, REAL_FIXTURES_DIR);
    const c = await t.login(COORD);
    const r = await t.req('POST', '/assistant/ask', c, {
      question: 'Where is SHP-1001?',
      history: [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hello. Ask me about a shipment.' }],
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ answer: 'It is due at 11:45 IST.', provider: 'Groq', model: 'test-model' });
    const { auth, body } = seen[0];
    expect(auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(body.model).toBe('test-model');
    expect(body.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(body.messages.at(-1).content).toBe('Where is SHP-1001?');
    const system: string = body.messages[0].content;
    expect(system).toContain('Current time: 16 Nov 08:50 IST');
    for (const id of ['SHP-1001', 'SHP-1002', 'SHP-1003']) expect(system).toContain(`Shipment ${id}`);
    expect(system).toContain('Ravi Shinde'); // a coordinator may see driver names
    expect(system).not.toMatch(/password|@plantx\.example/i);
  });

  it('a customer\'s context holds only that customer\'s shipments and no driver details', async () => {
    const { f, seen } = fakeGroq();
    vi.stubGlobal('fetch', f);
    t = await makeApp({ groqApiKey: KEY }, REAL_FIXTURES_DIR);
    const mine = (await t.req('GET', '/shipments', await t.login(CUST1))).body.map((s: any) => s.id) as string[];
    const everyone = (await t.req('GET', '/shipments', await t.login(COORD))).body.map((s: any) => s.id) as string[];
    const others = everyone.filter((id) => !mine.includes(id));
    expect(mine.length).toBeGreaterThan(0);
    expect(others.length).toBeGreaterThan(0);
    expect((await t.req('POST', '/assistant/ask', await t.login(CUST1), { question: 'Where is my order?' })).status).toBe(200);
    const system: string = seen[0].body.messages[0].content;
    expect(system).toContain('a customer waiting for deliveries');
    for (const id of others) expect(system).not.toContain(`Shipment ${id}:`);
    for (const id of others) expect(system).not.toContain(`Shipment ${id} `);
    expect(system).not.toMatch(/driver [A-Z]/);
    // A driver sees only the assigned trips.
    await t.req('POST', '/assistant/ask', await t.login(DRIVER1), { question: 'What is my ETA?' });
    const driverSystem: string = seen[1].body.messages[0].content;
    expect(driverSystem).toContain('a truck driver');
    expect(driverSystem).toContain('Shipment SHP-1001');
    expect(driverSystem).not.toContain('Shipment SHP-1002');
  });

  it('rejects bad input, reports a provider failure as 502, and limits questions per minute', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"down"}', { status: 500 })));
    t = await makeApp({ groqApiKey: KEY }, REAL_FIXTURES_DIR);
    const c = await t.login(COORD);
    expect((await t.req('POST', '/assistant/ask', c, { question: '   ' })).status).toBe(422);
    expect((await t.req('POST', '/assistant/ask', c, { question: 'x'.repeat(501) })).status).toBe(422);
    const down = await t.req('POST', '/assistant/ask', c, { question: 'Where is SHP-1001?' });
    expect(down.status).toBe(502);
    expect(down.body.error.code).toBe('ASSISTANT_UNAVAILABLE');
    let last = down;
    for (let i = 0; i < 10; i++) last = await t.req('POST', '/assistant/ask', c, { question: 'again' });
    expect(last.status).toBe(429);
  });
});
