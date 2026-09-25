import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setSessionEndedHandler } from '../api/client';
import * as cache from '../lib/cache';
import { ceo, normalEmployee } from '../test/factories';
import { AuthProvider } from './AuthProvider';
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
  const { phase, user, capabilities, signOut, signIn } = useAuth();
  return (
    <div>
      <p data-testid="phase">{phase}</p>
      <p data-testid="name">{capabilities?.displayName ?? 'none'}</p>
      <p data-testid="privileged">{user ? String(user.privilegedRoles.join(',') || 'none') : 'none'}</p>
      <p data-testid="must-change">{user ? String(user.mustChangePassword) : 'none'}</p>
      <button type="button" onClick={() => void signIn('synthetic@example.invalid', 'FAKE-login-password', true)}>
        Sign in
      </button>
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

beforeEach(() => {
  setSessionEndedHandler(() => {});
});

describe('bootstrap', () => {
  it('reaches "ready" only after /auth/me answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, normalEmployee())));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
    expect(screen.getByTestId('name')).toHaveTextContent('Ali Khan');
  });

  it('restores the backend session through GET /auth/me', async () => {
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

  it('takes ordinary identity only from the backend', async () => {
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
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, normalEmployee({ mustChangePassword: true }))));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('must-change')).toHaveTextContent('true'));
  });

  it('goes straight to signed-out when there is no session', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, {error:'unauthorized'})));

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
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized' })));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signed-out'));
    expect(screen.getByTestId('name')).toHaveTextContent('none');
  });

  it('does NOT sign the person out merely because the service is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('identity-unavailable'));
  });
});

describe('sign-out', () => {
  it('revokes through the backend before clearing identity and caches', async () => {
    const user = userEvent.setup();
    const clearCaches = vi.spyOn(cache, 'clearCaches');
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
    expect(clearCaches).toHaveBeenCalled();
    // No cross-account leakage: the persisted session is gone from the device.
    expect(window.localStorage.getItem('sb-project-auth-token')).toBeNull();
  });

  it('resets the Remember Me preference, so the next sign-in starts from the safe default', async () => {
    const user = userEvent.setup();
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

it('sign-in uses the backend and sends Remember Me without persisting credentials', async () => {
  let signedIn=false;
  const fetchMock=vi.fn(async (url:string, init:RequestInit)=>{
    if(url.endsWith('/auth/login')) { signedIn=true; return jsonResponse(204,null); }
    expect(init.credentials).toBe('include');
    return signedIn ? jsonResponse(200,normalEmployee()) : jsonResponse(401,{error:'unauthorized'});
  });
  vi.stubGlobal('fetch',fetchMock);
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(()=>expect(screen.getByTestId('phase')).toHaveTextContent('signed-out'));
  await userEvent.click(screen.getByRole('button',{name:'Sign in'}));
  await waitFor(()=>expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
  const login=fetchMock.mock.calls.find(([url])=>url.endsWith('/auth/login'))!;
  expect(JSON.parse(String(login[1].body))).toEqual({email:'synthetic@example.invalid',password:'FAKE-login-password',remember:true});
  expect(window.localStorage.length).toBe(0);expect(window.sessionStorage.length).toBe(0);
});
it('failed server logout remains visibly uncompleted and can be retried', async () => {
  let fail=true;
  const fetchMock=vi.fn(async (url:string)=>url.endsWith('/auth/logout')
    ? jsonResponse(fail?503:204,{error:'sign_out_unavailable'}) : jsonResponse(200,normalEmployee()));
  vi.stubGlobal('fetch',fetchMock);
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(()=>expect(screen.getByTestId('phase')).toHaveTextContent('ready'));
  await userEvent.click(screen.getByRole('button',{name:'Sign out'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Sign-out could not be completed');
  expect(screen.getByTestId('phase')).toHaveTextContent('ready');
  fail=false;
  await userEvent.click(screen.getByRole('button',{name:'Sign out'}));
  await waitFor(()=>expect(screen.getByTestId('phase')).toHaveTextContent('signed-out'));
});
