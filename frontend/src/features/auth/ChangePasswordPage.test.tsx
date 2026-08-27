import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { normalEmployee } from '../../test/factories';
import { authStateFor, renderWithAuthState, stubFetch } from '../../test/harness';
import { ChangePasswordPage } from './ChangePasswordPage';

/**
 * The forced first-login password change.
 *
 * This is the ONLY password-change screen in the system. What matters
 * here: it actually calls the one endpoint that exists, it re-asks
 * `/auth/me` rather than assuming success, and the new password never
 * survives the attempt in either direction.
 */

const STRONG_PASSWORD = 'a-strong-enough-password';

function renderPage(auth = authStateFor(normalEmployee({ mustChangePassword: true }))) {
  renderWithAuthState(<ChangePasswordPage />, auth);
  return auth;
}

describe('the change-password form', () => {
  it('asks for the new password twice and nothing else', () => {
    stubFetch({});
    renderPage();
    expect(screen.getByLabelText(/^new password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm new password/i)).toBeInTheDocument();
    // Never the current password - the account is holding a temporary
    // one it may not even remember typing.
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  });

  it('states that the rest of the application is unreachable until this is done', () => {
    stubFetch({});
    renderPage();
    expect(screen.getByText(/cannot open permits, records, or administration/i)).toBeInTheDocument();
  });

  it('shows the backend’s own minimum length', () => {
    stubFetch({});
    renderPage();
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
  });
});

describe('local checks before anything is sent', () => {
  it('refuses a password shorter than the backend minimum', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({});
    renderPage();

    await user.type(screen.getByLabelText(/^new password/i), 'short');
    await user.type(screen.getByLabelText(/confirm new password/i), 'short');
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    expect(await screen.findByText(/use at least 12 characters/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('refuses a mismatched confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({});
    renderPage();

    await user.type(screen.getByLabelText(/^new password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm new password/i), `${STRONG_PASSWORD}-different`);
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    expect(await screen.findByText(/do not match/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe('a successful change', () => {
  it('posts to the one change-password endpoint and re-asks /auth/me', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'POST /api/v1/auth/change-password': { body: { status: 'ok', mustChangePassword: false } },
    });
    const auth = renderPage();

    await user.type(screen.getByLabelText(/^new password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm new password/i), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    await waitFor(() => expect(auth.refreshIdentity).toHaveBeenCalled());
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      // Exactly one field: no user id, no email, no role, no state.
      body: { newPassword: STRONG_PASSWORD },
    });
    expect(Object.keys(calls[0]?.body as object)).toEqual(['newPassword']);
  });

  it('clears both password fields once the request completes', async () => {
    const user = userEvent.setup();
    stubFetch({ 'POST /api/v1/auth/change-password': { body: { status: 'ok', mustChangePassword: false } } });
    renderPage();

    await user.type(screen.getByLabelText(/^new password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm new password/i), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    await waitFor(() => expect(screen.getByLabelText(/^new password/i)).toHaveValue(''));
    expect(screen.getByLabelText(/confirm new password/i)).toHaveValue('');
  });
});

describe('a rejected change', () => {
  it('shows the failure and clears the password rather than leaving it on screen', async () => {
    const user = userEvent.setup();
    stubFetch({
      'POST /api/v1/auth/change-password': {
        status: 503,
        body: { error: 'password_change_failed', reason: 'auth_update_failed' },
      },
    });
    renderPage();

    await user.type(screen.getByLabelText(/^new password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm new password/i), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/^new password/i)).toHaveValue(''));
  });

  it('reports a 409 (no change is actually outstanding) without technical detail', async () => {
    const user = userEvent.setup();
    stubFetch({
      'POST /api/v1/auth/change-password': {
        status: 409,
        body: {
          error: 'conflict',
          reason: 'no_password_change_required',
          message: 'No password change is currently required for this account',
        },
      },
    });
    renderPage();

    await user.type(screen.getByLabelText(/^new password/i), STRONG_PASSWORD);
    await user.type(screen.getByLabelText(/confirm new password/i), STRONG_PASSWORD);
    await user.click(screen.getByRole('button', { name: /set password and continue/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no password change is currently required/i);
  });
});
