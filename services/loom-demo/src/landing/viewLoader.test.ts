import { afterEach, describe, expect, it, vi } from 'vitest';
import { failedModuleUrl, isChunkLoadError, viewLoader } from './viewLoader';

const ORIGIN = 'http://127.0.0.1:4174';

describe('failedModuleUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes the script URL from the Chromium and Firefox messages, without a query', () => {
    vi.stubGlobal('window', { location: { origin: ORIGIN } });
    expect(
      failedModuleUrl(new TypeError(`Failed to fetch dynamically imported module: ${ORIGIN}/assets/Docs-a1.js`)),
    ).toBe(`${ORIGIN}/assets/Docs-a1.js`);
    expect(
      failedModuleUrl(new TypeError(`error loading dynamically imported module: ${ORIGIN}/assets/Docs-a1.js?retry=2`)),
    ).toBe(`${ORIGIN}/assets/Docs-a1.js`);
  });

  it('ignores messages without a URL and other origins', () => {
    vi.stubGlobal('window', { location: { origin: ORIGIN } });
    expect(failedModuleUrl(new TypeError('Importing a module script failed.'))).toBeNull();
    expect(
      failedModuleUrl(new TypeError('Failed to fetch dynamically imported module: https://cdn.example/x.js')),
    ).toBeNull();
    expect(failedModuleUrl(new Error(`Unable to preload CSS for ${ORIGIN}/assets/Docs-a1.css`))).toBeNull();
  });
});

describe('isChunkLoadError', () => {
  it('separates download failures from render errors', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true);
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'face')"))).toBe(false);
  });
});

describe('viewLoader', () => {
  it('shares one download between a prefetch and the navigation that needs it', async () => {
    const importer = vi.fn(() => Promise.resolve({ View: 'view' }));
    const load = viewLoader(importer, (m) => m.View);
    const [a, b] = await Promise.all([load(), load()]);
    expect([a, b]).toEqual(['view', 'view']);
    await load();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('starts a new attempt after a failure instead of returning the cached rejection', async () => {
    const importer = vi
      .fn<() => Promise<{ View: string }>>()
      .mockRejectedValueOnce(new TypeError('Importing a module script failed.'))
      .mockResolvedValueOnce({ View: 'view' });
    const load = viewLoader(importer, (m) => m.View);
    await expect(load()).rejects.toThrow('Importing a module script failed.');
    await expect(load()).resolves.toBe('view');
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
