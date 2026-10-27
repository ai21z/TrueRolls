import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const DEMO_TEST_KEY = 'IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=';

let consoleErrors: string[] = [];
let pageErrors: string[] = [];

async function isolateFromServices(page: Page) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    const apiPath = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!local || apiPath) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  pageErrors = [];
  page.on('console', (message) => {
    const text = message.text();
    const expectedAbort = text.startsWith('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT');
    if (message.type() === 'error' && !expectedAbort) consoleErrors.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await isolateFromServices(page);
});

test.afterEach(() => {
  expect(consoleErrors, 'browser console errors').toEqual([]);
  expect(pageErrors, 'unhandled page errors').toEqual([]);
});

test('mock roll stays Demo, starts uniform, and clear cannot reuse trust state', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Demo mode, receipts are simulated.')).toBeVisible();

  const kappa = page.getByRole('slider', { name: 'Karma value' });
  await expect(kappa).toHaveValue('0');

  const bars = page.locator('[aria-label="Probability distribution preview"] [data-probability]');
  await expect(bars).toHaveCount(20);
  const probabilities = await bars.evaluateAll((elements) =>
    elements.map((element) => Number((element as HTMLElement).dataset.probability)),
  );
  for (const probability of probabilities) {
    expect(Math.abs(probability - 0.05)).toBeLessThan(1e-12);
  }

  await page.getByRole('button', { name: 'Roll a die', exact: true }).click();
  await expect(page.locator('[data-trust-label="Demo"]')).toBeVisible();
  await expect(page.locator('[data-trust-label="Signed"]')).toHaveCount(0);
  await expect(page.locator('[data-trust-label="Verified"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Clear all transcripts' }).click();
  await expect(page.locator('[data-trust-label]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Roll a die', exact: true }).click();
  await expect(page.locator('[data-trust-label="Demo"]')).toBeVisible();
  await expect(page.locator('[data-trust-label="Verified"]')).toHaveCount(0);
});

test('primary, legacy, tampered, unknown-kid, and manual-key states are explicit', async ({ page }) => {
  const heroRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('HeroCanvas-')) heroRequests.push(request.url());
  });
  await page.goto('/#verify');
  const result = page.locator('[data-verification-state]');
  await expect(result).toHaveAttribute('data-verification-state', 'valid');
  await expect(page.locator('[data-check-id="drand"]')).toBeVisible();
  await expect(page.getByText('For truerolls-drand-1, VALID proves', { exact: false })).toBeVisible();
  expect(heroRequests, 'Verify must not load the lazy Three.js hero').toEqual([]);

  await page.getByRole('button', { name: 'Flip face' }).click();
  await expect(result).toHaveAttribute('data-verification-state', 'invalid');

  await page.getByRole('button', { name: 'Legacy control' }).click();
  await expect(result).toHaveAttribute('data-verification-state', 'valid');
  await expect(page.locator('[data-check-id="drand"]')).toHaveCount(0);
  await expect(page.getByText(
    'For legacy truerolls-1, VALID proves signed replay and bounded math only.',
    { exact: true },
  )).toBeVisible();

  await page.getByRole('button', { name: 'Tampered control' }).click();
  await expect(result).toHaveAttribute('data-verification-state', 'invalid');
  await expect(page.locator('[data-check-id="drand"]')).toBeVisible();

  await page.getByRole('button', { name: 'Current drand sample' }).click();
  const receiptInput = page.getByRole('textbox', { name: 'Receipt JSON' });
  const unknownReceipt = JSON.parse(await receiptInput.inputValue()) as {
    sig: { kid: string };
  };
  unknownReceipt.sig.kid = 'unknown-kid';
  await receiptInput.fill(JSON.stringify(unknownReceipt, null, 2));
  await page.getByRole('button', { name: 'Verify in your browser' }).click();
  await expect(result).toHaveAttribute('data-verification-state', 'unverifiable');
  await expect(page.getByText('UNVERIFIABLE', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Current drand sample' }).click();
  const keyInput = page.getByRole('textbox', { name: /Ed25519 public key/ });
  await keyInput.fill('');
  await keyInput.fill(DEMO_TEST_KEY);
  await expect(page.locator('[data-key-source="manual"]')).toBeVisible();
  await expect(page.getByText('manual key, status bypassed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Verify in your browser' }).click();
  await expect(result).toHaveAttribute('data-verification-state', 'valid');
});

test('Behind a Roll never flashes INVALID before verification completes', async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as Window & { __verificationStates?: string[] };
    target.__verificationStates = [];
    const record = () => {
      for (const element of document.querySelectorAll('[data-verification-state]')) {
        const state = element.getAttribute('data-verification-state');
        if (state && target.__verificationStates?.at(-1) !== state) {
          target.__verificationStates?.push(state);
        }
      }
    };
    new MutationObserver(record).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ['data-verification-state'],
    });
  });

  await page.goto('/#behind-a-roll');
  const result = page.locator('[data-verification-state]');
  await expect(result).toHaveAttribute('data-verification-state', 'valid');
  const states = await page.evaluate(() =>
    (window as Window & { __verificationStates?: string[] }).__verificationStates ?? [],
  );
  expect(states).toContain('valid');
  expect(states).not.toContain('invalid');

  const receiptInput = page.getByRole('textbox', { name: 'Receipt JSON' });
  const changed = JSON.parse(await receiptInput.inputValue()) as { face: number };
  changed.face += 1;
  await receiptInput.fill(JSON.stringify(changed, null, 2));
  await expect(result).toHaveAttribute('data-verification-state', 'not_checked');
  await page.getByRole('button', { name: 'Re-examine in your browser' }).click();
  await expect(result).toHaveAttribute('data-verification-state', 'invalid');
});

test('pages have no serious accessibility findings or horizontal overflow', async ({ page }) => {
  for (const route of ['/', '/#verify', '/#behind-a-roll']) {
    await page.goto(route);
    if (route !== '/') {
      await expect(page.locator('[data-verification-state]')).toHaveAttribute(
        'data-verification-state',
        'valid',
      );
    }

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);

    const scan = await new AxeBuilder({ page }).analyze();
    const serious = scan.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(serious).toEqual([]);
  }
});

test('keyboard focus is visible and reduced motion suppresses ceremony autoplay', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#behind-a-roll');
  await expect(page.locator('[data-verification-state]')).toHaveAttribute(
    'data-verification-state',
    'valid',
  );
  await expect(page.getByRole('button', { name: /Pause|Play/ })).toHaveCount(0);

  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return null;
    const style = getComputedStyle(element);
    return { tag: element.tagName, outline: style.outlineStyle, width: style.outlineWidth };
  });
  expect(focus?.tag).not.toBe('BODY');
  expect(focus?.outline).not.toBe('none');
  expect(focus?.width).not.toBe('0px');
});
