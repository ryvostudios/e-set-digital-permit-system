import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthState } from '../auth/AuthProvider';
import { deriveCapabilities } from '../auth/capabilities';
import { ceo, normalEmployee } from '../test/factories';
import { AppRouter } from './AppRouter';

/**
 * The authentication gate.
 *
 * ROUTING IS NOT AUTHORIZATION. What these tests pin is the ORDER of the
 * gate - no session goes to login, an outstanding password change goes
 * to the change-password screen and nowhere else - and that reaching an
 * administration URL directly does not by itself unlock anything.
 */

function stateFor(overrides: Partial<AuthState>): AuthState {
  const user = overrides.user ?? null;
  return {
    phase: 'ready',
    user,
    capabilities: user ? deriveCapabilities(user) : null,
    identityError: null,
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    refreshIdentity: vi.fn(async () => {}),
    ...overrides,
  };
}

function renderRouter(auth: AuthState, path: string) {
  window.history.pushState({}, '', path);
  return render(
    <AuthContext.Provider value={auth}>
      <AppRouter />
    </AuthContext.Provider>,
  );
}

function stubQuietFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => ({ notifications: [], permits: [], employees: [], pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false } }),
        }) as unknown as Response,
    ),
  );
}

describe('with no session', () => {
  it('shows the login screen for the application root', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ phase: 'signed-out', user: null }), '/');
    expect(await screen.findByRole('heading', { level: 1, name: /sign in/i })).toBeInTheDocument();
  });

  it('sends an administration URL to login, not to the screen', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ phase: 'signed-out', user: null }), '/admin/employees');
    expect(await screen.findByRole('heading', { level: 1, name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^employees$/i })).not.toBeInTheDocument();
  });
});

describe('with an outstanding password change', () => {
  const auth = stateFor({ user: normalEmployee({ mustChangePassword: true }) });

  it('forces the change-password screen from the application root', async () => {
    stubQuietFetch();
    renderRouter(auth, '/');
    expect(await screen.findByRole('heading', { level: 1, name: /set a new password/i })).toBeInTheDocument();
  });

  it('forces it from a permit URL too - no application route is reachable', async () => {
    stubQuietFetch();
    renderRouter(auth, '/records');
    expect(await screen.findByRole('heading', { level: 1, name: /set a new password/i })).toBeInTheDocument();
  });

  it('forces it from an administration URL', async () => {
    stubQuietFetch();
    renderRouter(auth, '/admin/employees');
    expect(await screen.findByRole('heading', { level: 1, name: /set a new password/i })).toBeInTheDocument();
  });
});

describe('with no outstanding change', () => {
  it('redirects away from the change-password screen rather than showing an inapplicable page', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ user: normalEmployee() }), '/change-password');
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /set a new password/i })).not.toBeInTheDocument(),
    );
  });

  it('renders the application shell', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ user: normalEmployee() }), '/');
    expect(await screen.findByRole('navigation', { name: /main navigation/i })).toBeInTheDocument();
  });
});

describe('reaching a privileged screen directly', () => {
  it('does not unlock it for an ordinary employee - the screen refuses', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ user: normalEmployee() }), '/admin/site-managers');
    expect(await screen.findByText(/reserved to the ceo/i)).toBeInTheDocument();
  });

  it('does not unlock employee administration for an ordinary employee either', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ user: normalEmployee() }), '/admin/employees');
    expect(await screen.findByText(/reserved to the ceo and e-set site managers/i)).toBeInTheDocument();
  });

  it('allows it for the CEO', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ user: ceo() }), '/admin/site-managers');
    expect(await screen.findByRole('heading', { level: 1, name: /site managers/i })).toBeInTheDocument();
    expect(screen.queryByText(/reserved to the ceo/i)).not.toBeInTheDocument();
  });
});

describe('when the identity service is unreachable', () => {
  it('explains the situation and offers to retry, rather than rendering an empty shell', async () => {
    stubQuietFetch();
    renderRouter(
      stateFor({
        phase: 'identity-unavailable',
        user: null,
        identityError: null,
      }),
      '/',
    );
    expect(await screen.findByRole('heading', { name: /cannot load your account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('an unknown address', () => {
  it('is a plain not-found page inside the shell', async () => {
    stubQuietFetch();
    renderRouter(stateFor({ user: normalEmployee() }), '/no-such-page');
    expect(await screen.findByRole('heading', { name: /page not found/i })).toBeInTheDocument();
  });
});
