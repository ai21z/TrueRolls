import { describe, expect, it } from 'vitest';
import { isApiLivenessResponse, resolveClientMode } from './client';

describe('resolveClientMode', () => {
  it('uses the live API whenever it is reachable', () => {
    expect(resolveClientMode(true, false)).toBe('live');
    expect(resolveClientMode(true, true)).toBe('live');
  });

  it('falls back to simulated receipts only when demo fallback is enabled', () => {
    expect(resolveClientMode(false, true)).toBe('demo');
  });

  it('reports unavailable instead of simulating when demo fallback is off', () => {
    expect(resolveClientMode(false, false)).toBe('unavailable');
  });
});

describe('isApiLivenessResponse', () => {
  it('accepts the real liveness JSON contract', async () => {
    expect(await isApiLivenessResponse(Response.json({ status: 'ok' }))).toBe(true);
  });

  it('accepts a JSON content type with a charset', async () => {
    const response = new Response('{"status":"ok"}', {
      headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
    });
    expect(await isApiLivenessResponse(response)).toBe(true);
  });

  it('rejects a successful HTML site or login fallback', async () => {
    const response = new Response('<!doctype html><html></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
    expect(await isApiLivenessResponse(response)).toBe(false);
  });

  it('requires the JSON content type even if the body looks valid', async () => {
    expect(await isApiLivenessResponse(new Response('{"status":"ok"}'))).toBe(false);
  });

  it('rejects an unsuccessful status even with an ok body', async () => {
    expect(await isApiLivenessResponse(Response.json({ status: 'ok' }, { status: 503 }))).toBe(false);
  });

  it('rejects malformed JSON', async () => {
    const response = new Response('{', { headers: { 'Content-Type': 'application/json' } });
    expect(await isApiLivenessResponse(response)).toBe(false);
  });

  it.each([null, [], {}, { status: 'degraded' }, 'ok'])('rejects unsupported body %#', async (body) => {
    expect(await isApiLivenessResponse(Response.json(body))).toBe(false);
  });
});
