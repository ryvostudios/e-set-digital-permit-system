import { defineConfig } from 'vitest/config';

/**
 * Test-runner configuration.
 *
 * The React plugin is deliberately not loaded here: it exists for fast
 * refresh, which tests never use, and Vite's own esbuild transform
 * already handles JSX from `tsconfig.app.json`'s `"jsx": "react-jsx"`.
 *
 * `setupFiles` resets browser storage between tests, so no auth state -
 * and in particular no persisted session - can leak from one test into
 * the next.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    /**
     * Vitest's 5s default is a wall-clock budget, and these are
     * user-event tests: each `await user.click(...)` advances real timers
     * while React re-renders. On a COLD transform cache the suite spends
     * ~25s transforming before any test body runs, and files sharing a
     * worker then blow the 5s budget - the same specs pass in ~1s each
     * once warm. That made the suite pass or fail depending on whether
     * the cache happened to be populated, which is not a signal about the
     * application at all.
     *
     * 20s is deliberately generous: it is not a real test's runtime, so a
     * genuine hang still fails - just not a cold cache.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
