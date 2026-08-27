import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { createEmployee } from '../../api/endpoints';
import { asApiError, fieldErrors } from '../../api/errors';
import { ROUTES } from '../../app/routes';
import { useCurrentUser } from '../../auth/useAuth';
import { Button } from '../../ui/Button';
import { FormError, Input, PasswordInput } from '../../ui/Field';
import { Alert, ErrorState, LoadingState } from '../../ui/Feedback';
import { Card, PageHeader } from '../../ui/Layout';
import { useToast } from '../../ui/Toast';
import { OrganizationAssignmentFields } from './OrganizationAssignmentFields';
import { useOrganization } from './useOrganization';

/**
 * Provisioning a NORMAL employee account.
 *
 * WHAT THIS CAN AND CANNOT CREATE. This endpoint writes an employee's
 * account, company membership, and Team + Position assignment - and
 * nothing else. It cannot mint a CEO or a Site Manager, cannot grant a
 * capability, and cannot choose an account state: the backend's schema
 * is `.strict()` and simply refuses any such field, so those are not
 * merely absent from this form but impossible to send.
 *
 * THE COMPANY / TEAM / POSITION CHOICES ARE THE SERVER'S. They come from
 * `GET /admin/organization` - only combinations the organization has
 * already approved for provisioning - so a manager cannot type an
 * arbitrary assignment, and this file holds no organization map of its
 * own.
 *
 * THE TEMPORARY PASSWORD IS NEVER STORED, LOGGED, OR ECHOED. It exists
 * in this component's state only until the request completes, and is
 * cleared immediately afterwards. The backend never returns it.
 */

const COMPANIES = [
  { code: 'E_SET', name: 'E-SET' },
  { code: 'ZPL', name: 'ZPL' },
  { code: 'SGRE', name: 'SGRE' },
] as const;

const MIN_PASSWORD_LENGTH = 12;

export function CreateEmployeePage() {
  const { capabilities } = useCurrentUser();
  const navigate = useNavigate();
  const toast = useToast();
  const organization = useOrganization();

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [companyCode, setCompanyCode] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamPositionId, setTeamPositionId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ name: string; userId: string } | null>(null);


  if (!capabilities.canManageEmployees) {
    return (
      <>
        <PageHeader eyebrow="Administration" title="Add employee" />
        <Alert tone="warning" title="Not available to you">
          Creating employee accounts is reserved to the CEO and System Site Managers.
        </Alert>
      </>
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setIssues({});

    if (temporaryPassword.length < MIN_PASSWORD_LENGTH) {
      setIssues({ temporaryPassword: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }

    setSubmitting(true);
    try {
      const result = await createEmployee({
        displayName: displayName.trim(),
        email: email.trim(),
        temporaryPassword,
        companyCode,
        teamPositionId,
      });
      // Cleared the instant it is no longer needed. It is never written
      // to storage and never appears in a log or a response.
      setTemporaryPassword('');
      setCreated({ name: displayName.trim(), userId: result.employee.userId });
      setDisplayName('');
      setEmail('');
      setCompanyCode('');
      setTeamPositionId('');
      toast.show('Employee account created.');
    } catch (caught) {
      const apiError = asApiError(caught);
      setTemporaryPassword('');
      setError({ message: apiError.message, requestId: apiError.requestId });
      setIssues(fieldErrors(apiError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Add employee"
        description="Creates a normal employee account with one Company, one Team, and one Position."
      />

      <div className="stack">
        {created ? (
          <Alert tone="success" title={`${created.name} has been added`}>
            <p>They must change the temporary password the first time they sign in.</p>
            <div className="row" style={{ marginTop: 'var(--space-3)' }}>
              <Button size="sm" variant="secondary" onClick={() => navigate(ROUTES.employee(created.userId))}>
                Open their record
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                Add another
              </Button>
            </div>
          </Alert>
        ) : null}

        {organization.initialLoading ? (
          <LoadingState label="Loading organization" />
        ) : organization.error ? (
          <ErrorState error={organization.error} onRetry={organization.reload} />
        ) : (
          <Card title="Employee details">
            <form onSubmit={handleSubmit} noValidate className="stack">
              {error ? <FormError message={error.message} requestId={error.requestId} /> : null}

              <div className="grid-2">
                <Input
                  label="Display name"
                  required
                  maxLength={120}
                  value={displayName}
                  error={issues.displayName}
                  disabled={submitting}
                  hint="This is the name that appears on permits they sign."
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <Input
                  label="Email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  error={issues.email}
                  disabled={submitting}
                  hint="This becomes their sign-in address."
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>

              <PasswordInput
                label="Temporary password"
                required
                autoComplete="new-password"
                value={temporaryPassword}
                error={issues.temporaryPassword}
                disabled={submitting}
                hint={`At least ${MIN_PASSWORD_LENGTH} characters. Give it to them directly — it is never shown again.`}
                onChange={(event) => setTemporaryPassword(event.target.value)}
              />

              <div className="grid-2">
                <OrganizationAssignmentFields
                  organization={organization}
                  companies={COMPANIES}
                  disabled={submitting}
                  issues={issues}
                  value={{ companyCode, teamName, teamPositionId }}
                  onChange={(next) => {
                    setCompanyCode(next.companyCode);
                    setTeamName(next.teamName);
                    setTeamPositionId(next.teamPositionId);
                  }}
                />
              </div>

              <Alert tone="info">
                The account is created as a normal employee. Permit authority comes from the Team and Position above —
                it is never granted here.
              </Alert>

              <div className="row">
                <Button
                  type="submit"
                  variant="primary"
                  loading={submitting}
                  disabled={!companyCode || !teamPositionId}
                >
                  {submitting ? 'Creating account' : 'Create employee account'}
                </Button>
                <Button type="button" variant="ghost" disabled={submitting} onClick={() => navigate(ROUTES.employees)}>
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        )}
      </div>
    </>
  );
}
