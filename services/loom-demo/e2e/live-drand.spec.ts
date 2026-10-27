import { expect, test } from '@playwright/test';

test('live roll verifies locally, tamper fails, and drand failure stays visible', async ({
  browser,
  page,
}) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let expectingDrandAbort = false;
  page.on('console', (message) => {
    const text = message.text();
    const expectedAbort = expectingDrandAbort && text.startsWith('Failed to load resource: net::ERR_FAILED');
    if (message.type() === 'error' && !expectedAbort) consoleErrors.push(text);
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByText('REC · LIVE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Roll a die', exact: true }).click();
  await expect(page.locator('[data-trust-label="Verified"]')).toBeVisible({ timeout: 45_000 });

  const receipt = await page.evaluate(() => {
    const records = JSON.parse(sessionStorage.getItem('kd-rolls') ?? '[]') as Array<
      Record<string, unknown>
    >;
    const entry = records[0];
    if (!entry) return null;
    const body: Record<string, unknown> = {
      v: entry.v,
      id: entry.id,
      die: entry.die,
      kappa: entry.kappa,
      face: entry.face,
      alpha: entry.alpha,
      kl: entry.kl,
      ev: entry.ev,
      created_at: entry.created_at,
      transcript_url: entry.transcript_url,
      proof: entry.proof,
      receipt_hash: entry.receipt_hash,
      sig: entry.sig,
    };
    if (entry.transcript_key != null) body.transcript_key = entry.transcript_key;
    return body;
  });
  expect(receipt).toBeTruthy();

  await page.goto('/#verify');
  const receiptInput = page.getByRole('textbox', { name: 'Receipt JSON' });
  await receiptInput.fill(JSON.stringify(receipt, null, 2));
  await page.getByRole('button', { name: 'Verify in your browser' }).click();
  const result = page.locator('[data-verification-state]');
  await expect(result).toHaveAttribute('data-verification-state', 'valid');
  await expect(page.locator('[data-check-id="drand"]')).toBeVisible();

  await page.getByRole('button', { name: 'Flip face' }).click();
  await expect(result).toHaveAttribute('data-verification-state', 'invalid');

  expect(consoleErrors).toEqual([]);
  expectingDrandAbort = true;
  await page.route(/^https:\/\/api(?:2|3)?\.drand\.sh\//, (route) => route.abort('failed'));
  await page.goto('/');
  await page.getByRole('button', { name: 'Roll a die', exact: true }).click();
  const hero = page.getByRole('region', { name: 'TrueRolls' });
  await expect(hero.getByRole('alert')).toBeVisible({ timeout: 10_000 });

  const proof = receipt as {
    proof?: { drand?: { target_round?: number } };
  };
  console.log(JSON.stringify({
    evidence_class: 'X',
    candidate_fingerprint: process.env.CANDIDATE_FINGERPRINT ?? 'not-supplied',
    utc: new Date().toISOString(),
    browser: browser.version(),
    drand_round: proof.proof?.drand?.target_round ?? null,
  }));

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
