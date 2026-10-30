import { expect, test, type Page } from '@playwright/test';

// Runs against the real production build (no VITE_DEMO_FALLBACK). With the API
// unreachable the site must say so and must never mint simulated receipts.

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

test('unreachable API shows unavailable state and never simulates a receipt', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-api-state="unavailable"]')).toBeVisible();
  await expect(page.getByText('API unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('Demo mode, receipts are simulated.')).toHaveCount(0);

  // The outcome is announced once, at the control that started the roll.
  await page.getByRole('button', { name: 'Roll a die', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'TrueRolls' })
      .getByText('The TrueRolls API is unavailable right now. No roll request was sent.'),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.locator('[data-trust-label]')).toHaveCount(0);
});
