import { describe, expect, it } from 'vitest';
import { resolveClientMode } from './client';

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
