import { createContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiRequest, setSessionEndedHandler } from '../api/client';
import { getCurrentUser } from '../api/endpoints';
import { asApiError, type ApiError } from '../api/errors';
import type { CurrentUser } from '../api/types';
import { clearCaches } from '../lib/cache';
import { clearServiceWorkerCaches } from '../pwa/register';
import { deriveCapabilities, type Capabilities } from './capabilities';
import { clearLegacyCredentials } from './clearLegacyCredentials';

/** Backend /auth/me is the sole authority for identity and session restoration. */
export type AuthPhase =
  /** Restoring a backend cookie session, before anything is known. */
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
  const [signOutError, setSignOutError] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);

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
        resetLocalState();
        setPhase('signed-out');
        return;
      }
      setUser(null);
      setIdentityError(apiError);
      setPhase('identity-unavailable');
    }
  }, [resetLocalState]);

  useEffect(() => {
    setSessionEndedHandler(() => {
      resetLocalState();
      setPhase('signed-out');
    });
    return () => setSessionEndedHandler(() => {});
  }, [resetLocalState]);

  useEffect(() => {
    clearLegacyCredentials();
    void Promise.resolve().then(loadIdentity);
    const onFocus = () => { void loadIdentity(); };
    window.addEventListener('focus', onFocus);
    if (typeof BroadcastChannel !== 'undefined') {
      const current = new BroadcastChannel('permit-session-events');
      channel.current = current;
      current.onmessage = () => { void loadIdentity(); };
    }
    return () => {
      generation.current += 1;
      window.removeEventListener('focus', onFocus);
      channel.current?.close();
      channel.current = null;
    };
  }, [loadIdentity]);

  const signIn = useCallback(async (email: string, password: string, remember: boolean): Promise<void> => {
    try {
      await apiRequest<void>('/auth/login', { method: 'POST', body: { email, password, remember } });
    } catch (error) {
      throw new SignInError(asApiError(error).status === 401
        ? 'Email or password is incorrect.' : 'Sign-in is unavailable right now. Please try again.');
    }
    generation.current += 1;
    setSignOutError(false);
    await loadIdentity();
    channel.current?.postMessage('changed');
  }, [loadIdentity]);

  const signOut = useCallback(async (): Promise<void> => {
    setSignOutError(false);
    try {
      await apiRequest<void>('/auth/logout', { method: 'POST' });
    } catch {
      // Do not claim success while a server session may still be usable.
      setSignOutError(true);
      return;
    }
    resetLocalState();
    setPhase('signed-out');
    channel.current?.postMessage('changed');
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

  return <AuthContext.Provider value={value}>
    {signOutError ? <div role="alert">Sign-out could not be completed. Please try again.</div> : null}
    {children}
  </AuthContext.Provider>;
}
