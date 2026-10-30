import { defineConfig, devices } from '@playwright/test';

// 4174 serves the real production build (`dist`). 4175 serves a separate demo build
// with VITE_DEMO_FALLBACK=1, used only by the service-free simulated-receipt gates.
const baseURL = 'http://127.0.0.1:4174';
const demoBaseURL = 'http://127.0.0.1:4175';
const demoOutDir = '../../outputs/e2e-demo-dist';

export default defineConfig({
  testDir: './e2e',
  outputDir: '../../outputs/playwright-results',
  fullyParallel: false,
  // Locally a quarter of the cores, not Playwright's default half: on a 24-core
  // Windows host a new page took about 3 s alone and up to 30 s while twelve
  // browsers started together, which timed tests out, and six workers finish the
  // suite in the same wall time.
  workers: process.env.CI ? 1 : '25%',
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
  webServer: [
    {
      command: 'corepack pnpm preview --host 127.0.0.1 --port 4174 --strictPort',
      url: baseURL,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        `corepack pnpm exec vite build --outDir ${demoOutDir} --emptyOutDir` +
        ` && corepack pnpm exec vite preview --outDir ${demoOutDir} --host 127.0.0.1 --port 4175 --strictPort`,
      url: demoBaseURL,
      env: { VITE_DEMO_FALLBACK: '1' },
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
  projects: [
    {
      name: 'service-free-desktop',
      testMatch: 'service-free.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: demoBaseURL,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'service-free-mobile',
      testMatch: 'service-free.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: demoBaseURL,
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'production-mode-desktop',
      testMatch: /(production-mode|verdict-binding|beta-flows)\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
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
