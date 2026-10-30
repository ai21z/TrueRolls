import { expect, test, type Page, type Route } from '@playwright/test';
import { LEGACY_RECEIPT } from '../src/generated/receiptFixtures';

// Production build, controlled transport. Every verdict below comes from the real
// browser WASM verifier; only the API liveness and key-set responses are fixtures.

const DEMO_TEST_KEY = 'IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=';
const WRONG_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const ACTIVE_TEST_KEY_SET = {
  keys: [{ kid: 'test-kid-1', alg: 'Ed25519', public_key: DEMO_TEST_KEY, status: 'active' }],
};
const PAGES = [
  { hash: '#verify', loadSample: true },
  { hash: '#behind-a-roll', loadSample: false },
] as const;

interface Harness {
  heldKeys: Route[];
  releaseKeys: (body: unknown) => Promise<void>;
  states: () => Promise<string[]>;
}

async function harness(page: Page, opts: { holdKeys: boolean; keys?: unknown } = { holdKeys: true }) {
  const h: Harness = {
    heldKeys: [],
    releaseKeys: async (body) => {
      for (const route of h.heldKeys.splice(0)) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }
    },
    states: () =>
      page.evaluate(() => (window as Window & { __states?: string[] }).__states ?? []),
  };
  await page.addInitScript(() => {
    const target = window as Window & { __states?: string[] };
    target.__states = [];
    new MutationObserver(() => {
      const el = document.querySelector('[data-verification-state]');
      const s = el?.getAttribute('data-verification-state');
      if (s && target.__states?.at(-1) !== s) target.__states?.push(s);
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-verification-state'],
    });
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!local) return route.abort('blockedbyclient');
    if (url.pathname === '/api/livez') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
    }
    if (url.pathname.endsWith('/.well-known/truerolls-keys.json')) {
      if (opts.holdKeys) {
        h.heldKeys.push(route);
        return;
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(opts.keys ?? { keys: [] }),
      });
    }
    if (url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
    return route.continue();
  });
  return h;
}

const receiptBox = (page: Page) => page.getByRole('textbox', { name: 'Receipt JSON', exact: true });
const keyBox = (page: Page) => page.getByRole('textbox', { name: /Ed25519 public key/ });
const verdict = (page: Page) => page.locator('[data-verification-state]');
const passingRows = (page: Page) =>
  page.locator('[data-check-state="pass"], [data-stratum-state="pass"]');

async function primeSample(page: Page, hash: string, loadSample: boolean) {
  await page.goto(`/${hash}`);
  await expect(receiptBox(page)).toBeVisible();
  if (loadSample) await page.getByRole('button', { name: 'Current drand sample' }).click();
}

/** Hold every read of a file named slow.json until releaseSlowRead is called. */
async function holdSlowReads(page: Page) {
  await page.addInitScript(() => {
    const original = Blob.prototype.text;
    const target = window as Window & { __releaseSlow?: () => void };
    Blob.prototype.text = function (this: Blob) {
      if (this instanceof File && this.name === 'slow.json') {
        return new Promise<string>((resolve) => {
          target.__releaseSlow = () => resolve(original.call(this));
        });
      }
      return original.call(this);
    };
  });
}

async function startSlowUpload(page: Page, text: string) {
  await page.locator('input[type="file"]').setInputFiles({
    name: 'slow.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
}

async function releaseSlowRead(page: Page) {
  await page.evaluate(() => (window as Window & { __releaseSlow?: () => void }).__releaseSlow?.());
  await page.waitForTimeout(400);
}

const verifyButton = (page: Page, hash: string) =>
  page.getByRole('button', {
    name: hash === '#verify' ? 'Verify in your browser' : 'Re-examine in your browser',
  });

for (const { hash, loadSample } of PAGES) {
  test.describe(`verdict binding on ${hash}`, () => {
    test('held discovery + malformed edit never shows VALID or passing rows', async ({ page }) => {
      const h = await harness(page);
      await primeSample(page, hash, loadSample);
      await expect.poll(() => h.heldKeys.length).toBeGreaterThan(0);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'loading');

      await receiptBox(page).fill('{broken');
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
      await h.releaseKeys({ keys: [] });
      await page.waitForTimeout(400);

      await expect(receiptBox(page)).toHaveValue('{broken');
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
      await expect(passingRows(page)).toHaveCount(0);
      expect(await h.states()).not.toContain('valid');

      // Verifying the malformed text is an input diagnosis, not a missing key.
      await verifyButton(page, hash).click();
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'unverifiable');
      await expect(verdict(page)).toContainText('not valid JSON');
      await expect(verdict(page)).not.toContainText('kid null');
    });

    test('held discovery cannot overwrite a typed manual key', async ({ page }) => {
      const h = await harness(page);
      await primeSample(page, hash, loadSample);
      await expect.poll(() => h.heldKeys.length).toBeGreaterThan(0);

      await keyBox(page).fill(WRONG_KEY);
      await h.releaseKeys({ keys: [] });
      await page.waitForTimeout(400);
      await expect(keyBox(page)).toHaveValue(WRONG_KEY);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
      expect(await h.states()).not.toContain('valid');

      // The wrong manual key now verifies as exactly that context: INVALID, bypass visible.
      await verifyButton(page, hash).click();
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'invalid');
      await expect(page.getByText('manual key, status bypassed', { exact: true })).toBeVisible();
    });

    test('a different receipt, unknown kid and changed key each get their own verdict', async ({ page }) => {
      const h = await harness(page);
      await primeSample(page, hash, loadSample);
      await expect.poll(() => h.heldKeys.length).toBeGreaterThan(0);
      const sample = JSON.parse(await receiptBox(page).inputValue()) as Record<string, unknown> & {
        sig: { kid: string };
      };

      const unknown = structuredClone(sample);
      unknown.sig.kid = 'unknown-kid';
      await receiptBox(page).fill(JSON.stringify(unknown, null, 2));
      await h.releaseKeys({ keys: [] });
      await expect(receiptBox(page)).toHaveValue(JSON.stringify(unknown, null, 2));
      await verifyButton(page, hash).click();
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'unverifiable');
      await expect(verdict(page)).toContainText('unknown-kid');
      // No trust root: the signature was never checked, so it is neither a pass
      // nor a cryptographic failure.
      const signatureRow = page.locator('[data-check-id="signature"], [data-stratum-key="signature"]');
      if (await signatureRow.count()) {
        await expect(signatureRow).not.toHaveAttribute('data-check-state', /pass|fail/);
        await expect(signatureRow).not.toHaveAttribute('data-stratum-state', /pass|fail/);
      }

      // A manual key verifies the same bytes against that key alone.
      await receiptBox(page).fill(JSON.stringify(sample, null, 2));
      await keyBox(page).fill(DEMO_TEST_KEY);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
      await verifyButton(page, hash).click();
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'valid');

      // Edit after VALID: positive indicators clear before any new verification.
      const before = (await h.states()).length;
      await keyBox(page).fill(WRONG_KEY);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
      await expect(passingRows(page)).toHaveCount(0);
      expect((await h.states()).slice(before)).not.toContain('valid');
    });

    test('a slow file read cannot overwrite a later edit', async ({ page }) => {
      await harness(page, { holdKeys: false, keys: { keys: [] } });
      await holdSlowReads(page);
      await primeSample(page, hash, loadSample);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'valid');
      const sample = await receiptBox(page).inputValue();

      await startSlowUpload(page, sample);
      await receiptBox(page).fill('{"typed":"after the upload started"}');
      await releaseSlowRead(page);
      await expect(receiptBox(page)).toHaveValue('{"typed":"after the upload started"}');
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
    });

    test('a slow file read cannot overwrite a later manual key', async ({ page }) => {
      // A published active key would make the uploaded receipt VALID by issuer
      // resolution; the user's later manual key must win over that.
      const h = await harness(page, { holdKeys: false, keys: ACTIVE_TEST_KEY_SET });
      await holdSlowReads(page);
      await primeSample(page, hash, loadSample);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'valid');
      const sample = await receiptBox(page).inputValue();

      // A different receipt than the one on screen.
      await startSlowUpload(page, LEGACY_RECEIPT);
      await keyBox(page).fill(WRONG_KEY);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
      const before = (await h.states()).length;
      await releaseSlowRead(page);

      await expect(keyBox(page)).toHaveValue(WRONG_KEY);
      await expect(receiptBox(page)).toHaveValue(sample);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
      await expect(page.getByRole('status').filter({ hasText: 'Stopped loading slow.json' })).toBeVisible();
      expect((await h.states()).slice(before)).not.toContain('valid');

      // Checking now uses exactly the key the user entered.
      await verifyButton(page, hash).click();
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'invalid');
      await expect(page.getByText('manual key, status bypassed', { exact: true })).toBeVisible();
      await expect(keyBox(page)).toHaveValue(WRONG_KEY);
    });

    test('a slow file read cannot undo a later key clear', async ({ page }) => {
      const h = await harness(page, { holdKeys: false, keys: ACTIVE_TEST_KEY_SET });
      await holdSlowReads(page);
      await primeSample(page, hash, loadSample);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'valid');
      const sample = await receiptBox(page).inputValue();
      await keyBox(page).fill(WRONG_KEY);

      await startSlowUpload(page, LEGACY_RECEIPT);
      const bypass = page.getByText('manual key, status bypassed', { exact: true });
      await expect(bypass).toBeVisible();
      await page.getByRole('button', { name: 'Use the issuer key instead' }).click();
      await expect(bypass).toHaveCount(0);
      await releaseSlowRead(page);

      // The editor keeps the receipt the user was looking at, with the issuer key
      // they chose; the superseded upload is reported, not silently applied.
      await expect(receiptBox(page)).toHaveValue(sample);
      await expect(bypass).toHaveCount(0);
      await expect(keyBox(page)).toHaveValue(DEMO_TEST_KEY);
      await expect(page.getByRole('status').filter({ hasText: 'Stopped loading slow.json' })).toBeVisible();
      void h;

      // With no later change, a new upload still lands and resolves the issuer key.
      await startSlowUpload(page, LEGACY_RECEIPT);
      await releaseSlowRead(page);
      await expect(receiptBox(page)).toHaveValue(LEGACY_RECEIPT);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'valid');
      await expect(page.getByRole('status').filter({ hasText: 'Stopped loading' })).toHaveCount(0);
    });

    test('revoked keys stay INVALID and unresolved trust stays UNVERIFIABLE', async ({ page }) => {
      await harness(page, {
        holdKeys: false,
        keys: { keys: [{ kid: 'test-kid-1', alg: 'Ed25519', public_key: DEMO_TEST_KEY, status: 'revoked' }] },
      });
      await primeSample(page, hash, loadSample);
      await expect(verdict(page)).toHaveAttribute('data-verification-state', 'invalid');
      await expect(verdict(page)).toContainText('revoked');
    });
  });
}

test('key discovery that never answers ends in an explicit unavailable state', async ({ page }) => {
  await harness(page);
  await page.goto('/#verify');
  await expect(page.getByRole('button', { name: 'Retry key lookup' })).toBeVisible({ timeout: 12_000 });
  // The labelled sample still verifies offline against the public test key.
  await page.getByRole('button', { name: 'Current drand sample' }).click();
  await expect(verdict(page)).toHaveAttribute('data-verification-state', 'valid');
  await expect(page.locator('[data-key-source="demo"]')).toBeVisible();
});

test('Verify opens empty and NOT CHECKED without a hand-off', async ({ page }) => {
  await harness(page, { holdKeys: false, keys: { keys: [] } });
  await page.goto('/#verify');
  await expect(receiptBox(page)).toHaveValue('');
  await expect(verdict(page)).toHaveAttribute('data-verification-state', 'not_checked');
  await expect(passingRows(page)).toHaveCount(0);
});
