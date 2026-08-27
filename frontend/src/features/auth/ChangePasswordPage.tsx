import { useState, type FormEvent } from 'react';
import { changeOwnPassword } from '../../api/endpoints';
import { asApiError } from '../../api/errors';
import { useAuth } from '../../auth/useAuth';
import { BrandMark } from '../../layout/Icons';
import { Button } from '../../ui/Button';
import { FormError, PasswordInput } from '../../ui/Field';
import { Alert } from '../../ui/Feedback';

/**
 * The forced first-login password change.
 *
 * This is the ONLY password-change screen in the system, and it is
 * reachable only while `mustChangePassword` is true. There is no
 * "change my password" setting anywhere else, by business rule: the
 * backend's own endpoint refuses (409) when no change is outstanding,
 * so the rule is enforced server-side and merely reflected here.
 *
 * The router keeps a person on this page until the change succeeds -
 * every other application route is unreachable, and the backend
 * independently refuses them all with `password_change_required`.
 *
 * THE MINIMUM LENGTH SHOWN IS THE BACKEND'S OWN (12 characters, from
 * `passwordSchema`). No extra composition policy is invented here:
 * Supabase Auth holds the project's configured policy and remains the
 * authority, and a rejection from it is reported as the backend words it.
 */

/** From backend `domain/accounts/validation.ts::passwordSchema`. */
const MIN_PASSWORD_LENGTH = 12;

export function ChangePasswordPage() {
  const { refreshIdentity, signOut, user } = useAuth();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [confirmError, setConfirmError] = useState<string | undefined>(undefined);
  const [lengthError, setLengthError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    setFormError(null);
    setConfirmError(undefined);
    setLengthError(undefined);

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setLengthError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setConfirmError('The two passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      await changeOwnPassword(newPassword);
      // Cleared immediately - the value exists only for the duration of
      // the request, and is never stored or logged.
      setNewPassword('');
      setConfirmPassword('');
      // The authoritative answer to "is a change still outstanding" comes
      // from /auth/me, never from this component's own assumption.
      await refreshIdentity();
    } catch (caught) {
      const error = asApiError(caught);
      setNewPassword('');
      setConfirmPassword('');
      setFormError({ message: error.message, requestId: error.requestId });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="centered-page">
      <div>
        <div className="centered-page__panel centered-page__panel--wide">
          <div className="centered-page__brand">
            <BrandMark size={30} />
            <span>
              <span className="centered-page__brand-name">E-SET Digital Permit System</span>
              <span className="centered-page__brand-tag">Permit to Work</span>
            </span>
          </div>

          <div className="centered-page__body">
            <h1 style={{ marginBottom: 'var(--space-1)' }}>Set a new password</h1>
            <p className="muted" style={{ marginBottom: 'var(--space-5)' }}>
              Your account is using a temporary password. Choose a new one to continue.
            </p>

            <div style={{ marginBottom: 'var(--space-4)' }}>
              <Alert tone="info">
                You cannot open permits, records, or administration until this is done.
              </Alert>
            </div>

            <form onSubmit={handleSubmit} noValidate className="stack">
              {formError ? <FormError message={formError.message} requestId={formError.requestId} /> : null}

              <PasswordInput
                label="New password"
                name="new-password"
                autoComplete="new-password"
                required
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={submitting}
                hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                error={lengthError}
              />

              <PasswordInput
                label="Confirm new password"
                name="confirm-password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={submitting}
                error={confirmError}
              />

              <Button type="submit" variant="primary" block loading={submitting}>
                {submitting ? 'Saving' : 'Set password and continue'}
              </Button>
            </form>
          </div>

          <div className="centered-page__footer">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span>Signed in as {user?.auth.email ?? 'your account'}</span>
              <Button size="sm" variant="ghost" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
