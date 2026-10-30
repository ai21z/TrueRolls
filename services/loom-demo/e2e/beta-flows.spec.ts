import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import { PRIMARY_DRAND_RECEIPT } from '../src/generated/receiptFixtures';

// Production build, controlled transport (evidence class C). The roll and the
// API's /v1/verify answers are fixtures for presentation and transport only.
// Every browser-side verdict on the Verify page comes from the real WASM
// verifier checking the committed, test-key-signed golden receipt.

const DEMO_TEST_KEY = 'IHoGeJKCHiXXcPH7oMR8Ef9LgT5UFi7Onrg54HYjGrY=';
const ORIGINAL = JSON.parse(PRIMARY_DRAND_RECEIPT) as Record<string, unknown> & {
  id: string;
  face: number;
  kappa: number;
  receipt_hash: string;
  sig: { signature_b64: string };
  proof: { draw_u64: string; drand: Record<string, unknown> };
};
const PULSE = {
  round: ORIGINAL.proof.drand.client_observed_round,
  signature: ORIGINAL.proof.drand.client_observed_signature_hex,
  randomness: ORIGINAL.proof.drand.client_observed_randomness_hex,
};

type RollMode = 'ok' | 'lost' | '429' | 'hold';

interface Api {
  rollPosts: number;
  rollMode: RollMode;
  livezUp: boolean;
  held: Route[];
  releaseRolls: () => Promise<void>;
  holdVerify: boolean;
  heldVerify: Route[];
  releaseVerify: () => Promise<void>;
}

function apiVerifyAnswer(body: Record<string, unknown>) {
  // Presentation fixture: the edited copy changes a signed value, so the API
  // would reject its signature; the untouched original passes.
  const untouched = body.face === ORIGINAL.face && body.kappa === ORIGINAL.kappa;
  return {
    valid_signature: untouched,
    valid_drand: true,
    valid_sampling: true,
    face_ok: body.face === ORIGINAL.face,
    metrics_ok: body.kappa === ORIGINAL.kappa,
    details: {
      sig: untouched ? 'valid' : 'invalid',
      recomputed_face: ORIGINAL.face,
      recomputed_ev: ORIGINAL.ev,
      recomputed_kl: ORIGINAL.kl,
      recomputed_alpha: ORIGINAL.alpha,
      tol: 1e-9,
    },
    ...(untouched ? {} : { errors: ['Ed25519 signature verification failed'] }),
  };
}

async function installApi(page: Page, opts: { holdWasm?: boolean; failWasm?: boolean; holdLivez?: boolean } = {}) {
  const api: Api = {
    rollPosts: 0,
    rollMode: 'ok',
    livezUp: true,
    held: [],
    releaseRolls: async () => {
      for (const route of api.held.splice(0)) await fulfillRoll(route);
    },
    holdVerify: false,
    heldVerify: [],
    releaseVerify: async () => {
      for (const route of api.heldVerify.splice(0)) await fulfillVerify(route);
    },
  };
  const heldLivez: Route[] = [];
  const heldWasm: Route[] = [];
  const fulfillRoll = (route: Route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ ...ORIGINAL, deduplicated: false }),
    });

  const fulfillVerify = (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(apiVerifyAnswer(body)),
    });
  };

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (/^api\d?\.drand\.sh$/.test(url.hostname)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PULSE) });
    }
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (!local) return route.abort('blockedbyclient');
    if (url.pathname.endsWith('.wasm')) {
      if (opts.failWasm) return route.abort('failed');
      if (opts.holdWasm) {
        heldWasm.push(route);
        return;
      }
      return route.continue();
    }
    if (url.pathname === '/api/livez') {
      if (opts.holdLivez) {
        heldLivez.push(route);
        return;
      }
      return api.livezUp
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' })
        : route.abort('connectionrefused');
    }
    if (url.pathname === '/api/.well-known/truerolls-keys.json') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          keys: [{ kid: 'test-kid-1', alg: 'Ed25519', public_key: DEMO_TEST_KEY, status: 'active' }],
        }),
      });
    }
    if (url.pathname === '/api/v1/roll' && req.method() === 'POST') {
      api.rollPosts += 1;
      if (api.rollMode === 'lost') return route.abort('connectionreset');
      if (api.rollMode === '429') return route.fulfill({ status: 429, body: 'rate limited' });
      if (api.rollMode === 'hold') {
        api.held.push(route);
        return;
      }
      return fulfillRoll(route);
    }
    if (url.pathname === '/api/v1/verify' && req.method() === 'POST') {
      if (api.holdVerify) {
        api.heldVerify.push(route);
        return;
      }
      return fulfillVerify(route);
    }
    if (url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
    return route.continue();
  });

  return {
    api,
    releaseWasm: async () => {
      for (const r of heldWasm.splice(0)) await r.continue();
    },
    releaseLivez: async () => {
      for (const r of heldLivez.splice(0)) {
        await r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"ok"}' });
      }
    },
  };
}

const hero = (page: Page) => page.getByRole('region', { name: 'TrueRolls' });
const heroRoll = (page: Page) => hero(page).getByRole('button', { name: /^(Roll a die|Rolling…)$/ });

async function rollOnce(page: Page) {
  await heroRoll(page).click();
  await expect(hero(page).locator('[data-trust-label="Verified"]')).toBeVisible();
}

async function openReceipt(page: Page) {
  await page.getByRole('button', { name: 'View receipt' }).first().click();
  return page.getByRole('dialog', { name: 'Receipt' });
}

async function download(page: Page, button: ReturnType<Page['getByRole']>) {
  const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
  const path = await file.path();
  return { name: file.suggestedFilename(), text: await readFile(path, 'utf8'), path };
}

test.describe('original receipts and edited copies', () => {
  test('an edited copy never changes the original, its export or its status', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await rollOnce(page);

    const dialog = await openReceipt(page);
    await expect(dialog.locator('[data-receipt-status]')).toHaveText('Verified');
    const first = await download(page, dialog.getByRole('button', { name: 'Download .json' }));
    const exported = JSON.parse(first.text) as typeof ORIGINAL;
    expect(exported.id).toBe(ORIGINAL.id);
    expect(exported.receipt_hash).toBe(ORIGINAL.receipt_hash);
    expect(exported.sig.signature_b64).toBe(ORIGINAL.sig.signature_b64);
    expect(typeof exported.proof.draw_u64).toBe('string');
    expect(exported.proof.draw_u64).toBe(ORIGINAL.proof.draw_u64);
    expect(first.text).not.toContain('deduplicated');

    await dialog.getByRole('button', { name: 'Flip face' }).click();
    await dialog.getByRole('button', { name: 'Check the edited copy' }).click();
    await expect(dialog.locator('[data-edited-copy-verdict="invalid"]')).toBeVisible();
    await expect(dialog.locator('[data-receipt-status]')).toHaveText('Verified');

    const again = await download(page, dialog.getByRole('button', { name: 'Download .json' }));
    expect(again.text).toBe(first.text);
    const copyFile = await download(page, dialog.getByRole('button', { name: 'Download edited copy' }));
    expect(copyFile.name).toContain('edited-copy');
    expect(JSON.parse(copyFile.text).face).not.toBe(ORIGINAL.face);
    expect(JSON.parse(copyFile.text).sig.signature_b64).toBe(ORIGINAL.sig.signature_b64);

    await dialog.getByRole('button', { name: 'Close receipt' }).click();
    await expect(hero(page).locator('[data-trust-label="Verified"]')).toBeVisible();
    await expect(hero(page).locator('[data-copy-label="invalid"]')).toBeVisible();
    await expect(page.locator('[data-row-status="ok"]')).toHaveText('Verified');
    await expect(page.getByText('Tampered', { exact: false })).toHaveCount(0);

    // Reload: the original is re-checked before it shows a positive status again,
    // and the transient copy is gone.
    await page.reload();
    await expect(hero(page).locator('[data-trust-label="Verified"]')).toBeVisible();
    await expect(hero(page).locator('[data-copy-label]')).toHaveCount(0);
    await expect(page.getByText('Tampered', { exact: false })).toHaveCount(0);

    // The downloaded original verifies in the browser with the real WASM verifier.
    await page.goto('/#verify');
    await page.locator('input[type="file"]').setInputFiles(first.path);
    await expect(page.locator('[data-verification-state]')).toHaveAttribute('data-verification-state', 'valid');
    await expect(page.locator('[data-artifact-origin="file"]')).toBeVisible();
  });

  test('clearing local history asks first and can be cancelled', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await rollOnce(page);
    await page.getByRole('button', { name: 'Clear local history' }).click();
    const confirm = page.getByRole('group', { name: 'Confirm clearing local history' });
    await expect(confirm).toContainText('Receipts the API stored and files you downloaded are not affected');
    await confirm.getByRole('button', { name: 'Keep the list' }).click();
    await expect(page.getByRole('button', { name: 'View receipt' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Clear local history' }).click();
    await confirm.getByRole('button', { name: 'Clear local history' }).click();
    await expect(page.getByRole('button', { name: 'View receipt' })).toHaveCount(0);
  });
});

test.describe('hand-off to Verify', () => {
  test('"Verify this receipt" carries exactly the issued receipt', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await rollOnce(page);
    const dialog = await openReceipt(page);
    const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
    const leftAt = await scrollY();
    expect(leftAt).toBeGreaterThan(0);
    await dialog.getByRole('button', { name: 'Verify this receipt' }).click();

    await expect(page).toHaveURL(/#verify$/);
    await expect(page).toHaveTitle('Verify a receipt · TrueRolls');
    expect(await scrollY()).toBe(0);
    const box = page.getByRole('textbox', { name: 'Receipt JSON', exact: true });
    const handed = JSON.parse(await box.inputValue()) as typeof ORIGINAL;
    expect(handed.id).toBe(ORIGINAL.id);
    expect(handed.receipt_hash).toBe(ORIGINAL.receipt_hash);
    await expect(page.locator('[data-artifact-origin="handoff"]')).toContainText(ORIGINAL.id.slice(0, 8));
    await expect(page.locator('[data-verification-state]')).toHaveAttribute('data-verification-state', 'valid');
    await expect(page.locator('[data-key-source="well-known"]')).toBeVisible();
    await expect(page.locator('[data-key-test="public"]')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('tr-verify-handoff'))).toBeNull();

    // The programmatic hand-off is a history entry like a link: Back returns there.
    await page.goBack();
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');
    await expect.poll(scrollY).toBe(leftAt);
  });

  test('an unchanged copy cannot be handed off as an edited copy', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await rollOnce(page);
    const dialog = await openReceipt(page);
    const handOffs = [
      'Copy edited copy',
      'Download edited copy',
      'Verify edited copy in the browser',
      'Copy command for the copy',
    ].map((name) => dialog.getByRole('button', { name, exact: true }));
    for (const b of handOffs) await expect(b).toBeDisabled();
    await dialog.getByRole('button', { name: 'Flip face' }).click();
    for (const b of handOffs) await expect(b).toBeEnabled();
    await dialog.getByRole('button', { name: 'Discard edited copy' }).click();
    for (const b of handOffs) await expect(b).toBeDisabled();
    // The original keeps its own copy, download and command.
    for (const name of ['Copy receipt', 'Download .json', 'Copy verify command']) {
      await expect(dialog.getByRole('button', { name, exact: true })).toBeEnabled();
    }
  });

  test('an edited-copy hand-off is labelled and fails the expected checks', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await rollOnce(page);
    const dialog = await openReceipt(page);
    await dialog.getByRole('button', { name: 'Flip face' }).click();
    await dialog.getByRole('button', { name: 'Verify edited copy in the browser' }).click();
    await expect(page.locator('[data-artifact-origin="handoff"]')).toContainText('Edited copy');
    await expect(page.locator('[data-verification-state]')).toHaveAttribute('data-verification-state', 'invalid');
    await expect(page.locator('[data-check-id="signature"]')).toHaveAttribute('data-check-state', 'fail');
  });

  test('an expired hand-off says so instead of showing a sample', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await page.evaluate((receipt) => {
      sessionStorage.setItem(
        'tr-verify-handoff',
        JSON.stringify({
          token: 'old',
          receiptJson: receipt,
          rollId: 'x',
          kind: 'original',
          createdAt: Date.now() - 11 * 60 * 1000,
        }),
      );
      location.hash = '#verify';
    }, PRIMARY_DRAND_RECEIPT);
    await expect(page.getByText('expired before this page opened', { exact: false })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Receipt JSON', exact: true })).toHaveValue('');
    await expect(page.locator('[data-verification-state]')).toHaveAttribute('data-verification-state', 'not_checked');
  });
});

test.describe('startup and failures', () => {
  test('the shell renders while the API and the engine are still loading', async ({ page }) => {
    const ctl = await installApi(page, { holdWasm: true, holdLivez: true });
    await page.goto('/#docs');
    await expect(page.getByRole('heading', { level: 1, name: 'What is TrueRolls' })).toBeVisible();
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('[data-connection="checking"]')).toHaveText('REC · CHECKING');
    await expect(page.getByText('Loading the distribution engine')).toBeVisible();
    await expect(page.locator('[data-sample-verdict="loading"], [data-sample-verdict="idle"]')).toBeVisible();

    await ctl.releaseWasm();
    // Bars appear for the current die without touching any control.
    await expect(page.locator('[aria-label="Probability distribution preview"] [data-probability]')).toHaveCount(20);
    await page.locator('[data-sample-verdict]').scrollIntoViewIfNeeded();
    await expect(page.locator('[data-sample-verdict="VALID"]')).toBeVisible();
    await ctl.releaseLivez();
    await expect(page.locator('[data-connection="live"]')).toHaveText('REC · LIVE');
  });

  test('an engine failure is shown, never faked, and can be retried', async ({ page }) => {
    await installApi(page, { failWasm: true });
    await page.goto('/');
    await expect(page.getByText('The distribution engine failed to load')).toBeVisible();
    await expect(page.locator('[data-probability]')).toHaveCount(0);

    await page.goto('/#verify');
    await page.getByRole('button', { name: 'Current drand sample' }).click();
    const verdict = page.locator('[data-verification-state]');
    await expect(verdict).toHaveAttribute('data-verification-state', 'unverifiable');
    await expect(verdict).toContainText('engine failed to load');

    await page.unroute('**/*');
    await installApi(page);
    await verdict.getByRole('button', { name: 'Retry loading the engine' }).click();
    await expect(verdict).toHaveAttribute('data-verification-state', 'valid');
  });

  test('not sent, outcome unknown and refused are told apart, with no automatic repeat', async ({ page }) => {
    const { api } = await installApi(page);
    api.livezUp = false;
    await page.goto('/');
    await heroRoll(page).click();
    await expect(hero(page).getByRole('alert')).toContainText('No roll request was sent.');
    expect(api.rollPosts).toBe(0);

    api.livezUp = true;
    api.rollMode = 'lost';
    await hero(page).getByRole('button', { name: 'Dismiss roll error' }).click();
    await heroRoll(page).click();
    await expect(hero(page).getByRole('alert')).toContainText('could not be confirmed');
    await expect(hero(page).getByRole('alert')).toContainText('A receipt may exist on the server');
    await page.waitForTimeout(500);
    expect(api.rollPosts).toBe(1);

    api.rollMode = '429';
    await heroRoll(page).click();
    await expect(hero(page).getByRole('alert')).toContainText('Too many rolls right now');
    expect(api.rollPosts).toBe(2);
    await expect(page.getByRole('alert')).toHaveCount(1);
    await expect(page.getByText('TypeError')).toHaveCount(0);
  });

  test('repeated activation of both roll buttons sends one request', async ({ page }) => {
    const { api } = await installApi(page);
    api.rollMode = 'hold';
    await page.goto('/');
    await heroRoll(page).dblclick();
    await expect(heroRoll(page)).toBeDisabled();
    const stageRoll = page.getByRole('region', { name: 'Playground' }).getByRole('button', { name: /^(Roll|Rolling…)$/ });
    await expect(stageRoll).toBeDisabled();
    await expect(hero(page).locator('[data-roll-phase="submitted"]')).toContainText(
      `Requested drand round ${PULSE.round + 2}`,
    );
    await expect(hero(page).locator('[data-trust-label="Verified"]')).toHaveCount(0);
    await api.releaseRolls();
    await expect(hero(page).locator('[data-trust-label="Verified"]')).toBeVisible();
    expect(api.rollPosts).toBe(1);
  });
});

test.describe('keyboard, routing and touch', () => {
  test('Space on the page or a link never mints', async ({ page }) => {
    const { api } = await installApi(page);
    await page.goto('/');
    await page.locator('body').press('Space');
    await page.getByRole('link', { name: 'Docs' }).first().focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    expect(api.rollPosts).toBe(0);
    await expect(page.getByText('to roll', { exact: false })).toHaveCount(0);
  });

  test('route changes set the title, focus the heading and start at the top', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.getByRole('link', { name: 'Behind a roll' }).first().click();
    await expect(page).toHaveTitle('Behind a roll · TrueRolls');
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.goBack();
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);
  });

  test('Back and Forward return to each entry, including docs section entries', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApi(page);
    const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
    await page.goto('/');
    await page.evaluate(() => window.scrollTo(0, 1300));
    await expect.poll(scrollY).toBe(1300);

    // New link navigation starts at the top with the heading focused.
    await page.getByRole('link', { name: 'Docs' }).first().click();
    await expect(page).toHaveTitle('Docs · TrueRolls');
    expect(await scrollY()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('H1');

    // A reader position inside Docs, then a TOC section entry.
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect.poll(scrollY).toBe(400);
    const toc = page.getByRole('navigation', { name: 'On this page' });
    await toc.getByRole('link', { name: 'The receipt (drand)' }).click();
    await expect(page).toHaveURL(/#docs-receipt$/);
    await expect(page.locator('#receipt')).toBeInViewport();
    const sectionY = await scrollY();
    expect(sectionY).not.toBe(400);

    await page.goBack();
    await expect(page).toHaveURL(/#docs$/);
    await expect.poll(scrollY).toBe(400);
    await page.goBack();
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');
    await expect.poll(scrollY).toBe(1300);

    await page.goForward();
    await expect(page).toHaveURL(/#docs$/);
    await expect.poll(scrollY).toBe(400);
    await page.goForward();
    await expect(page).toHaveURL(/#docs-receipt$/);
    await expect.poll(scrollY).toBe(sectionY);

    // A new link after traversal is a new entry again: it starts at the top.
    await page.getByRole('link', { name: 'Back', exact: true }).click();
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');
    expect(await scrollY()).toBe(0);
  });

  test('a view whose code is still loading takes title, scroll and focus when it arrives', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApi(page);
    const held: Route[] = [];
    await page.route(/\/assets\/Docs-[^/]+\.js$/, (route) => {
      held.push(route);
    });
    const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
    await page.goto('/');
    await page.evaluate(() => window.scrollTo(0, 1300));
    await expect.poll(scrollY).toBe(1300);

    await page.getByRole('link', { name: 'Docs' }).first().click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(page.locator('main[aria-busy="true"]')).toBeAttached();
    // Nothing claims the new view before its content exists.
    await expect(page).not.toHaveTitle('Docs · TrueRolls');

    for (const route of held.splice(0)) await route.continue();
    await expect(page).toHaveTitle('Docs · TrueRolls');
    await expect(page.getByRole('heading', { level: 1, name: 'What is TrueRolls' })).toBeFocused();
    expect(await scrollY()).toBe(0);

    await page.goBack();
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');
    await expect.poll(scrollY).toBe(1300);
  });

  test('a direct section deep link still opens at that section', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApi(page);
    await page.goto('/#docs-receipt');
    await expect(page).toHaveTitle('Docs · TrueRolls');
    await expect(page.locator('#receipt')).toBeInViewport();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test('Back and Forward before a view finishes loading keep each entry', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApi(page);
    const held: Route[] = [];
    await page.route(/\/assets\/Docs-[^/]+\.js(\?.*)?$/, (route) => {
      held.push(route);
    });
    const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
    const home = page.getByRole('heading', { level: 1, name: /Roll\. Sign\./ });
    await page.goto('/');
    await page.evaluate(() => window.scrollTo(0, 1300));
    await expect.poll(scrollY).toBe(1300);

    await page.getByRole('link', { name: 'Docs' }).first().click();
    await expect.poll(() => held.length).toBeGreaterThan(0);
    await expect(page.getByRole('status').filter({ hasText: 'Loading Docs…' })).toBeVisible();

    // Back while Docs is still loading returns to the entry as it was left.
    await page.goBack();
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');
    await expect.poll(scrollY).toBe(1300);
    await expect(home).toBeFocused();

    // Forward to the still-loading entry, then Back again.
    await page.goForward();
    await expect(page.locator('main[aria-busy="true"]')).toBeAttached();
    await page.goBack();
    await expect.poll(scrollY).toBe(1300);

    // Rapid traversal, without waiting for any view to settle, ends on the last entry.
    await page.goForward();
    await page.goBack();
    await page.goForward();
    await page.goBack();
    await expect(page).not.toHaveURL(/#docs/);
    await expect.poll(scrollY).toBe(1300);
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');

    for (const route of held.splice(0)) await route.continue();
    await page.goForward();
    await expect(page).toHaveTitle('Docs · TrueRolls');
    await expect(page.getByRole('heading', { level: 1, name: 'What is TrueRolls' })).toBeFocused();
    expect(await scrollY()).toBe(0);
    await page.goBack();
    await expect.poll(scrollY).toBe(1300);
  });

  test('the header fits at 320px and the compact menu reaches every route', async ({ page }) => {
    await installApi(page);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toBeVisible();
    const boxes = await page.locator('header button, header a, header span').evaluateAll((els) =>
      els
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => el.getBoundingClientRect().right),
    );
    for (const right of boxes) expect(right).toBeLessThanOrEqual(320);
    await menu.click();
    for (const name of ['Verify', 'Behind a roll', 'Docs']) {
      const link = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name });
      await expect(link).toBeVisible();
      const box = await link.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(320);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' })).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Menu');
  });

  test('the karma slider takes touches across its whole track, ticks included', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    const slider = page.getByRole('slider', { name: 'Karma value' });
    await slider.scrollIntoViewIfNeeded();
    const box = (await slider.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    const hits = await page.evaluate(({ x, y, w, h }) => {
      const out: string[] = [];
      for (const fx of [0.02, 0.25, 0.5, 0.75, 0.98]) {
        for (const fy of [0.15, 0.5, 0.85]) {
          const el = document.elementFromPoint(x + w * fx, y + h * fy) as HTMLElement | null;
          out.push(el?.getAttribute('aria-label') ?? el?.tagName ?? 'none');
        }
      }
      return out;
    }, { x: box.x, y: box.y, w: box.width, h: box.height });
    expect(new Set(hits)).toEqual(new Set(['Karma value']));
  });
});

/** Fully inside the viewport, not merely present in the DOM. */
async function expectInViewport(page: Page, locator: ReturnType<Page['locator']>) {
  const box = await locator.boundingBox();
  const vp = page.viewportSize();
  expect(box, 'element has a layout box').not.toBeNull();
  expect(vp).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vp!.height);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(vp!.width);
  return box!;
}

for (const width of [375, 390]) {
  test.describe(`hero roll completion at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 375 ? 667 : 844 }, isMobile: true, hasTouch: true });

    test('the result and its API check stay next to the roll button', async ({ page }) => {
      const { api } = await installApi(page);
      api.holdVerify = true;
      await page.goto('/');
      const status = hero(page).getByRole('status').filter({ hasText: /TrueRolls API|API check/ });
      const result = hero(page).locator('[data-roll-result]');

      await heroRoll(page).click();
      // Receipt received, API check still pending.
      await expect(result).toContainText(`${ORIGINAL.face} on d20 · receipt received`);
      await expect(status).toHaveText('Checking the receipt with the TrueRolls API…');
      await expect.poll(() => api.heldVerify.length).toBeGreaterThan(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      const button = await expectInViewport(page, heroRoll(page));
      const statusBox = await expectInViewport(page, status);
      await expectInViewport(page, result);
      expect(statusBox.y - (button.y + button.height)).toBeLessThan(160);

      // API check completed: the words change in place, still in view.
      await api.releaseVerify();
      await expect(status).toHaveText('Checked by the TrueRolls API: Verified.');
      await expect(result).toHaveAttribute('data-roll-result', 'verified_server');
      await expectInViewport(page, status);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByRole('alert')).toHaveCount(0);

      // The full receipt is one explicit step away.
      await hero(page).getByRole('button', { name: 'Show the receipt' }).click();
      const card = page.locator('#hero-receipt');
      await expect(card).toBeFocused();
      await expect(card.locator('[data-trust-label="Verified"]')).toBeInViewport();
    });

    test('the result belongs to the roll just made, never an earlier one', async ({ page }) => {
      const { api } = await installApi(page);
      await page.goto('/');
      await rollOnce(page);
      const result = hero(page).locator('[data-roll-result]');
      await expect(result).toBeVisible();

      api.rollMode = 'hold';
      await heroRoll(page).click();
      await expect(result).toHaveCount(0);
      await expect(hero(page).locator('[data-roll-phase]')).toBeVisible();
      await api.releaseRolls();
      await expect(result).toBeVisible();
      await expect(hero(page).locator('[data-roll-phase]')).toHaveCount(0);

      api.rollMode = 'lost';
      await heroRoll(page).click();
      await expect(hero(page).getByRole('alert')).toBeVisible();
      await expect(result).toHaveCount(0);
      await expect(hero(page).getByRole('status').filter({ hasText: 'TrueRolls API' })).toHaveCount(0);
    });
  });
}

test.describe('the roll ceremony', () => {
  test('the play control names its action and claims no pressed state', async ({ page }) => {
    await installApi(page);
    await page.goto('/#behind-a-roll');
    const pause = page.getByRole('button', { name: /Pause/ });
    await expect(pause).toBeVisible();
    await expect(pause).not.toHaveAttribute('aria-pressed');
    await pause.click();
    await expect(page.getByRole('button', { name: /Play/ })).not.toHaveAttribute('aria-pressed');
  });

  for (const route of ['/#verify', '/#behind-a-roll']) {
    test(`${route}: the receipt and key fields show the focus ring`, async ({ page }) => {
      await installApi(page);
      await page.goto(route);
      for (const field of [
        page.getByRole('textbox', { name: 'Receipt JSON', exact: true }),
        page.locator('#pubkey'),
      ]) {
        await field.focus();
        const outline = await field.evaluate((el) => {
          const style = getComputedStyle(el);
          return `${style.outlineStyle} ${style.outlineWidth}`;
        });
        expect(outline).toBe('solid 2px');
      }
    });
  }

  test('reduced motion redraws the scene for a new state without a resize', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await installApi(page);
    await page.goto('/');
    await rollOnce(page);
    const canvas = hero(page).locator('canvas');
    await expect(canvas).toBeVisible();
    await page.waitForTimeout(400);
    const sealed = await canvas.screenshot();
    await hero(page).getByRole('button', { name: /Edit a copy/ }).click();
    await expect(hero(page).locator('[data-copy-label="invalid"]')).toBeVisible();
    await page.waitForTimeout(400);
    const fractured = await canvas.screenshot();
    expect(Buffer.compare(sealed, fractured)).not.toBe(0);
    await expect(hero(page).getByText('The fracture shows the edited copy failing')).toBeVisible();
  });

  test('the landing verifier card is real output, labelled as the sample', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    const card = page.locator('[data-sample-verdict]');
    // Below the fold it waits: the verification runs as the card approaches view.
    await expect(page.locator('[aria-label="Probability distribution preview"] [data-probability]')).toHaveCount(20);
    await expect(card).toHaveAttribute('data-sample-verdict', 'ready');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveAttribute('data-sample-verdict', 'VALID');
    await expect(card).toContainText('This is the sample receipt, not your roll.');
  });
});

test.describe('the playground keeps its content in view', () => {
  // The nearest scroll container of the preview is the stage.
  const stageFits = (page: Page) =>
    page.locator('[aria-label="Probability distribution preview"]').evaluate((el) => {
      let stage = el.parentElement;
      while (stage && getComputedStyle(stage).overflowY !== 'auto') stage = stage.parentElement;
      return stage ? stage.scrollHeight <= stage.clientHeight : null;
    });

  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    test(`at ${width}x${height} the preview keeps its height and a roll error is shown whole`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const { api } = await installApi(page);
      await page.goto('/');
      const playground = page.getByRole('region', { name: 'Playground' });
      const preview = playground.locator('[aria-label="Probability distribution preview"]');
      await expect(preview).toBeVisible();
      expect(Math.round((await preview.boundingBox())!.height)).toBe(60);
      expect(await stageFits(page)).toBe(true);

      api.rollMode = 'lost';
      await playground.getByRole('button', { name: /^(Roll|Rolling…)$/ }).click();
      await expect(playground.getByRole('alert')).toBeVisible();
      expect(Math.round((await preview.boundingBox())!.height)).toBe(60);
      expect(await stageFits(page)).toBe(true);
      await playground.getByRole('alert').scrollIntoViewIfNeeded();
      await expect(playground.getByText('Technical detail')).toBeInViewport();
    });
  }

  test('a long history scrolls inside its panel instead of stretching the playground', async ({ page }) => {
    await installApi(page);
    await page.goto('/');
    await rollOnce(page);
    const frameHeight = () =>
      page.getByRole('region', { name: 'Playground' }).locator('[aria-label="Probability distribution preview"]')
        .evaluate((el) => {
          let frame = el.parentElement;
          while (frame && getComputedStyle(frame).display !== 'grid') frame = frame.parentElement;
          return frame!.getBoundingClientRect().height;
        });
    const withOne = await frameHeight();
    await page.evaluate(() => {
      const [entry] = JSON.parse(sessionStorage.getItem('kd-rolls') ?? '[]') as Array<{ localId: number }>;
      const many = Array.from({ length: 40 }, (_, i) => ({ ...entry, localId: 40 - i }));
      sessionStorage.setItem('kd-rolls', JSON.stringify(many));
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'View receipt' }).nth(39)).toBeAttached();
    expect(await frameHeight()).toBe(withOne);
  });
});

test.describe('focus on the landing', () => {
  // Resolves once the page has not scrolled for five frames.
  const settle = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let last = Number.NaN;
          let still = 0;
          const tick = () => {
            still = window.scrollY === last ? still + 1 : 0;
            last = window.scrollY;
            if (still >= 5) resolve();
            else requestAnimationFrame(tick);
          };
          tick();
        }),
    );

  for (const width of [1440, 390]) {
    test(`at ${width}px a focused control is never under the sticky bar`, async ({ page }) => {
      await page.setViewportSize({ width, height: width > 1000 ? 900 : 844 });
      await installApi(page);
      await page.goto('/');
      await rollOnce(page);
      // Walk backwards from the end of the page, which scrolls each control in from above.
      await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
      await page.locator('footer a, footer button').last().focus();
      await settle(page);
      const hidden: string[] = [];
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Shift+Tab');
        // Focus scrolling may animate: judge where the control comes to rest.
        await settle(page);
        const under = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          const bar = document.querySelector('header');
          if (!el || el === document.body || !bar || bar.contains(el) || el.closest('[aria-label="Skip link"]')) return null;
          const top = el.getBoundingClientRect().top;
          const barBottom = bar.getBoundingClientRect().bottom;
          return top < barBottom ? `${el.tagName} "${el.textContent?.trim().slice(0, 30)}" at ${Math.round(top)}, bar ends ${Math.round(barBottom)}` : null;
        });
        if (under) hidden.push(under);
      }
      expect(hidden).toEqual([]);
    });
  }

  const PLAYGROUND = 'Roll it, verify it, try to break it.';
  for (const jump of [
    { button: 'Open playground', heading: PLAYGROUND },
    { button: 'Scroll to playground', heading: PLAYGROUND },
    { button: 'See the proof', heading: 'Three steps. Every one of them checkable.' },
  ]) {
    test(`"${jump.button}" moves focus to the section it shows`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await installApi(page);
      await page.goto('/');
      await page.getByRole('button', { name: jump.button, exact: true }).focus();
      await page.keyboard.press('Enter');
      const heading = page.getByRole('heading', { level: 2, name: jump.heading });
      await expect(heading).toBeFocused();
      await settle(page);
      const shownAt = await page.evaluate(() => window.scrollY);
      // The next Tab continues from that section instead of jumping back up.
      await page.keyboard.press('Tab');
      await settle(page);
      const next = await heading.evaluate(
        (h) => !!(h.compareDocumentPosition(document.activeElement!) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      expect(next).toBe(true);
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(shownAt);
    });
  }
});

test.describe('the roll status for screen readers', () => {
  const status = (page: Page) => page.locator('[data-roll-status]');

  test('one region, there before the first roll, names each phase and then the face', async ({ page }) => {
    const { api } = await installApi(page);
    await page.goto('/');
    await expect(status(page)).toHaveCount(1);
    await expect(status(page)).toHaveAttribute('role', 'status');
    await expect(status(page)).toHaveText('');

    api.rollMode = 'hold';
    await heroRoll(page).click();
    // One sentence for the phase, without the visible line's countdown or estimate,
    // which change every second.
    await expect(status(page)).toHaveText(/^Rolling\. Requested drand round \d+; waiting for the signed receipt\.$/);
    await api.releaseRolls();
    await expect(status(page)).toHaveText(/^Rolled \d+ on d20\./);
  });

  test('a failed roll never brings back the earlier face, in the status or under the button', async ({ page }) => {
    const { api } = await installApi(page);
    await page.goto('/');
    await rollOnce(page);
    await expect(status(page)).toHaveText(/^Rolled \d+ on d20\./);

    api.rollMode = 'lost';
    await heroRoll(page).click();
    await expect(hero(page).getByRole('alert')).toBeVisible();
    await expect(status(page)).toHaveText('');
    await hero(page).getByRole('button', { name: 'Dismiss roll error' }).click();
    await expect(hero(page).getByRole('alert')).toHaveCount(0);
    await expect(status(page)).toHaveText('');
    await expect(hero(page).locator('[data-roll-result]')).toHaveCount(0);
    await expect(hero(page).getByRole('status').filter({ hasText: 'TrueRolls API' })).toHaveCount(0);
  });
});

test.describe('a decoration whose code fails to download', () => {
  test('the hero keeps its placeholder, and rolls and navigation carry on', async ({ page }) => {
    const { api } = await installApi(page);
    let canvasRequests = 0;
    await page.route(/\/assets\/HeroCanvas-[^/]+\.js(\?.*)?$/, (route) => {
      canvasRequests += 1;
      return route.abort('failed');
    });
    const canvasFailed = page.waitForEvent('requestfailed', (request) => request.url().includes('/HeroCanvas-'));
    await page.goto('/');
    await canvasFailed;
    // The rejection reaches React about 300 ms later (an unguarded build emptied the
    // root after 336 ms), so look well after that.
    await page.waitForTimeout(1000);

    await expect(page.getByRole('heading', { level: 1, name: /Roll\. Sign\./ })).toBeVisible();
    await expect(hero(page).locator('[data-hero-placeholder]')).toBeVisible();
    await rollOnce(page);
    expect(api.rollPosts).toBe(1);

    await page.getByRole('link', { name: 'Docs' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'What is TrueRolls' })).toBeFocused();
    await page.goBack();
    await expect(hero(page).locator('[data-trust-label="Verified"]')).toBeVisible();
    await expect(hero(page).locator('[data-hero-placeholder]')).toBeVisible();
    expect(canvasRequests).toBe(1);
  });
});

test.describe('a view whose code fails to download', () => {
  // Aborts the view's chunk, including the new URL a later attempt asks for.
  async function blockChunk(page: Page, chunk: string) {
    const gate = { blocked: true, requests: 0 };
    await page.route(new RegExp(`/assets/${chunk}-[^/]+\\.js(\\?.*)?$`), (route) => {
      gate.requests += 1;
      return gate.blocked ? route.abort('failed') : route.continue();
    });
    return gate;
  }

  const VIEWS = [
    { hash: '#docs', chunk: 'Docs', label: 'Docs', title: 'Docs · TrueRolls', heading: 'What is TrueRolls' },
    { hash: '#verify', chunk: 'Verify', label: 'Verify', title: 'Verify a receipt · TrueRolls', heading: /Verify a receipt/ },
    {
      hash: '#behind-a-roll',
      chunk: 'BehindARoll',
      label: 'Behind a roll',
      title: 'Behind a roll · TrueRolls',
      heading: /Read a roll under glass/,
    },
  ];

  for (const v of VIEWS) {
    test(`${v.label}: the failure is contained, and Try again recovers without a reload or a new roll`, async ({
      page,
    }) => {
      const { api } = await installApi(page);
      const gate = await blockChunk(page, v.chunk);
      await page.goto('/');
      await rollOnce(page);
      // A reload would drop this marker.
      await page.evaluate(() => ((window as Window & { __sameDocument?: boolean }).__sameDocument = true));

      await page.evaluate((hash) => (window.location.hash = hash), v.hash);
      const failed = page.getByRole('heading', { level: 1, name: `${v.label} did not load.` });
      await expect(failed).toBeFocused();
      await expect(page).toHaveTitle(`${v.label} did not load · TrueRolls`);
      await expect(page.getByRole('alert')).toContainText(`The ${v.label} page could not be downloaded.`);
      await expect(page.getByRole('link', { name: 'Back to home' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Reload TrueRolls' })).toHaveCount(0);

      // Still offline: the retry really asks the network again, and fails again.
      const before = gate.requests;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('alert')).toContainText(`The ${v.label} page still could not be downloaded.`);
      expect(gate.requests).toBeGreaterThan(before);
      await expect(failed).toBeFocused();
      await expect(page.getByRole('button', { name: 'Reload TrueRolls' })).toBeEnabled();

      gate.blocked = false;
      await page.getByRole('button', { name: 'Try again' }).click();
      await expect(page.getByRole('heading', { level: 1, name: v.heading })).toBeFocused();
      await expect(page).toHaveTitle(v.title);

      await page.goBack();
      await expect(hero(page).locator('[data-trust-label="Verified"]')).toBeVisible();
      expect(api.rollPosts).toBe(1);
      expect(await page.evaluate(() => (window as Window & { __sameDocument?: boolean }).__sameDocument)).toBe(true);
    });
  }

  test('Back to home keeps the receipt, and the next visit downloads the view again', async ({ page }) => {
    const { api } = await installApi(page);
    const gate = await blockChunk(page, 'Docs');
    await page.goto('/');
    await rollOnce(page);
    await page.getByRole('link', { name: 'Docs' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Docs did not load.' })).toBeFocused();

    await page.getByRole('link', { name: 'Back to home' }).click();
    await expect(page).toHaveTitle('TrueRolls, verifiable dice');
    await expect(hero(page).locator('[data-trust-label="Verified"]')).toBeVisible();

    gate.blocked = false;
    await page.getByRole('link', { name: 'Docs' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'What is TrueRolls' })).toBeFocused();
    expect(api.rollPosts).toBe(1);
  });

  test('a failed shared chunk lasts until Reload, which keeps the completed receipt', async ({ page }) => {
    const { api } = await installApi(page);
    // Verify and Behind a roll both import this chunk. A new URL for the view's
    // own chunk still imports it under its old URL, which the browser keeps failed.
    const gate = await blockChunk(page, 'useReceiptVerification');
    await page.goto('/');
    await rollOnce(page);
    await page.evaluate(() => (window.location.hash = '#verify'));
    const failed = page.getByRole('heading', { level: 1, name: 'Verify did not load.' });
    await expect(failed).toBeFocused();

    gate.blocked = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('alert')).toContainText('The Verify page still could not be downloaded.');
    await expect(page.getByText('This browser can keep a failed download until TrueRolls reloads.')).toBeVisible();
    await expect(page.getByText('keeps the latest 100 completed receipts', { exact: false })).toBeVisible();
    expect(gate.requests).toBe(1);

    await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload TrueRolls' }).click()]);
    await expect(page.getByRole('heading', { level: 1, name: /Verify a receipt/ })).toBeVisible();
    await page.evaluate(() => (window.location.hash = ''));
    await expect(page.locator('[data-trust-label="Verified"]').first()).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('kd-rolls') ?? '[]').length)).toBe(1);
    expect(api.rollPosts).toBe(1);
  });

  test('Reload is withheld while a roll is waiting for its receipt', async ({ page }) => {
    const { api } = await installApi(page);
    await blockChunk(page, 'Docs');
    await page.goto('/');
    api.rollMode = 'hold';
    await heroRoll(page).click();
    await expect.poll(() => api.held.length).toBe(1);

    await page.evaluate(() => (window.location.hash = '#docs'));
    await expect(page.getByRole('heading', { level: 1, name: 'Docs did not load.' })).toBeFocused();
    await page.getByRole('button', { name: 'Try again' }).click();
    const reload = page.getByRole('button', { name: 'Reload TrueRolls' });
    await expect(reload).toBeDisabled();
    await expect(page.getByText('Wait for the roll in progress to return its receipt first', { exact: false })).toBeVisible();

    await api.releaseRolls();
    await expect(reload).toBeEnabled();
    await expect(page.getByText('Wait for the roll in progress')).toHaveCount(0);
    expect(api.rollPosts).toBe(1);
  });
});
