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
  },
});
