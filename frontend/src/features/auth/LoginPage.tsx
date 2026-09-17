import { useState, type FormEvent } from 'react';
import { SignInError } from '../../auth/AuthProvider';
import { isSupabaseConfigured } from '../../auth/supabaseClient';
import { useAuth } from '../../auth/useAuth';
import { Button } from '../../ui/Button';
import { Checkbox, FormError, Input, PasswordInput } from '../../ui/Field';
import { Alert } from '../../ui/Feedback';

/**
 * Sign-in.
 *
 * What this screen deliberately does NOT have:
 *   - a role selector
 *   - a Company, Team, or Position selector
 *   - pre-filled demo credentials
 *   - a "forgot password" flow (there is no public self-service reset;
 *     a manager issues a temporary password instead)
 *
 * Identity is never chosen. The person proves who they are with an email
 * and a password, and the backend then TELLS the application who they
 * are and what they may do (`GET /auth/me`, driven by the auth
 * provider). Nothing on this page influences that answer.
 *
 * REMEMBER ME DEFAULTS TO UNCHECKED - the safer choice on a shared plant
 * workstation. Checked persists the session across browser restarts;
 * unchecked keeps it to this tab. The password itself is never stored in
 * either case.
 */
export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password, remember);
      // The password is dropped from component state the moment it is no
      // longer needed. It is never stored anywhere else.
      setPassword('');
    } catch (caught) {
      setPassword('');
      setError(
        caught instanceof SignInError ? caught.message : 'Sign-in is unavailable right now. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="centered-page">
      <div>
        <div className="centered-page__panel">
          <div className="centered-page__brand">
            {/*
              The official E-SET logo, in place of the simplified mark.
              Decorative: the name sits immediately beside it, so alt
              text here would announce the company twice.
            */}
            <img
              className="centered-page__brand-logo"
              src="/branding/eset-logo.png"
              alt=""
              width={224}
              height={256}
              data-testid="login-brand-logo"
            />
            <span>
              <span className="centered-page__brand-name">E-SET Digital Permit System</span>
              <span className="centered-page__brand-tag">Permit to Work</span>
            </span>
          </div>

          <div className="centered-page__body">
            <h1 style={{ marginBottom: 'var(--space-1)' }}>Sign in</h1>
            <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>
              Use the work account issued to you.
            </p>

            {!isSupabaseConfigured ? (
              <div style={{ marginBottom: 'var(--space-4)' }}>
                <Alert tone="warning" title="Sign-in is not configured">
                  This environment has not been given its public sign-in settings yet. Contact your operator.
                </Alert>
              </div>
            ) : null}

            <form onSubmit={handleSubmit} noValidate className="stack">
              {error ? <FormError message={error} /> : null}

              <Input
                label="Email"
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={submitting}
              />

              <PasswordInput
                label="Password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
              />

              <Checkbox
                name="remember"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
                disabled={submitting}
                label={
                  <>
                    Remember me on this device
                    <span className="field__hint" style={{ display: 'block' }}>
                      Leave unchecked on a shared computer. Your password is never stored.
                    </span>
                  </>
                }
              />

              <Button type="submit" variant="primary" block loading={submitting} disabled={!isSupabaseConfigured}>
                {submitting ? 'Signing in' : 'Sign in'}
              </Button>
            </form>
          </div>

          <div className="centered-page__footer">
            Contact your E-SET Site Manager if you cannot access your account.
          </div>
        </div>

        <p className="centered-page__note">Authorized use only. All permit activity is recorded.</p>
      </div>
    </div>
  );
}
