import { useState } from 'react';
import { listAuditLogs } from '../../api/endpoints';
import type { AuditLogsResponse, GlobalAuditEntry } from '../../api/types';
import { useCurrentUser } from '../../auth/useAuth';
import { useApiResource } from '../../lib/useApiResource';
import { formatDateTime } from '../../lib/format';
import { Button } from '../../ui/Button';
import { Alert, ErrorState, SkeletonRows } from '../../ui/Feedback';
import { PageHeader } from '../../ui/Layout';

/**
 * Administration → Audit Logs: the organization-wide administrative and
 * security trail.
 *
 * WHO SEES IT. The CEO and a system Site Manager, and nobody else. The
 * gate here is only the navigational half - the server re-checks the
 * privileged grant log on every request and refuses independently, so a
 * typed URL reaches a 403 rather than this screen's data.
 *
 * READ-ONLY BY CONSTRUCTION. There is no edit or delete control on this
 * page because there is no endpoint behind one: `account_audit_events` is
 * append-only in the database for every role including the CEO. A
 * correction appends a new event; it never rewrites an existing one.
 *
 * NOT PERMIT HISTORY. A permit's own lifecycle is business information
 * for the people working that permit and stays on the permit itself.
 * This screen is about accounts and access.
 *
 * WHAT IS DELIBERATELY NOT SHOWN: user ids, raw team-position ids, the
 * append-only ordinal, credential versions. People are named where the
 * server could resolve a name, and identified as "a removed account"
 * where it could not - a raw UUID means nothing to a reader and is
 * exactly the identifier an administrative screen has no business
 * displaying.
 */

const COMPANY_NAMES: Record<string, string> = { E_SET: 'E-SET', ZPL: 'ZPL', SGRE: 'SGRE' };

function companyName(code: string | null): string {
  if (!code) return 'none';
  return COMPANY_NAMES[code] ?? code;
}

function describe(entry: GlobalAuditEntry): string {
  switch (entry.eventType) {
    case 'EMPLOYEE_ACCOUNT_CREATED':
      return 'Account created';
    case 'EMPLOYEE_DISPLAY_NAME_CHANGED':
      return 'Name changed';
    case 'EMPLOYEE_EMAIL_CHANGED':
      return 'Sign-in email changed';
    case 'EMPLOYEE_PASSWORD_RESET_BY_MANAGER':
      return 'Password reset by a manager';
    case 'EMPLOYEE_PASSWORD_CHANGED':
      return 'Password changed by the employee';
    case 'EMPLOYEE_COMPANY_CHANGED':
      return `Company changed from ${companyName(entry.previousCompanyCode)} to ${companyName(entry.newCompanyCode)}`;
    case 'EMPLOYEE_TEAM_POSITION_CHANGED':
      return 'Team and Position changed';
    case 'EMPLOYEE_PERMISSION_GRANTED':
      return entry.capabilityName === 'permit.view_all'
        ? 'Granted “View all permits”'
        : 'Permission granted';
    case 'EMPLOYEE_PERMISSION_REVOKED':
      return entry.capabilityName === 'permit.view_all'
        ? 'Revoked “View all permits”'
        : 'Permission revoked';
    case 'EMPLOYEE_DISABLED':
      return 'Account disabled';
    case 'EMPLOYEE_REENABLED':
      return 'Account re-enabled';
    case 'EMPLOYEE_ACCOUNT_DELETED':
      return 'Account permanently deleted';
    default:
      return entry.eventType.replaceAll('_', ' ').toLowerCase();
  }
}

const personName = (name: string | null): string => name ?? 'a removed account';

export function AuditLogsPage() {
  const { capabilities } = useCurrentUser();
  const [page, setPage] = useState(1);
  const resource = useApiResource<AuditLogsResponse>(
    (signal) => listAuditLogs({ page, pageSize: 25 }, signal),
    [page],
  );

  if (!capabilities.canViewAdministrativeAudit) {
    return (
      <>
        <PageHeader eyebrow="Administration" title="Audit Logs" />
        <Alert tone="warning" title="Not available to you">
          The audit logs are reserved to the CEO and System Site Managers. You do not have access to them.
        </Alert>
      </>
    );
  }

  const entries = resource.data?.items ?? [];
  const totalPages = resource.data?.totalPages ?? 0;

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Audit Logs"
        description="Every administrative and security change to accounts and access, newest first. This record is permanent and cannot be edited or deleted."
      />

      <div className="card" data-testid="audit-logs">
        {resource.initialLoading ? (
          <SkeletonRows rows={5} />
        ) : resource.error ? (
          <ErrorState error={resource.error} onRetry={resource.reload} />
        ) : entries.length === 0 ? (
          <div className="state">
            <p className="state__title">No administrative changes recorded</p>
            <p className="state__body">
              Account and access changes will appear here as they happen.
            </p>
          </div>
        ) : (
          <>
            <ol className="record-list" style={{ listStyle: 'none' }}>
              {entries.map((entry, index) => (
                <li
                  key={`${entry.eventType}-${entry.occurredAt}-${index}`}
                  className="record-list__item"
                  data-testid="audit-row"
                >
                  <div className="record-list__head">
                    <span style={{ fontWeight: 600 }}>{describe(entry)}</span>
                    <span className="muted text-sm">{formatDateTime(entry.occurredAt)}</span>
                  </div>
                  <p className="muted text-sm" style={{ marginTop: 'var(--space-2)' }}>
                    {personName(entry.targetDisplayName)} — by {personName(entry.actorDisplayName)}
                  </p>
                </li>
              ))}
            </ol>

            {totalPages > 1 ? (
              <div className="row" style={{ justifyContent: 'space-between', marginTop: 'var(--space-4)' }}>
                <Button
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Previous
                </Button>
                <span className="muted text-sm">
                  Page {resource.data?.page ?? page} of {totalPages}
                </span>
                <Button
                  variant="secondary"
                  disabled={page >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
