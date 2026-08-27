import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Test environment setup.
 *
 * The browser APIs jsdom does not implement, plus a hard reset between
 * tests so no state - and in particular no auth state - can leak from
 * one test into the next.
 */

/**
 * jsdom implements neither of these; several screens use them.
 *
 * `matchMedia` answers TRUE for a `min-width` query, so the test
 * environment behaves like a wide screen. Screens that adapt to width
 * (the collapsible filter panel) then render in their expanded desktop
 * form, which is what the interaction tests drive.
 */
if (!('matchMedia' in window)) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

if (!('scrollTo' in window)) {
  Object.defineProperty(window, 'scrollTo', { writable: true, value: () => {} });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
