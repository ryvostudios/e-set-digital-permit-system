import { defineConfig, devices } from '@playwright/test';

/**
 * Real-browser visual QA.
 *
 * Vitest runs in jsdom, which has no layout engine: it can assert that a
 * label exists but never that the label is legible, unclipped, or that a
 * wide safety table scrolls instead of overflowing. The permit and JSA
 * documents have to reproduce printed operational forms, so those are
 * exactly the properties that matter. This config exists to check them in
 * a real Chromium.
 *
 * NO PRODUCTION CREDENTIALS. These specs drive the built frontend against
 * stubbed routes only - they never sign in to Supabase, never read
 * `backend/.env`, and never talk to the live API. Screenshots and traces
 * therefore cannot capture a token, a password, or real permit content.
 */

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/.artifacts',
  // A safety document renders a lot of rows; give it room without
  // hiding a genuine hang.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    // Traces would be the one artifact that could capture page content;
    // keep them off by default so nothing is written unless asked for.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },

  /**
   * The three representative viewports. Chromium only for this pass -
   * cross-browser coverage is not what these specs are for.
   */
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1024, height: 1366 } },
    },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: false },
    },
  ],

  /**
   * Serves the production build, so what is inspected is what ships -
   * not a dev-server variant with different CSS handling.
   */
  webServer: {
    // Builds with --mode e2e so the bundle is compiled against
    // .env.e2e's deliberately fake Supabase/API configuration - the
    // browser under test cannot reach the real project even if a route
    // stub were missed.
    command: `npm run build:e2e && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
