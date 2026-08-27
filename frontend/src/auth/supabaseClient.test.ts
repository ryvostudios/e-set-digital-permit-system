import { beforeEach, describe, expect, it } from 'vitest';
import { clearPersistedSession, getRememberPreference, setRememberPreference } from './supabaseClient';

/**
 * Remember Me, and what it does to browser storage.
 *
 * The rule this pins: THE PASSWORD IS NEVER PERSISTED, in either mode.
 * Checked persists the Supabase session across browser restarts;
 * unchecked keeps it to the tab. The only thing this application itself
 * writes is a non-sensitive preference flag.
 */

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('the preference', () => {
  it('defaults to false - session-scoped is the safer default', () => {
    expect(getRememberPreference()).toBe(false);
  });

  it('round-trips a checked choice', () => {
    setRememberPreference(true);
    expect(getRememberPreference()).toBe(true);
  });

  it('is removed rather than stored as "false"', () => {
    setRememberPreference(true);
    setRememberPreference(false);
    expect(getRememberPreference()).toBe(false);
    expect(window.localStorage.getItem('eset.auth.remember')).toBeNull();
  });

  it('is a literal flag, and carries nothing about the account', () => {
    setRememberPreference(true);
    expect(window.localStorage.getItem('eset.auth.remember')).toBe('1');
  });
});

describe('what is written to browser storage', () => {
  it('never contains a password, in either mode', () => {
    for (const remember of [true, false]) {
      window.localStorage.clear();
      window.sessionStorage.clear();
      setRememberPreference(remember);

      const stored = [
        ...Object.entries({ ...window.localStorage }),
        ...Object.entries({ ...window.sessionStorage }),
      ]
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('|');

      for (const forbidden of ['password', 'secret', 'service_role', 'DATABASE_URL']) {
        expect(stored.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
  });

  it('writes exactly one key of its own', () => {
    setRememberPreference(true);
    expect(Object.keys({ ...window.localStorage })).toEqual(['eset.auth.remember']);
  });
});

describe('clearing a session', () => {
  it('removes Supabase session keys from BOTH stores, so an unchecked login cannot inherit a persisted one', () => {
    window.localStorage.setItem('sb-project-auth-token', 'persisted');
    window.sessionStorage.setItem('sb-project-auth-token', 'tab-scoped');
    window.localStorage.setItem('unrelated-app-key', 'keep me');

    clearPersistedSession();

    expect(window.localStorage.getItem('sb-project-auth-token')).toBeNull();
    expect(window.sessionStorage.getItem('sb-project-auth-token')).toBeNull();
    // Only auth keys are touched.
    expect(window.localStorage.getItem('unrelated-app-key')).toBe('keep me');
  });
});
