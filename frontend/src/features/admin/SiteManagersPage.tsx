import { useState, type FormEvent } from 'react';
import { createSiteManager, listSiteManagers, setSiteManagerGrant } from '../../api/endpoints';
import { asApiError, fieldErrors } from '../../api/errors';
import type { SiteManagerListItem } from '../../api/types';
import { useCurrentUser } from '../../auth/useAuth';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Dialog';
import { FormError, Input, PasswordInput } from '../../ui/Field';
import { Alert, ErrorState, SkeletonRows } from '../../ui/Feedback';
import { Badge, Card, PageHeader } from '../../ui/Layout';
import { useToast } from '../../ui/Toast';

/**
 * E-SET Site Manager administration. CEO ONLY.
 *
 * A SITE MANAGER IS NOT AN EMPLOYEE. A privileged system account has a
 * personal name and a login, and NOTHING ELSE - no Company, no Team, no
 * Position. This screen therefore reuses none of the employee
 * organizational fields, and the backend's schema for creating one is
 * `.strict()` with no company/team/position field at all, so supplying
 * one is rejected rather than ignored.
 *
 * IT IS ALSO NOT THE CEO TIER. The role this endpoint grants is fixed
 * server-side; no request from here can reach or create a CEO, and the
 * listing excludes any identity holding an active CEO grant.
 *
 * THE PRIVILEGED CHANNEL IS AN OPERATOR PREREQUISITE. Privileged
 * administration runs over a separate, narrowly-scoped database login
 * which is not configured in every environment. When the backend reports
 * that, this says so professionally and stops - it never names the
 * missing credential, the variable, or the host.
 */

const MIN_PASSWORD_LENGTH = 12;

function unavailableNotice(error: unknown): boolean {
  return asApiError(error).code === 'privileged_management_unavailable';
}

export function SiteManagersPage() {
  const { capabilities } = useCurrentUser();
  const toast = useToast();
  const resource = useApiResource<{ siteManagers: SiteManagerListItem[] }>(
    (signal) => listSiteManagers(signal),
    [],
    { enabled: capabilities.canManageSiteManagers },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [pendingGrant, setPendingGrant] = useState<SiteManagerListItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; requestId: string | null } | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});

  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [temporaryPassword, setTemporaryPassword] = useState('');

  const channelUnavailable = resource.error !== null && unavailableNotice(resource.error);

  if (!capabilities.canManageSiteManagers) {
    return (
      <>
        <PageHeader eyebrow="Administration" title="System Site Managers" />
        <Alert tone="warning" title="Not available to you">
          System Site Manager administration is reserved to the CEO. A System Site Manager cannot appoint or remove
          another System Site Manager.
        </Alert>
      </>
    );
  }

  function resetForm(): void {
    setDisplayName('');
    setEmail('');
    setTemporaryPassword('');
    setError(null);
    setIssues({});
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setIssues({});

    if (temporaryPassword.length < MIN_PASSWORD_LENGTH) {
      setIssues({ temporaryPassword: `Use at least ${MIN_PASSWORD_LENGTH} characters.` });
      return;
    }

    setBusy(true);
    try {
      await createSiteManager({
        displayName: displayName.trim(),
        email: email.trim(),
        temporaryPassword,
      });
      // Cleared immediately; never stored, logged, or returned.
      setTemporaryPassword('');
      toast.show('Site Manager account created.');
      setCreateOpen(false);
      resetForm();
      resource.reload();
    } catch (caught) {
      const apiError = asApiError(caught);
      setTemporaryPassword('');
      setError({ message: apiError.message, requestId: apiError.requestId });
      setIssues(fieldErrors(apiError));
    } finally {
      setBusy(false);
    }
  }

  async function handleGrantChange(): Promise<void> {
    if (!pendingGrant || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setSiteManagerGrant(pendingGrant.userId, !pendingGrant.active);
      toast.show(pendingGrant.active ? 'Site Manager authority revoked.' : 'Site Manager authority granted.');
      setPendingGrant(null);
      resource.reload();
    } catch (caught) {
      const apiError = asApiError(caught);
      setError({ message: apiError.message, requestId: apiError.requestId });
    } finally {
      setBusy(false);
    }
  }

  // Defensive: a response missing this key must render an empty list,
  // never crash the screen.
  const siteManagers = resource.data?.siteManagers ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="System Site Managers"
        description="System Site Managers are privileged E-SET system accounts, distinct from the ZPL Site Manager job title. They hold a personal name and a login — no Company, Team, or Position."
        actions={
          <Button
            variant="primary"
            // Offering a form that can only fail is worse than saying so:
            // creating an account needs the same privileged channel the
            // listing just proved is absent.
            disabled={channelUnavailable}
            title={channelUnavailable ? 'Not available until the privileged channel is configured' : undefined}
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
          >
            Add Site Manager
          </Button>
        }
      />

      <div className="stack">
        {channelUnavailable ? (
          <Alert tone="warning" title="Site Manager administration is not available in this environment">
            The privileged administration channel has not been configured yet. Employee administration and the permit
            workflow are unaffected. Contact your operator.
          </Alert>
        ) : null}

        <Card flush>
          {resource.initialLoading ? (
            <SkeletonRows rows={3} />
          ) : resource.error && !channelUnavailable ? (
            <ErrorState error={resource.error} onRetry={resource.reload} />
          ) : siteManagers.length === 0 ? (
            <div className="state">
              <p className="state__title">No System Site Managers</p>
              <p className="state__body">
                {channelUnavailable
                  ? 'The list cannot be read until the privileged channel is configured.'
                  : 'No E-SET Site Manager accounts have been established yet.'}
              </p>
            </div>
          ) : (
            <ul className="record-list">
              {siteManagers.map((siteManager) => (
                <li key={siteManager.userId} className="record-list__item">
                  <div className="record-list__head">
                    <span style={{ fontWeight: 600 }}>{siteManager.displayName}</span>
                    {siteManager.active ? <Badge tone="success">Active</Badge> : <Badge>Revoked</Badge>}
                  </div>
                  <div className="row" style={{ justifyContent: 'space-between', marginTop: 'var(--space-2)' }}>
                    <span className="muted text-sm">
                      {siteManager.accountState === 'DELETED'
                        ? 'The login for this identity has been removed.'
                        : 'Privileged system account. No Company, Team, or Position.'}
                    </span>
                    <Button
                      size="sm"
                      variant={siteManager.active ? 'danger' : 'secondary'}
                      disabled={siteManager.accountState === 'DELETED'}
                      onClick={() => {
                        setError(null);
                        setPendingGrant(siteManager);
                      }}
                    >
                      {siteManager.active ? 'Revoke authority' : 'Restore authority'}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Modal
        open={createOpen}
        onClose={() => {
          if (!busy) {
            setCreateOpen(false);
            resetForm();
          }
        }}
        busy={busy}
        title="Add a Site Manager"
        description="This creates a privileged system account with a personal name and a login. It has no Company, Team, or Position, and none can be given to it."
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setCreateOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" loading={busy} form="create-site-manager" type="submit">
              Create Site Manager
            </Button>
          </>
        }
      >
        <form id="create-site-manager" onSubmit={handleCreate} noValidate className="stack">
          {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
          <Input
            label="Personal name"
            required
            maxLength={120}
            value={displayName}
            error={issues.displayName}
            disabled={busy}
            hint="The name this account signs with. No role or company is appended to it."
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Input
            label="Login email"
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            error={issues.email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
          />
          <PasswordInput
            label="Temporary password"
            required
            autoComplete="new-password"
            value={temporaryPassword}
            error={issues.temporaryPassword}
            disabled={busy}
            hint={`At least ${MIN_PASSWORD_LENGTH} characters. Give it to them directly — it is never shown again.`}
            onChange={(event) => setTemporaryPassword(event.target.value)}
          />
          <Alert tone="info">They must change this temporary password the first time they sign in.</Alert>
        </form>
      </Modal>

      <Modal
        open={pendingGrant !== null}
        onClose={() => {
          if (!busy) setPendingGrant(null);
        }}
        busy={busy}
        title={pendingGrant?.active ? 'Revoke Site Manager authority' : 'Restore Site Manager authority'}
        description={
          pendingGrant?.active
            ? `${pendingGrant.displayName} keeps their account and their name, but loses Site Manager authority on their very next request.`
            : `${pendingGrant?.displayName ?? 'This account'} regains Site Manager authority.`
        }
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setPendingGrant(null)}>
              Cancel
            </Button>
            <Button
              variant={pendingGrant?.active ? 'danger' : 'primary'}
              loading={busy}
              onClick={() => void handleGrantChange()}
            >
              {pendingGrant?.active ? 'Revoke authority' : 'Restore authority'}
            </Button>
          </>
        }
      >
        {error ? <FormError message={error.message} requestId={error.requestId} /> : null}
        <Alert tone="info">
          Every action this account has already taken — permits authorized, employees managed — remains recorded
          against their name.
        </Alert>
      </Modal>
    </>
  );
}
