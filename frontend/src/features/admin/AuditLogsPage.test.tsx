import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ceo,
  croEmployee,
  hseApprover,
  normalEmployee,
  siteManager,
  zplSiteManagerEmployee,
} from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { AuditLogsPage } from './AuditLogsPage';

/**
 * Administration → Audit Logs.
 *
 * The access matrix is the whole point of this screen, so it is asserted
 * identity by identity rather than as a single happy path. The two
 * distinctions that actually bite are here explicitly: a ZPL
 * organizational "Site Manager" job title is NOT the privileged system
 * role, and `permit.view_all` widens permit VISIBILITY without ever
 * becoming audit access.
 */

const ENTRY = {
  eventType: 'EMPLOYEE_ACCOUNT_CREATED',
  actorUserId: 'actor-1',
  targetUserId: 'target-1',
  occurredAt: '2026-01-01T09:00:00.000Z',
  previousCompanyCode: null,
  newCompanyCode: null,
  previousTeamPositionId: null,
  newTeamPositionId: null,
  capabilityName: null,
  targetDisplayName: 'Ali Khan',
  actorDisplayName: 'Sara Ahmed',
};

const PAGE = {
  'GET /api/v1/admin/audit-logs': {
    body: { items: [ENTRY], page: 1, pageSize: 25, totalCount: 1, totalPages: 1 },
  },
};

describe('who may open Audit Logs', () => {
  it('allows the CEO', async () => {
    stubFetch(PAGE);
    renderAs(<AuditLogsPage />, ceo());
    expect(await screen.findByTestId('audit-row')).toBeInTheDocument();
  });

  it('allows a System Site Manager', async () => {
    stubFetch(PAGE);
    renderAs(<AuditLogsPage />, siteManager());
    expect(await screen.findByTestId('audit-row')).toBeInTheDocument();
  });

  it('refuses everyone else, and does not even request the audit', () => {
    for (const [label, user] of [
      ['a normal employee', normalEmployee()],
      ['a CRO', croEmployee()],
      ['an HSE approver', hseApprover()],
      // A ZPL job title that merely reads "Site Manager".
      ['a ZPL Site Manager', zplSiteManagerEmployee()],
      // Broad permit visibility is not audit access.
      ['a permit.view_all holder', normalEmployee({ capabilities: ['permit.view_all'] })],
    ] as const) {
      const { calls } = stubFetch(PAGE);
      const { unmount } = renderAs(<AuditLogsPage />, user);
      expect(screen.queryByTestId('audit-row'), label).not.toBeInTheDocument();
      expect(screen.getByText(/do not have access/i), label).toBeInTheDocument();
      expect(calls, label).toHaveLength(0);
      unmount();
    }
  });
});

describe('the record itself', () => {
  it('is read-only - it offers no edit or delete control', async () => {
    stubFetch(PAGE);
    renderAs(<AuditLogsPage />, ceo());
    await screen.findByTestId('audit-row');

    for (const forbidden of [/edit/i, /delete/i, /remove/i, /correct/i]) {
      expect(screen.queryByRole('button', { name: forbidden })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/cannot be edited or deleted/i)).toBeInTheDocument();
  });

  it('names the people involved rather than showing raw identifiers', async () => {
    stubFetch(PAGE);
    renderAs(<AuditLogsPage />, ceo());
    const row = await screen.findByTestId('audit-row');

    expect(row).toHaveTextContent('Ali Khan');
    expect(row).toHaveTextContent('Sara Ahmed');
    // The ids behind those names are exactly what an administrative
    // screen has no business displaying.
    expect(row).not.toHaveTextContent('actor-1');
    expect(row).not.toHaveTextContent('target-1');
  });

  it('says so plainly when nothing has been recorded yet', async () => {
    stubFetch({
      'GET /api/v1/admin/audit-logs': {
        body: { items: [], page: 1, pageSize: 25, totalCount: 0, totalPages: 0 },
      },
    });
    renderAs(<AuditLogsPage />, ceo());
    expect(await screen.findByText(/no administrative changes recorded/i)).toBeInTheDocument();
  });
});
