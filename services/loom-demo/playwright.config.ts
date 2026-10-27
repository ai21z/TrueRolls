import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4174';

export default defineConfig({
  testDir: './e2e',
  outputDir: '../../outputs/playwright-results',
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['line'], ['html', { outputFolder: '../../outputs/playwright-report', open: 'never' }]]
    : 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'corepack pnpm preview --host 127.0.0.1 --port 4174 --strictPort',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  projects: [
    {
      name: 'service-free-desktop',
      testMatch: 'service-free.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'service-free-mobile',
      testMatch: 'service-free.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'live-drand-desktop',
      testMatch: 'live-drand.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
