import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The browser Supabase client - AUTHENTICATION ONLY.
 *
 * This client holds the publishable (anon) key and nothing else. It is
 * never used to read or write an application table: every piece of
 * application data in this frontend comes from the backend API, which
 * re-verifies the token and re-resolves authorization server-side. A
 * service-role key, a database URL, or any operator credential must
 * never appear in this file or in any `VITE_*` variable.
 *
 * ---------------------------------------------------------------------
 * REMEMBER ME
 * ---------------------------------------------------------------------
 *
 * Supabase's JS client decides where to persist a session when it is
 * CONSTRUCTED, not per sign-in, and it keeps one client instance per
 * page. "Remember me" is therefore implemented as a custom storage
 * adapter installed on the single client: the adapter decides, at write
 * time, which browser store the session goes to.
 *
 *   Checked   -> `localStorage`: the session survives closing the
 *                browser, and Supabase's own refresh flow keeps it
 *                alive.
 *   Unchecked -> `sessionStorage`: the session lives only for this tab.
 *                Closing the tab ends it.
 *
 * THE PASSWORD IS NEVER PERSISTED, in either mode. What is stored is
 * exactly what Supabase itself stores - its session object - and nothing
 * this application writes. Nothing is hand-serialized, and no credential
 * ever passes through the adapter as a value we construct.
 *
 * DOCUMENTED LIMITATION. Because the preference must be known before the
 * first read, it is recorded in one small non-sensitive flag
 * (`REMEMBER_FLAG_KEY`, a literal "1"/absent) in `localStorage`. That
 * flag is not a credential and reveals nothing about the account. On
 * sign-out both stores are cleared, so a subsequent "unchecked" login can
 * never inherit a previously persisted session.
 */

const supabaseUrl: string | undefined = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey: string | undefined = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

/** Whether the browser has been configured with the public Supabase settings this app needs. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey);

const REMEMBER_FLAG_KEY = 'eset.auth.remember';

/** Storage can throw (private mode, blocked site data). Every access here is guarded. */
function safeStorage(kind: 'local' | 'session'): Storage | null {
  try {
    const storage = kind === 'local' ? window.localStorage : window.sessionStorage;
    const probe = '__eset_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** Reads the persisted "remember me" preference. Defaults to false - session-scoped is the safer default. */
export function getRememberPreference(): boolean {
  try {
    return safeStorage('local')?.getItem(REMEMBER_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Records the preference for the CURRENT sign-in. Called immediately
 * before `signInWithPassword`, so the session Supabase is about to write
 * lands in the store the person chose.
 */
export function setRememberPreference(remember: boolean): void {
  try {
    const storage = safeStorage('local');
    if (!storage) return;
    if (remember) storage.setItem(REMEMBER_FLAG_KEY, '1');
    else storage.removeItem(REMEMBER_FLAG_KEY);
  } catch {
    /* Storage unavailable: fall back to session-scoped persistence. */
  }
}

/**
 * A storage adapter that routes every write to whichever store the
 * current preference names, and reads from both (session first) so a
 * freshly-written session is found regardless of which store holds it.
 * Removal always clears BOTH, so no copy of a session can survive a
 * sign-out in the store that wasn't active.
 */
const rememberAwareStorage = {
  getItem(key: string): string | null {
    try {
      return safeStorage('session')?.getItem(key) ?? safeStorage('local')?.getItem(key) ?? null;
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      const remember = getRememberPreference();
      const target = safeStorage(remember ? 'local' : 'session');
      target?.setItem(key, value);
      // Never leave a stale copy in the other store.
      safeStorage(remember ? 'session' : 'local')?.removeItem(key);
    } catch {
      /* Nothing persists; the session simply lasts as long as the page. */
    }
  },
  removeItem(key: string): void {
    try {
      safeStorage('session')?.removeItem(key);
      safeStorage('local')?.removeItem(key);
    } catch {
      /* Nothing to remove. */
    }
  },
};

/**
 * Created even when configuration is missing so the module has no
 * import-time throw - the login screen renders a clear, professional
 * "not configured for this environment" state instead of a blank page.
 */
export const supabase: SupabaseClient = createClient(
  supabaseUrl ?? 'https://unconfigured.invalid',
  supabasePublishableKey ?? 'unconfigured',
  {
    auth: {
      storage: rememberAwareStorage,
      persistSession: true,
      autoRefreshToken: true,
      // This application never handles an OAuth/magic-link redirect, so
      // the client must not try to read one out of the URL.
      detectSessionInUrl: false,
    },
  },
);

/** The current access token, or null. The ONLY way the API client obtains one. */
export async function getAccessToken(): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

/** Clears every trace of an authenticated session from both browser stores. */
export function clearPersistedSession(): void {
  for (const kind of ['local', 'session'] as const) {
    try {
      const storage = safeStorage(kind);
      if (!storage) continue;
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key && key.startsWith('sb-')) keys.push(key);
      }
      for (const key of keys) storage.removeItem(key);
    } catch {
      /* Nothing to clear. */
    }
  }
}
