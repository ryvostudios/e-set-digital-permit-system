import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SignInError } from '../../auth/AuthProvider';
import { normalEmployee } from '../../test/factories';
import { authStateFor, renderWithAuthState } from '../../test/harness';
import { LoginPage } from './LoginPage';

/**
 * Sign-in.
 *
 * The behaviours pinned here are the ones with real consequences:
 * Remember Me defaults to UNCHECKED, no role/company selector exists, a
 * failed sign-in reveals nothing about whether the address is real, and
 * the password never survives the attempt.
 */

function renderLogin(overrides: Parameters<typeof authStateFor>[1] = {}) {
  const auth = authStateFor(normalEmployee(), { phase: 'signed-out', user: null, capabilities: null, ...overrides });
  renderWithAuthState(<LoginPage />, auth);
  return auth;
}

describe('the sign-in form', () => {
  it('asks for an email and a password, and nothing else', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password/i)).toBeInTheDocument();

    // Identity is never chosen at sign-in.
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/company/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/team/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/position/i)).not.toBeInTheDocument();
  });

  it('prefills no credentials', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toHaveValue('');
    expect(screen.getByLabelText(/^password/i)).toHaveValue('');
  });

  it('offers no public password reset, and points people at their Site Manager instead', () => {
    renderLogin();
    expect(screen.queryByText(/forgot password/i)).not.toBeInTheDocument();
    expect(screen.getByText(/contact your e-set site manager/i)).toBeInTheDocument();
  });
});

describe('Remember me', () => {
  it('defaults to UNCHECKED', () => {
    renderLogin();
    expect(screen.getByRole('checkbox', { name: /remember me/i })).not.toBeChecked();
  });

  it('passes the unchecked choice through to sign-in', async () => {
    const user = userEvent.setup();
    const auth = renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'ali@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith('ali@example.com', 'correct-horse-battery', false));
  });

  it('passes the checked choice through to sign-in', async () => {
    const user = userEvent.setup();
    const auth = renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'ali@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.click(screen.getByRole('checkbox', { name: /remember me/i }));
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(auth.signIn).toHaveBeenCalledWith('ali@example.com', 'correct-horse-battery', true));
  });

  it('says plainly that the password is never stored', () => {
    renderLogin();
    expect(screen.getByText(/your password is never stored/i)).toBeInTheDocument();
  });
});

describe('the password field', () => {
  it('is masked, and can be revealed deliberately', async () => {
    const user = userEvent.setup();
    renderLogin();
    const field = screen.getByLabelText(/^password/i);
    expect(field).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: /show password/i }));
    expect(field).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: /hide password/i }));
    expect(field).toHaveAttribute('type', 'password');
  });
});

describe('failure', () => {
  it('shows one message for a bad credential, revealing nothing about the address', async () => {
    const user = userEvent.setup();
    renderLogin({ signIn: vi.fn(async () => { throw new SignInError('Email or password is incorrect.'); }) });

    await user.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email or password is incorrect.');
    // Never "no such user" / "unknown email" / "wrong password for ...".
    expect(alert.textContent).not.toMatch(/no such|unknown|not found|does not exist/i);
  });

  it('clears the password from the form after a failed attempt', async () => {
    const user = userEvent.setup();
    renderLogin({ signIn: vi.fn(async () => { throw new SignInError('Email or password is incorrect.'); }) });

    await user.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'wrong-password-here');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getByLabelText(/^password/i)).toHaveValue(''));
    // The email is kept so the person does not retype it.
    expect(screen.getByLabelText(/email/i)).toHaveValue('nobody@example.com');
  });

  it('reports an unavailable backend without technical detail', async () => {
    const user = userEvent.setup();
    renderLogin({ signIn: vi.fn(async () => { throw new Error('ECONNREFUSED 127.0.0.1:3001'); }) });

    await user.type(screen.getByLabelText(/email/i), 'ali@example.com');
    await user.type(screen.getByLabelText(/^password/i), 'correct-horse-battery');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/unavailable right now/i);
    expect(alert.textContent).not.toContain('ECONNREFUSED');
    expect(alert.textContent).not.toContain('127.0.0.1');
  });
});

describe('accessibility', () => {
  it('gives every control a real label and a submit button', () => {
    renderLogin();
    expect(screen.getByRole('heading', { level: 1, name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sign in$/i })).toHaveAttribute('type', 'submit');
    expect(screen.getByLabelText(/email/i)).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText(/^password/i)).toHaveAttribute('autocomplete', 'current-password');
  });
});
