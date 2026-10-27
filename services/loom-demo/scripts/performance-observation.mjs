#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const BASE_URL = process.env.PERF_BASE_URL ?? 'http://127.0.0.1:4175';
const RUNS = 7;
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

function percentile50(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(runs, key) {
  const values = runs.map((run) => run[key]);
  return { median: percentile50(values), max: Math.max(...values) };
}

const browser = await chromium.launch();
const browserVersion = browser.version();
const results = [];

try {
  for (const viewport of viewports) {
    const runs = [];
    for (let index = 0; index < RUNS; index += 1) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        const expectedAbort = message.text().startsWith('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT');
        if (message.type() === 'error' && !expectedAbort) errors.push(message.text());
      });
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
        const apiPath = url.pathname === '/api' || url.pathname.startsWith('/api/');
        if (!local || apiPath) await route.abort('blockedbyclient');
        else await route.continue();
      });

      const cdp = await context.newCDPSession(page);
      let transferBytes = 0;
      await cdp.send('Network.enable');
      cdp.on('Network.loadingFinished', (event) => {
        transferBytes += event.encodedDataLength;
      });

      await page.goto(BASE_URL, { waitUntil: 'networkidle' });
      await page.getByText('Demo mode, receipts are simulated.').waitFor();
      const navigation = await page.evaluate(() => {
        const entry = performance.getEntriesByType('navigation')[0];
        if (!(entry instanceof PerformanceNavigationTiming)) throw new Error('navigation timing absent');
        return {
          domContentLoadedMs: entry.domContentLoadedEventEnd,
          loadMs: entry.loadEventEnd,
        };
      });

      const interactionStart = await page.evaluate(() => performance.now());
      await page.getByRole('button', { name: 'Roll a die', exact: true }).click();
      await page.locator('[data-trust-label="Demo"]').waitFor();
      const interactionEnd = await page.evaluate(() => performance.now());
      if (errors.length > 0) throw new Error(`${viewport.name} run ${index + 1}: ${errors.join('; ')}`);

      runs.push({
        run: index + 1,
        transferBytes: Math.round(transferBytes),
        domContentLoadedMs: navigation.domContentLoadedMs,
        loadMs: navigation.loadMs,
        primaryInteractionMs: interactionEnd - interactionStart,
      });
      await context.close();
    }

    results.push({
      viewport,
      runs,
      summary: {
        transferBytes: summarize(runs, 'transferBytes'),
        domContentLoadedMs: summarize(runs, 'domContentLoadedMs'),
        loadMs: summarize(runs, 'loadMs'),
        primaryInteractionMs: summarize(runs, 'primaryInteractionMs'),
      },
    });
  }
} finally {
  await browser.close();
}

const report = {
  schema: 'truerolls.performance-observation.v1',
  observedAtUtc: new Date().toISOString(),
  baseUrl: BASE_URL,
  coldCache: true,
  workers: 1,
  runsPerViewport: RUNS,
  browser: { name: 'Chromium', version: browserVersion },
  host: {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    logicalCpus: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  },
  results,
  claimBoundary: 'Local lab observation only. Not a deterministic gate or public performance claim.',
};

const output = path.resolve(process.cwd(), '..', '..', 'outputs', 'performance-observation.json');
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
console.log(`[performance-observation] wrote ${output}`);
