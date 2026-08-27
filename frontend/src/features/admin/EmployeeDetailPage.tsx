import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  changeEmployeeEmail,
  deleteEmployee,
  disableEmployee,
  enableEmployee,
  getEmployee,
  getEmployeeHistory,
  resetEmployeePassword,
  setViewAllPermits,
  updateEmployee,
  VIEW_ALL_PERMITS_CAPABILITY,
} from '../../api/endpoints';
import { asApiError, fieldErrors } from '../../api/errors';
import type { EmployeeDetail, EmployeeHistoryResponse } from '../../api/types';
import { ROUTES } from '../../app/routes';
import { useCurrentUser } from '../../auth/useAuth';
import { invalidateAll } from '../../lib/cache';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Dialog';
import { FormError, Input, PasswordInput } from '../../ui/Field';
import { Alert, ErrorState, LoadingState, SkeletonRows } from '../../ui/Feedback';
import { Badge, Card, PageHeader } from '../../ui/Layout';
import { useToast } from '../../ui/Toast';
import { EmployeeHistory } from './EmployeeHistory';
import { OrganizationAssignmentFields } from './OrganizationAssignmentFields';
import { useOrganization } from './useOrganization';

/**
 * One employee's management record.
 *
 * EVERY SENSITIVE ACTION IS ITS OWN DELIBERATE STEP, behind its own
 * confirmation, with its own written explanation of the consequence -
 * because these are not form fields, they are decisions: an email change
 * moves the person's login, a reset invalidates their current password,
 * a disable cuts access on their very next request, and a deletion is
 * permanent.
 *
 * WHAT IS NEVER SHOWN: the account's internal user id, credential
 * version, reset-pending marker, raw capability list, timestamps of
 * credential changes, or privileged role information. The one
 * credential-adjacent value displayed is `mustChangePassword`, which the
 * API itself returns.
 *
 * WHAT CANNOT BE DONE HERE: granting workflow authority. The only
 * grantable permission is "View all permits", which the database itself
 * restricts to the single individually-grantable capability - a CRO,
 * HSE, or account-management grant is refused at the trigger level, not
 * merely omitted from this screen.
 */

const MIN_PASSWORD_LENGTH = 12;

const COMPANIES = [
  { code: 'E_SET', name: 'E-SET' },
  { code: 'ZPL', name: 'ZPL' },
  { code: 'SGRE', name: 'SGRE' },
] as const;

type DialogId = 'rename' | 'transfer' | 'email' | 'reset' | 'disable' | 'enable' | 'delete' | 'viewAll' | null;

/** One labelled administrative action: what it is, what it does, and the control that starts it. */
function ActionRow({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-4)' }}>
      <div style={{ minWidth: '14rem', flex: 1 }}>
        <p style={{ fontWeight: 600 }}>{title}</p>
        <p className="muted text-sm">{description}</p>
      </div>
      {action}
    </div>
  );
}

function StateBadge({ state }: { state: EmployeeDetail['state'] }) {
  if (state === 'ACTIVE') return <Badge tone="success">Active</Badge>;
  if (state === 'DISABLED') return <Badge tone="warning">Disabled</Badge>;
  return <Badge tone="danger">Deleted</Badge>;
}

export function EmployeeDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { capabilities } = useCurrentUser();
  // CEO-only. Gates BOTH the request and the section: a Site Manager must
  // not even ask for the administrative audit, so there is no 403 to
  // render and nothing on screen hinting a withheld panel exists.
  const canViewAudit = capabilities.canViewAdministrativeAudit;
  const navigate = useNavigate();
  const toast = useToast();
  const organization = useOrganization();

  const resource = useApiResource<{ employee: EmployeeDetail }>((signal) => getEmployee(id, signal), [id]);
  const history = useApiResource<EmployeeHistoryResponse>(
    async (signal) =>
      canViewAudit
        ? getEmployeeHistory(id, { pageSize: 25 }, signal)
        : { items: [], page: 1, pageSize: 0, totalCount: 0, totalPages: 0 },
    [id, canViewAudit],
  );

  const [dialog, setDialog] = useState<DialogId>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  // Per-dialog form state. Reset whenever a dialog opens, so nothing a
  // previous action typed can be carried into the next one.
  const [displayName, setDisplayName] = useState('');
  const [companyCode, setCompanyCode] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamPositionId, setTeamPositionId] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');

  const employee = resource.data?.employee;
  const viewAllGranted = employee?.individualPermissions.includes(VIEW_ALL_PERMITS_CAPABILITY) ?? false;

  function openDialog(next: Exclude<DialogId, null>): void {
    setError(null);
    setIssues({});
    setDisplayName(employee?.displayName ?? '');
    const currentCompany = employee?.company.code ?? '';
    const currentAssignment = employee?.teamPositionId ?? '';
    setCompanyCode(currentCompany);
    setTeamPositionId(currentAssignment);
    // The employee's team is not stored on the account - it is the team
    // that owns their assignment, so it is resolved from the
    // organization rather than reconstructed from a label.
    setTeamName(organization.teamOfAssignment(currentCompany, currentAssignment));
    setNewEmail('');
    setTemporaryPassword('');
    setDialog(next);
  }

  function closeDialog(): void {
    if (busy) return;
    setDialog(null);
    // Never leave a credential in component state once the dialog is gone.
    setTemporaryPassword('');
    setNewEmail('');
    setError(null);
    setIssues({});
  }

  async function run(action: () => Promise<unknown>, successMessage: string, afterDelete = false): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setIssues({});
    try {
      await action();
      toast.show(successMessage);
      setTemporaryPassword('');
      setNewEmail('');
      setDialog(null);
      if (afterDelete) {
        navigate(ROUTES.employees);
        return;
      }
      // The authoritative record is re-read rather than patched locally,
      // and every other screen is invalidated too: a permission change
      // must not leave a stale list rendered anywhere.
      resource.reload();
      history.reload();
      invalidateAll();
    } catch (caught) {
      const apiError = asApiError(caught);
      setError({ message: apiError.message, requestId: apiError.requestId });
      setIssues(fieldErrors(apiError));
      setTemporaryPassword('');
    } finally {
      setBusy(false);
    }
  }

  if (!capabilities.canManageEmployees) {
    return (
      <>
        <PageHeader eyebrow="Administration" title="Employee" />
        <Alert tone="warning" title="Not available to you">
          Employee administration is reserved to the CEO and System Site Managers.
        </Alert>
      </>
    );
  }

  if (resource.initialLoading) return <LoadingState label="Loading employee" />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (!employee) return <ErrorState error={{ code: 'not_found' }} />;

  const deleted = employee.state === 'DELETED';

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title={employee.displayName}
        description={
          <span className="row">
            <StateBadge state={employee.state} />
            <span>
              {employee.company.name} · {employee.teamName} · {employee.positionName}
            </span>
            {employee.mustChangePassword ? <Badge tone="warning">Must change password</Badge> : null}
          </span>
        }
        actions={
          <Button variant="ghost" onClick={() => navigate(ROUTES.employees)}>
            Back to employees
          </Button>
        }
      />

      <div className="stack">
        {deleted ? (
          <Alert tone="danger" title="This account has been permanently deleted">
            Its login can no longer be used and cannot be restored. Its permits, signatures, and history remain
            intact.
          </Alert>
        ) : null}

        <Card title="Profile">
          <div className="stack">
            <ActionRow
              title="Display name"
              description={`Currently “${employee.displayName}”. Renaming does not change any permit already signed under the old name.`}
              action={
                <Button variant="secondary" disabled={deleted} onClick={() => openDialog('rename')}>
                  Change name
                </Button>
              }
            />
            <ActionRow
              title="Company, Team and Position"
              description="Moving an employee changes what they may do from now on. Permits, signatures, and history already recorded are not rewritten."
              action={
                <Button variant="secondary" disabled={deleted} onClick={() => openDialog('transfer')}>
                  Transfer
                </Button>
              }
            />
          </div>
        </Card>

        <Card title="Permissions">
          <ActionRow
            title="View all permits"
            description={
              <>
                Allows this employee to view all permits. It does not grant approval authority.{' '}
                <strong>{viewAllGranted ? 'Currently granted.' : 'Not currently granted.'}</strong>
              </>
            }
            action={
              <Button variant="secondary" disabled={deleted} onClick={() => openDialog('viewAll')}>
                {viewAllGranted ? 'Revoke' : 'Grant'}
              </Button>
            }
          />
        </Card>

        <Card title="Sign-in and access">
          <div className="stack">
            <ActionRow
              title="Sign-in email"
              description="Moves this employee's login to a new address and issues a new temporary password."
              action={
                <Button variant="secondary" disabled={deleted} onClick={() => openDialog('email')}>
                  Change email
                </Button>
              }
            />
            <ActionRow
              title="Password"
              description="Issues a new temporary password. Their current password stops working immediately."
              action={
                <Button variant="secondary" disabled={deleted} onClick={() => openDialog('reset')}>
                  Reset password
                </Button>
              }
            />
            <ActionRow
              title="Account access"
              description={
                employee.state === 'ACTIVE'
                  ? 'Disabling ends access on their very next request. Their assignment, permissions, and history are preserved.'
                  : 'Re-enabling restores access with the same Company, Team, Position, and permissions.'
              }
              action={
                employee.state === 'ACTIVE' ? (
                  <Button variant="danger" onClick={() => openDialog('disable')}>
                    Disable account
                  </Button>
                ) : (
                  <Button variant="primary" disabled={deleted} onClick={() => openDialog('enable')}>
                    Re-enable account
                  </Button>
                )
              }
            />
          </div>
        </Card>

        {/*
          Permanent deletion is CEO-only. A Site Manager holds full
          authority over normal employees but not this - and the backend
          enforces it independently, so this is a UI reflection of that
          rule, not the rule itself.
        */}
        {capabilities.canDeleteEmployees && !deleted ? (
          <Card title="Permanent deletion">
            <ActionRow
              title="Delete this account permanently"
              description="Their login becomes permanently unusable. Permits, JSAs, signatures, and audit history remain. This cannot be undone."
              action={
                <Button variant="danger" onClick={() => openDialog('delete')}>
                  Delete permanently
                </Button>
              }
            />
          </Card>
        ) : null}

        {canViewAudit ? (
          <Card title="Administrative history" flush>
            {history.initialLoading ? (
              <SkeletonRows rows={4} />
            ) : history.error ? (
              <ErrorState error={history.error} onRetry={history.reload} />
            ) : (
              <EmployeeHistory entries={history.data?.items ?? []} />
            )}
          </Card>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- */}

      <Modal
        open={dialog === 'rename'}
        onClose={closeDialog}
        busy={busy}
        title="Change display name"
        description="This is the name that appears on permits they sign from now on. Permits already signed keep the name they carried at the time."
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => void run(() => updateEmployee(id, { displayName: displayName.trim() }), 'Name updated.')}
            >
              Save name
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        <Input
          label="Display name"
          required
          maxLength={120}
          value={displayName}
          error={issues.displayName}
          disabled={busy}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Modal>

      <Modal
        open={dialog === 'transfer'}
        onClose={closeDialog}
        busy={busy}
        title="Transfer employee"
        description="Company and Team + Position move together, because an assignment belongs to the company that owns its team."
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!companyCode || !teamPositionId}
              onClick={() =>
                void run(
                  () => updateEmployee(id, { transfer: { companyCode, teamPositionId } }),
                  'Employee transferred.',
                )
              }
            >
              Transfer
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        {organization.error ? <ErrorState error={organization.error} onRetry={organization.reload} /> : null}
        <OrganizationAssignmentFields
          organization={organization}
          companies={COMPANIES}
          disabled={busy}
          issues={issues}
          value={{ companyCode, teamName, teamPositionId }}
          onChange={(next) => {
            setCompanyCode(next.companyCode);
            setTeamName(next.teamName);
            setTeamPositionId(next.teamPositionId);
          }}
        />
        <Alert tone="info">
          Transferring changes what this employee may do from now on. It does not rewrite permits, signatures, or
          history already recorded under their previous assignment.
        </Alert>
      </Modal>

      <Modal
        open={dialog === 'email'}
        onClose={closeDialog}
        busy={busy}
        title="Change sign-in email"
        description="The new address becomes their login. The old one stops working as soon as this succeeds."
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!newEmail.trim() || temporaryPassword.length < MIN_PASSWORD_LENGTH}
              onClick={() =>
                void run(() => changeEmployeeEmail(id, newEmail.trim(), temporaryPassword), 'Sign-in email changed.')
              }
            >
              Change email
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        <Input
          label="New email"
          type="email"
          required
          maxLength={254}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={newEmail}
          error={issues.newEmail}
          disabled={busy}
          onChange={(event) => setNewEmail(event.target.value)}
        />
        <PasswordInput
          label="New temporary password"
          required
          autoComplete="new-password"
          value={temporaryPassword}
          error={issues.temporaryPassword}
          disabled={busy}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Give it to them directly — it is never shown again.`}
          onChange={(event) => setTemporaryPassword(event.target.value)}
        />
        <Alert tone="warning">
          They must change this temporary password the next time they sign in.
        </Alert>
      </Modal>

      <Modal
        open={dialog === 'reset'}
        onClose={closeDialog}
        busy={busy}
        title="Reset password"
        description="Issues a new temporary password for this employee."
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={temporaryPassword.length < MIN_PASSWORD_LENGTH}
              onClick={() => void run(() => resetEmployeePassword(id, temporaryPassword), 'Password reset.')}
            >
              Reset password
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        <PasswordInput
          label="New temporary password"
          required
          autoComplete="new-password"
          value={temporaryPassword}
          error={issues.temporaryPassword}
          disabled={busy}
          hint={`At least ${MIN_PASSWORD_LENGTH} characters. Give it to them directly — it is never shown again.`}
          onChange={(event) => setTemporaryPassword(event.target.value)}
        />
        <Alert tone="warning">
          Their current password stops working immediately, and they must set a new one at their next sign-in.
        </Alert>
      </Modal>

      <Modal
        open={dialog === 'disable'}
        onClose={closeDialog}
        busy={busy}
        title="Disable this account"
        description={`${employee.displayName} will lose access on their very next request.`}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void run(() => disableEmployee(id), 'Account disabled.')}>
              Disable account
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        <Alert tone="info">
          Their Company, Team, Position, permissions, and history are all preserved. The account can be re-enabled
          later.
        </Alert>
      </Modal>

      <Modal
        open={dialog === 'enable'}
        onClose={closeDialog}
        busy={busy}
        title="Re-enable this account"
        description={`${employee.displayName} regains access with the same Company, Team, Position, and permissions.`}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} onClick={() => void run(() => enableEmployee(id), 'Account re-enabled.')}>
              Re-enable account
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
      </Modal>

      <Modal
        open={dialog === 'viewAll'}
        onClose={closeDialog}
        busy={busy}
        title={viewAllGranted ? 'Revoke “View all permits”' : 'Grant “View all permits”'}
        description="Allows this employee to view all permits. It does not grant approval authority."
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant={viewAllGranted ? 'danger' : 'primary'}
              loading={busy}
              onClick={() =>
                void run(
                  () => setViewAllPermits(id, !viewAllGranted),
                  viewAllGranted ? 'Permission revoked.' : 'Permission granted.',
                )
              }
            >
              {viewAllGranted ? 'Revoke permission' : 'Grant permission'}
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        <Alert tone="info">
          {viewAllGranted
            ? 'Broad visibility ends on their very next request.'
            : 'This is a visibility permission only. It cannot approve, forward, hold, cancel, or close a permit.'}
        </Alert>
      </Modal>

      <Modal
        open={dialog === 'delete'}
        onClose={closeDialog}
        busy={busy}
        title="Delete this account permanently"
        description={`This cannot be undone. ${employee.displayName} will never be able to sign in again.`}
        footer={
          <>
            <Button variant="secondary" onClick={closeDialog} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() => void run(() => deleteEmployee(id), 'Account permanently deleted.', true)}
            >
              Delete permanently
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        <Alert tone="danger" title="What deletion does">
          <ul style={{ paddingLeft: 'var(--space-5)' }}>
            <li style={{ listStyle: 'disc' }}>Their login becomes permanently unusable.</li>
            <li style={{ listStyle: 'disc' }}>The account cannot be re-enabled afterwards.</li>
          </ul>
        </Alert>
        <Alert tone="info" title="What deletion does not do">
          Every permit, Job Safety Analysis, signature, and audit record they were part of remains exactly as it is.
          Operational history is never erased.
        </Alert>
      </Modal>
    </>
  );
}
