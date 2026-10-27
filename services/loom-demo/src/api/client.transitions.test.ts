import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Connection-state transitions of the API client. Both directions are covered, with
// the fetch layer stubbed so no network request is made.

vi.mock('./wasmEngine', () => ({ initKdCoreWasm: () => Promise.resolve() }));
vi.mock('./drandClient', () => ({
  fetchLatestDrandPulse: () =>
    Promise.resolve({ round: 100, signature: 'aa'.repeat(48), randomness: 'bb'.repeat(32) }),
}));

type Reply = 'down' | number;

let livez: Reply;
let roll: Reply;
let livezCalls: number;

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const reply = url.endsWith('/livez') ? livez : url.endsWith('/v1/roll') ? roll : 'down';
      if (url.endsWith('/livez')) livezCalls += 1;
      if (reply === 'down') throw new TypeError('Failed to fetch');
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

beforeEach(() => {
  livez = 200;
  roll = 201;
  livezCalls = 0;
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

    await expect(client.postRoll('d20', 0)).rejects.toThrow(client.API_UNAVAILABLE_MESSAGE);
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
    await expect(client.postRoll('d20', 0)).rejects.toThrow(client.API_UNAVAILABLE_MESSAGE);
    expect(client.getClientMode()).toBe('unavailable');
  });

  it('never falls back to demo after startup, even in a demo-fallback build', async () => {
    const client = await loadClient(true);
    expect(await client.initClient()).toBe('live');

    roll = 'down';
    livez = 'down';
    await expect(client.postRoll('d20', 0)).rejects.toThrow(client.API_UNAVAILABLE_MESSAGE);
    expect(client.getClientMode()).toBe('unavailable');
    expect(client.isMockMode()).toBe(false);
  });

  it('treats an edge 5xx with failed liveness as unavailable', async () => {
    const client = await loadClient(false);
    await client.initClient();

    roll = 502;
    livez = 'down';
    await expect(client.postRoll('d20', 0)).rejects.toThrow(client.API_UNAVAILABLE_MESSAGE);
    expect(client.getClientMode()).toBe('unavailable');
  });

  it('stays live on a 5xx when liveness still answers', async () => {
    const client = await loadClient(false);
    await client.initClient();

    roll = 503;
    await expect(client.postRoll('d20', 0)).rejects.toThrow('Roll failed (503)');
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
