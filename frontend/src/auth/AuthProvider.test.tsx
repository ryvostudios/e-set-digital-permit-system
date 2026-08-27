import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionEndedHandler } from '../api/client';
import * as cache from '../lib/cache';
import { ceo, normalEmployee } from '../test/factories';
import { AuthProvider } from './AuthProvider';
import { supabase } from './supabaseClient';
import { useAuth } from './useAuth';

/**
 * The authoritative current-user bootstrap.
 *
 * The one rule under test: SUPABASE PROVES CREDENTIALS, `/auth/me`
 * DECIDES IDENTITY. Nothing is ever read from the JWT payload, from
 * `user_metadata`, or from the email address - and when the backend
 * stops accepting a session, the frontend tears its own state down
 * rather than continuing to render a shell.
 */

function Probe() {
  const { phase, user, capabilities, signOut } = useAuth();
  return (
    <div>
      <p data-testid="phase">{phase}</p>
      <p data-testid="name">{capabilities?.displayName ?? 'none'}</p>
      <p data-testid="privileged">{user ? String(user.privilegedRoles.join(',') || 'none') : 'none'}</p>
      <p data-testid="must-change">{user ? String(user.mustChangePassword) : 'none'}</p>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

/** A Supabase client that reports a live session without any network. */
function stubSupabaseSession(session: unknown) {
  vi.spyOn(supabase.auth, 'getSession').mockResolvedValue({ data: { session }, error: null } as never);
  vi.spyOn(supabase.auth, 'onAuthStateChange').mockReturnValue({
    data: { subscription: { id: 'test', callback: () => {}, unsubscribe: () => {} } },
  } as never);
  vi.spyOn(supabase.auth, 'signOut').mockResolvedValue({ error: null } as never);
}

const FAKE_SESSION = {
  access_token: 'jwt-token',
  // Deliberately hostile: metadata claiming a privileged role, which
  // must have no effect whatsoever on what the application believes.
  user: {
    id: 'user-normal',
    email: 'ceo@eset.example.com',
    user_metadata: { role: 'CEO', privilegedRoles: ['CEO'], company: 'E-SET' },
    app_metadata: { role: 'CEO' },
  },
};

beforeEach(() => {
  setSessionEndedHandler(() => {});
});

describe('bootstrap', () => {
  it('reaches "ready" only after /auth/me answers', async () => {
    stubSupabaseSession(FAKE_SESSION);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, normalEmployee())));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
    expect(screen.getByTestId('name')).toHaveTextContent('Ali Khan');
  });

  it('calls GET /auth/me with the session token', async () => {
    stubSupabaseSession(FAKE_SESSION);
    const fetchMock = vi.fn(async () => jsonResponse(200, normalEmployee()));
    vi.stubGlobal('fetch', fetchMock);

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/api/v1/auth/me');
  });

  it('IGNORES Supabase user_metadata claiming a privileged role', async () => {
    stubSupabaseSession(FAKE_SESSION);
    // The backend says: ordinary employee, no privileged roles.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, normalEmployee())));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
    expect(screen.getByTestId('privileged')).toHaveTextContent('none');
    // And the name comes from the profile, never from the email address.
    expect(screen.getByTestId('name')).toHaveTextContent('Ali Khan');
  });

  it('takes privileged roles ONLY from /auth/me', async () => {
    stubSupabaseSession({ ...FAKE_SESSION, user: { ...FAKE_SESSION.user, user_metadata: {} } });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, ceo())));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('privileged')).toHaveTextContent('CEO'));
    expect(screen.getByTestId('name')).toHaveTextContent('Farhan Aziz');
  });

  it('surfaces mustChangePassword from /auth/me', async () => {
    stubSupabaseSession(FAKE_SESSION);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, normalEmployee({ mustChangePassword: true }))));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('must-change')).toHaveTextContent('true'));
  });

  it('goes straight to signed-out when there is no session', async () => {
    stubSupabaseSession(null);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {})));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signed-out'));
  });
});

describe('a rejected session', () => {
  it('ends the session locally when the backend answers 401 (disabled or deleted account)', async () => {
    stubSupabaseSession(FAKE_SESSION);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized' })));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signed-out'));
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(screen.getByTestId('name')).toHaveTextContent('none');
  });

  it('does NOT sign the person out merely because the service is unreachable', async () => {
    stubSupabaseSession(FAKE_SESSION);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('identity-unavailable'));
    expect(supabase.auth.signOut).not.toHaveBeenCalled();
  });
});

describe('sign-out', () => {
  it('clears the identity, the caches, and the persisted session', async () => {
    const user = userEvent.setup();
    const clearCaches = vi.spyOn(cache, 'clearCaches');
    stubSupabaseSession(FAKE_SESSION);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, normalEmployee())));
    window.localStorage.setItem('sb-project-auth-token', 'persisted');

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('name')).toHaveTextContent('none');
    expect(supabase.auth.signOut).toHaveBeenCalled();
    expect(clearCaches).toHaveBeenCalled();
    // No cross-account leakage: the persisted session is gone from the device.
    expect(window.localStorage.getItem('sb-project-auth-token')).toBeNull();
  });

  it('resets the Remember Me preference, so the next sign-in starts from the safe default', async () => {
    const user = userEvent.setup();
    stubSupabaseSession(FAKE_SESSION);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, normalEmployee())));
    window.localStorage.setItem('eset.auth.remember', '1');

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));

    await user.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(window.localStorage.getItem('eset.auth.remember')).toBeNull());
  });
});
