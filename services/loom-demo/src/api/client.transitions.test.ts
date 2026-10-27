import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Connection-state transitions of the API client. Both directions are covered, with
// the fetch layer stubbed so no network request is made.

vi.mock('./wasmEngine', () => ({ initKdCoreWasm: () => Promise.resolve() }));
vi.mock('./drandClient', () => ({
  fetchLatestDrandPulse: () =>
    Promise.resolve({ round: 100, signature: 'aa'.repeat(48), randomness: 'bb'.repeat(32) }),
}));

// 'persisted-lost': the API stored the receipt, then the response never arrived.
// 'truncated': a 201 whose body was cut off mid-transfer.
type Reply = 'down' | 'persisted-lost' | 'truncated' | number;

let livez: Reply;
let roll: Reply;
let livezCalls: number;
let rollCalls: number;
let persisted: number;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const isRoll = url.endsWith('/v1/roll');
      const reply = url.endsWith('/livez') ? livez : isRoll ? roll : 'down';
      if (url.endsWith('/livez')) livezCalls += 1;
      if (isRoll) rollCalls += 1;
      if (reply === 'persisted-lost') {
        persisted += 1;
        throw new TypeError('Failed to fetch');
      }
      if (reply === 'down') throw new TypeError('Failed to fetch');
      if (reply === 'truncated') return new Response('{"id":"r1","fa', { status: 201 });
      const body = reply === 201 ? JSON.stringify({ id: 'r1' }) : JSON.stringify({ status: 'ok' });
      return new Response(body, { status: reply });
    }),
  );
}

async function loadClient(demoFallback: boolean) {
  vi.resetModules();
  vi.stubEnv('DEV', false);
  vi.stubEnv('VITE_DEMO_FALLBACK', demoFallback ? '1' : '');
  return import('./client');
}

async function rollError(client: Awaited<ReturnType<typeof loadClient>>): Promise<string> {
  const err = await client.postRoll('d20', 0).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return (err as Error).message;
}

beforeEach(() => {
  livez = 200;
  roll = 201;
  livezCalls = 0;
  rollCalls = 0;
  persisted = 0;
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('client connection state', () => {
  it('starts unavailable, refuses to simulate, then recovers to live', async () => {
    const client = await loadClient(false);
    livez = 'down';
    expect(await client.initClient()).toBe('unavailable');

    expect(await rollError(client)).toBe(client.ROLL_NOT_SENT_MESSAGE);
    expect(rollCalls).toBe(0);
    expect(client.getClientMode()).toBe('unavailable');

    livez = 200;
    await expect(client.postRoll('d20', 0)).resolves.toMatchObject({ id: 'r1' });
    expect(client.getClientMode()).toBe('live');
  });

  it('moves live to unavailable when the roll gets no response and liveness fails', async () => {
    const client = await loadClient(false);
    expect(await client.initClient()).toBe('live');

    roll = 'down';
    livez = 'down';
    expect(await rollError(client)).toBe(client.ROLL_OUTCOME_UNKNOWN_MESSAGE);
    expect(client.getClientMode()).toBe('unavailable');
  });

  it('never falls back to demo after startup, even in a demo-fallback build', async () => {
    const client = await loadClient(true);
    expect(await client.initClient()).toBe('live');

    roll = 'down';
    livez = 'down';
    expect(await rollError(client)).toBe(client.ROLL_OUTCOME_UNKNOWN_MESSAGE);
    expect(client.getClientMode()).toBe('unavailable');
    expect(client.isMockMode()).toBe(false);
  });

  it('treats an edge 5xx with failed liveness as unavailable', async () => {
    const client = await loadClient(false);
    await client.initClient();

    roll = 502;
    livez = 'down';
    expect(await rollError(client)).toBe(client.ROLL_OUTCOME_UNKNOWN_MESSAGE);
    expect(client.getClientMode()).toBe('unavailable');
  });

  it('stays live on a 5xx when liveness still answers', async () => {
    const client = await loadClient(false);
    await client.initClient();

    roll = 503;
    expect(await rollError(client)).toBe(client.ROLL_OUTCOME_UNKNOWN_MESSAGE);
    expect(client.getClientMode()).toBe('live');
  });

  it.each([400, 409, 429])('stays live on %i without re-probing', async (status) => {
    const client = await loadClient(false);
    await client.initClient();
    const probesAfterInit = livezCalls;

    roll = status;
    await expect(client.postRoll('d20', 0)).rejects.toThrow(`Roll failed (${status})`);
    expect(client.getClientMode()).toBe('live');
    expect(livezCalls).toBe(probesAfterInit);
  });
});

describe('roll outcome wording', () => {
  // The server stored a receipt, then the response was lost. The client must not claim
  // that nothing was created, whether or not liveness answers afterwards.
  it.each([
    ['liveness down', 'down' as Reply],
    ['liveness up', 200 as Reply],
  ])('a stored receipt with a lost response is outcome-unknown (%s)', async (_label, after) => {
    const client = await loadClient(false);
    await client.initClient();

    roll = 'persisted-lost';
    livez = after;
    const message = await rollError(client);
    expect(persisted).toBe(1);
    expect(message).toBe(client.ROLL_OUTCOME_UNKNOWN_MESSAGE);
    expect(message).not.toMatch(/no receipt|no roll request/i);
  });

  it('a 500 from a reachable API (lost commit ack) is outcome-unknown', async () => {
    const client = await loadClient(false);
    await client.initClient();

    roll = 500;
    expect(await rollError(client)).toBe(client.ROLL_OUTCOME_UNKNOWN_MESSAGE);
  });

  it('a 201 with a truncated body is outcome-unknown', async () => {
    const client = await loadClient(false);
    await client.initClient();

    roll = 'truncated';
    expect(await rollError(client)).toBe(client.ROLL_OUTCOME_UNKNOWN_MESSAGE);
  });

  it('says no request was sent only when the roll endpoint was never called', async () => {
    const client = await loadClient(false);
    livez = 'down';
    await client.initClient();

    expect(await rollError(client)).toBe(client.ROLL_NOT_SENT_MESSAGE);
    expect(rollCalls).toBe(0);
    expect(client.ROLL_OUTCOME_UNKNOWN_MESSAGE).not.toMatch(/no receipt|no roll request/i);
  });
});
