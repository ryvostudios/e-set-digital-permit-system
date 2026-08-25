import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

interface MeResult {
  status: number;
  body: unknown;
}

/**
 * Minimal auth verification UI for Section 5: email/password sign-in,
 * sign-out, session state, and a call to the backend's authenticated
 * `/api/v1/auth/me` endpoint to prove the token round-trip works.
 */
export function AuthPanel() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInLoading, setSignInLoading] = useState(false);
  const [meResult, setMeResult] = useState<MeResult | null>(null);
  const [meLoading, setMeLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setMeResult(null);
    });

    return () => subscription.subscription.unsubscribe();
  }, []);

  async function handleSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSignInError(null);
    setSignInLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setSignInLoading(false);
    if (error) {
      setSignInError(error.message);
    } else {
      setPassword('');
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  async function handleVerifyWithBackend() {
    if (!session) return;
    setMeLoading(true);
    setMeResult(null);
    try {
      const response = await fetch(`${API_BASE_URL}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const body: unknown = await response.json();
      setMeResult({ status: response.status, body });
    } catch {
      setMeResult({ status: 0, body: { error: 'network_error' } });
    } finally {
      setMeLoading(false);
    }
  }

  if (sessionLoading) {
    return <p>Loading session...</p>;
  }

  if (!session) {
    return (
      <form onSubmit={handleSignIn}>
        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button type="submit" disabled={signInLoading}>
          {signInLoading ? 'Signing in...' : 'Sign in'}
        </button>
        {signInError && <p role="alert">{signInError}</p>}
      </form>
    );
  }

  return (
    <div>
      <p>Signed in as {session.user.email}</p>
      <button type="button" onClick={handleSignOut}>
        Sign out
      </button>
      <button type="button" onClick={handleVerifyWithBackend} disabled={meLoading}>
        {meLoading ? 'Verifying...' : 'Verify with backend (/api/v1/auth/me)'}
      </button>
      {meResult && (
        <pre>
          {meResult.status}: {JSON.stringify(meResult.body, null, 2)}
        </pre>
      )}
    </div>
  );
}
