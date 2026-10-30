import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_MAX_AGE_MS,
  consumeReceiptHandoff,
  peekReceiptHandoff,
  stashReceiptForVerify,
} from './receiptHandoff';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, String(v));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('receipt hand-off', () => {
  it('round-trips the exact receipt text once', () => {
    const text = '{"id":"r1","proof":{"draw_u64":"18446744073709551615"}}';
    expect(stashReceiptForVerify(text, { rollId: 'r1', kind: 'original' }, 1000)).toBe(true);
    const read = peekReceiptHandoff(2000);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.handoff.receiptJson).toBe(text);
    expect(read.handoff.kind).toBe('original');
    consumeReceiptHandoff(read.handoff.token);
    expect(peekReceiptHandoff(2000).status).toBe('none');
  });

  it('expires instead of handing over an old receipt', () => {
    stashReceiptForVerify('{}', { rollId: null, kind: 'original' }, 0);
    expect(peekReceiptHandoff(HANDOFF_MAX_AGE_MS + 1).status).toBe('expired');
  });

  it('reports malformed storage without throwing', () => {
    sessionStorage.setItem('tr-verify-handoff', '{not json');
    expect(peekReceiptHandoff().status).toBe('malformed');
    sessionStorage.setItem('tr-verify-handoff', JSON.stringify({ token: 't', receiptJson: 1 }));
    expect(peekReceiptHandoff().status).toBe('malformed');
  });

  it('consuming an older token leaves a newer hand-off in place', () => {
    stashReceiptForVerify('{"n":1}', { rollId: 'a', kind: 'original' }, 1000);
    const first = peekReceiptHandoff(1000);
    stashReceiptForVerify('{"n":2}', { rollId: 'b', kind: 'edited-copy' }, 1001);
    if (first.status === 'ok') consumeReceiptHandoff(first.handoff.token);
    const second = peekReceiptHandoff(1002);
    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.handoff.receiptJson).toBe('{"n":2}');
  });
});
