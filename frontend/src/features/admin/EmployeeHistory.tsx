import type { AccountAuditEntry } from '../../api/types';
import { formatDateTime } from '../../lib/format';

/**
 * One employee's administrative history.
 *
 * WHAT IS SHOWN: what was done, and when. Company changes are named,
 * because the backend records them by foreign key and returns the code.
 *
 * WHAT IS DELIBERATELY NOT SHOWN: the append-only ordinal, the actor's
 * user id, the target's user id, the raw `teamPositionId` on either side
 * of a transfer, the credential version, and any reset internals. None
 * of those means anything to a manager, and several are exactly the
 * identifiers an administrative screen has no business displaying.
 * `account_audit_events` has no free-text column at all, so nothing here
 * can carry a value that was ever a secret.
 */

const COMPANY_NAMES: Record<string, string> = { E_SET: 'E-SET', ZPL: 'ZPL', SGRE: 'SGRE' };

function companyName(code: string | null): string {
  if (!code) return 'none';
  return COMPANY_NAMES[code] ?? code;
}

function describe(entry: AccountAuditEntry): string {
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

export function EmployeeHistory({ entries }: { entries: AccountAuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="muted">No administrative changes have been recorded for this account.</p>;
  }

  return (
    <ol className="record-list" style={{ listStyle: 'none' }}>
      {entries.map((entry, index) => (
        <li key={`${entry.eventType}-${entry.occurredAt}-${index}`} className="record-list__item">
          <div className="record-list__head">
            <span style={{ fontWeight: 600 }}>{describe(entry)}</span>
            <span className="muted text-sm">{formatDateTime(entry.occurredAt)}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}
