import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setAccessTokenProvider, setSessionEndedHandler } from '../api/client';
import { getCurrentUser } from '../api/endpoints';
import { asApiError, type ApiError } from '../api/errors';
import type { CurrentUser } from '../api/types';
import { clearCaches } from '../lib/cache';
import { clearServiceWorkerCaches } from '../pwa/register';
import { deriveCapabilities, type Capabilities } from './capabilities';
import {
  clearPersistedSession,
  getAccessToken,
  isSupabaseConfigured,
  setRememberPreference,
  supabase,
} from './supabaseClient';

/**
 * THE authoritative current-user bootstrap.
 *
 * Authentication and IDENTITY are two different things here, and the
 * separation is the whole point:
 *
 *   Supabase proves only that a person holds valid credentials. It is
 *   never asked who they are in this application.
 *
 *   `GET /auth/me` is the ONLY source of application identity: the
 *   display name, the Company/Team/Position (or the absence of all
 *   three), the privileged roles, the effective capabilities, and
 *   whether a password change is outstanding. Nothing is ever read from
 *   the JWT payload, from `user_metadata`, or from the email address.
 *
 * If `/auth/me` refuses the session - a disabled, deleted, or
 * de-provisioned account - the frontend tears its own state down and
 * returns to login rather than rendering a shell for an account the
 * backend has stopped accepting.
 */

export type AuthPhase =
  /** Restoring a persisted Supabase session, before anything is known. */
  | 'initializing'
  /** No session: show login. */
  | 'signed-out'
  /** Session held, `/auth/me` in flight. */
  | 'loading-identity'
  /** Session held, but `/auth/me` could not be reached. */
  | 'identity-unavailable'
  /** Fully bootstrapped. */
  | 'ready';

export interface AuthState {
  phase: AuthPhase;
  user: CurrentUser | null;
  capabilities: Capabilities | null;
  /** Present only in `identity-unavailable`, so the shell can explain what failed. */
  identityError: ApiError | null;
  signIn: (email: string, password: string, remember: boolean) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-reads `/auth/me`. Used after a forced password change, and whenever authorization may have shifted. */
  refreshIdentity: () => Promise<void>;
}

export const AuthContext = createContext<AuthState | null>(null);

/** Thrown by `signIn` so the login form can show a precise, non-enumerating message. */
export class SignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignInError';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<AuthPhase>('initializing');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [identityError, setIdentityError] = useState<ApiError | null>(null);
  /** Guards against a resolved bootstrap overwriting a newer sign-out. */
  const generation = useRef(0);

  // The API client asks for a token per request rather than holding one,
  // so a sign-out immediately stops it being able to authenticate.
  useEffect(() => {
    setAccessTokenProvider(getAccessToken);
  }, []);

  /**
   * Wipes every trace of the previous account from this tab. Called on
   * sign-out AND whenever the backend ends a session, so no cached
   * permit, employee record, or notification can ever be shown to the
   * next person who signs in on this device.
   */
  const resetLocalState = useCallback(() => {
    generation.current += 1;
    setUser(null);
    setIdentityError(null);
    clearCaches();
    clearServiceWorkerCaches();
  }, []);

  const loadIdentity = useCallback(async (): Promise<void> => {
    const current = generation.current;
    setPhase('loading-identity');
    try {
      const me = await getCurrentUser();
      if (generation.current !== current) return;
      setUser(me);
      setIdentityError(null);
      setPhase('ready');
    } catch (error) {
      if (generation.current !== current) return;
      const apiError = asApiError(error);
      if (apiError.isSessionEnded) {
        // The backend has stopped accepting this session (disabled,
        // deleted, or never provisioned). End it locally too.
        await supabase.auth.signOut().catch(() => undefined);
        clearPersistedSession();
        resetLocalState();
        setPhase('signed-out');
        return;
      }
      setUser(null);
      setIdentityError(apiError);
      setPhase('identity-unavailable');
    }
  }, [resetLocalState]);

  // A 401 from ANY endpoint means the session is over. Handled centrally
  // so no individual screen has to notice.
  useEffect(() => {
    setSessionEndedHandler(() => {
      void (async () => {
        await supabase.auth.signOut().catch(() => undefined);
        clearPersistedSession();
        resetLocalState();
        setPhase('signed-out');
      })();
    });
    return () => setSessionEndedHandler(() => {});
  }, [resetLocalState]);

  // Restore a persisted session on load, then follow Supabase's own
  // auth state (token refresh, sign-out in another tab).
  useEffect(() => {
    if (!isSupabaseConfigured) {
      setPhase('signed-out');
      return;
    }

    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) void loadIdentity();
      else setPhase('signed-out');
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((event, session) => {
      if (cancelled) return;
      if (event === 'SIGNED_OUT' || !session) {
        resetLocalState();
        setPhase('signed-out');
      }
      // SIGNED_IN and TOKEN_REFRESHED are deliberately not acted on
      // here: `signIn` drives the bootstrap itself, and a token refresh
      // changes no identity.
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, [loadIdentity, resetLocalState]);

  const signIn = useCallback(
    async (email: string, password: string, remember: boolean): Promise<void> => {
      if (!isSupabaseConfigured) {
        throw new SignInError('Sign-in is not configured for this environment.');
      }
      // Recorded BEFORE the call, so the session Supabase is about to
      // write lands in the store the person chose.
      setRememberPreference(remember);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        // Deliberately one message for every credential failure: never
        // reveal whether an address exists.
        throw new SignInError(
          error.status === 400 || error.status === 401
            ? 'Email or password is incorrect.'
            : 'Sign-in is unavailable right now. Please try again.',
        );
      }
      // Nothing is trusted from the sign-in response - identity comes
      // from `/auth/me` and nowhere else.
      await loadIdentity();
    },
    [loadIdentity],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await supabase.auth.signOut().catch(() => undefined);
    clearPersistedSession();
    // The preference is cleared too, so the next sign-in starts from the
    // safe default (session-scoped) rather than inheriting a choice.
    setRememberPreference(false);
    resetLocalState();
    setPhase('signed-out');
  }, [resetLocalState]);

  const value = useMemo<AuthState>(
    () => ({
      phase,
      user,
      capabilities: user ? deriveCapabilities(user) : null,
      identityError,
      signIn,
      signOut,
      refreshIdentity: loadIdentity,
    }),
    [phase, user, identityError, signIn, signOut, loadIdentity],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
