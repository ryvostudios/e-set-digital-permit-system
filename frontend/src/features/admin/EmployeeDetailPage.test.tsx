import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import { ORGANIZATION, ceo, employeeDetail, normalEmployee, siteManager } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { EmployeeDetailPage } from './EmployeeDetailPage';

/**
 * One employee's management record.
 *
 * The rules under test: every sensitive action confirms first, the
 * request body is built field by field, the CEO-only deletion is not
 * shown to a Site Manager, and no internal identifier or credential
 * detail reaches the screen.
 */

const TEMP_PASSWORD = 'a-temporary-password';

function renderEmployee(
  detail = employeeDetail(),
  actor = siteManager(),
  extra: Record<string, unknown> = {},
) {
  const harness = stubFetch({
    'GET /api/v1/admin/employees/employee-1': { body: { employee: detail } },
    'GET /api/v1/admin/employees/employee-1/history': {
      body: { items: [], page: 1, pageSize: 25, totalCount: 0, totalPages: 0 },
    },
    'GET /api/v1/admin/organization': { body: ORGANIZATION },
    ...extra,
  } as never);

  const rendered = renderAs(
    <Routes>
      <Route path={ROUTES.employeePattern} element={<EmployeeDetailPage />} />
    </Routes>,
    actor,
    { route: '/admin/employees/employee-1' },
  );
  return { ...harness, ...rendered };
}

async function confirmDialog(user: ReturnType<typeof userEvent.setup>, buttonName: RegExp) {
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: buttonName }));
  return dialog;
}

describe('authorization', () => {
  it('refuses an ordinary employee who reaches the URL directly', () => {
    stubFetch({});
    renderAs(
      <Routes>
        <Route path={ROUTES.employeePattern} element={<EmployeeDetailPage />} />
      </Routes>,
      normalEmployee(),
      { route: '/admin/employees/employee-1' },
    );
    expect(screen.getByText(/reserved to the ceo and e-set site managers/i)).toBeInTheDocument();
  });
});

describe('what is shown', () => {
  it('shows the organizational identity and the account state', async () => {
    renderEmployee();
    expect(await screen.findByRole('heading', { level: 1, name: 'Ali Khan' })).toBeInTheDocument();
    expect(screen.getByText(/ZPL · ZPL · Engineer/)).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('never shows the internal user id, credential version, or reset internals', async () => {
    renderEmployee(employeeDetail({ userId: '9f1a2b3c-0000-4000-8000-000000000001' }));
    await screen.findByRole('heading', { level: 1, name: 'Ali Khan' });

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('9f1a2b3c');
    expect(text).not.toMatch(/credential_version|credentialVersion|reset_pending|user_id/i);
  });

  it('never shows a raw capability list', async () => {
    renderEmployee(employeeDetail({ individualPermissions: ['permit.view_all'] }));
    await screen.findByRole('heading', { level: 1, name: 'Ali Khan' });
    expect(document.body.textContent).not.toContain('permit.view_all');
    // It is named in business language instead.
    expect(screen.getAllByText(/view all permits/i).length).toBeGreaterThan(0);
  });
});

describe('rename', () => {
  it('sends only the display name', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), siteManager(), {
      'PATCH /api/v1/admin/employees/employee-1': { body: { status: 'ok', employee: { userId: 'employee-1' } } },
    });

    await user.click(await screen.findByRole('button', { name: /change name/i }));
    const dialog = await screen.findByRole('dialog');
    await user.clear(within(dialog).getByLabelText(/display name/i));
    await user.type(within(dialog).getByLabelText(/display name/i), 'Ali R. Khan');
    await user.click(within(dialog).getByRole('button', { name: /save name/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ displayName: 'Ali R. Khan' });
  });

  it('explains that renaming does not rewrite permits already signed', async () => {
    const user = userEvent.setup();
    renderEmployee();
    await user.click(await screen.findByRole('button', { name: /change name/i }));
    expect(await screen.findByText(/keep the name they carried at the time/i)).toBeInTheDocument();
  });
});

describe('transfer', () => {
  it('sends the company and the assignment together', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), siteManager(), {
      'PATCH /api/v1/admin/employees/employee-1': { body: { status: 'ok', employee: { userId: 'employee-1' } } },
    });

    await user.click(await screen.findByRole('button', { name: /^transfer$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText(/^company/i), 'E_SET');
    await user.selectOptions(within(dialog).getByLabelText(/team and position/i), 'tp-ebop-cro');
    await user.click(within(dialog).getByRole('button', { name: /^transfer$/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
      companyCode: 'E_SET',
      teamPositionId: 'tp-ebop-cro',
    });
  });

  it('states clearly that historical permits are not rewritten', async () => {
    const user = userEvent.setup();
    renderEmployee();
    await user.click(await screen.findByRole('button', { name: /^transfer$/i }));
    expect(
      await screen.findByText(/does not rewrite permits, signatures, or history already recorded/i),
    ).toBeInTheDocument();
  });
});

describe('email change', () => {
  it('requires both a new address and a new temporary password', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/change-email': {
        body: { status: 'ok', employee: { userId: 'employee-1', mustChangePassword: true } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    // Not submittable until both are supplied.
    expect(within(dialog).getByRole('button', { name: /change email/i })).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/new email/i), 'ali.new@example.com');
    await user.type(within(dialog).getByLabelText(/new temporary password/i), TEMP_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: /change email/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('change-email'))).toBe(true));
    expect(calls.find((call) => call.url.includes('change-email'))?.body).toEqual({
      newEmail: 'ali.new@example.com',
      temporaryPassword: TEMP_PASSWORD,
    });
  });

  it('explains that the old login stops working and a new password must be set', async () => {
    const user = userEvent.setup();
    renderEmployee();
    await user.click(await screen.findByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/old one stops working/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/must change this temporary password/i)).toBeInTheDocument();
  });

  it('never leaves the password on screen after the dialog closes', async () => {
    const user = userEvent.setup();
    renderEmployee(employeeDetail(), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/change-email': {
        body: { status: 'ok', employee: { userId: 'employee-1', mustChangePassword: true } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /change email/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/new email/i), 'ali.new@example.com');
    await user.type(within(dialog).getByLabelText(/new temporary password/i), TEMP_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: /change email/i }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(TEMP_PASSWORD);
  });
});

describe('password reset', () => {
  it('sends only the temporary password', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/reset-password': {
        body: { status: 'ok', employee: { userId: 'employee-1', mustChangePassword: true } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /reset password/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/new temporary password/i), TEMP_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: /reset password/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('reset-password'))).toBe(true));
    expect(calls.find((call) => call.url.includes('reset-password'))?.body).toEqual({
      temporaryPassword: TEMP_PASSWORD,
    });
  });

  it('explains the forced change at next sign-in', async () => {
    const user = userEvent.setup();
    renderEmployee();
    await user.click(await screen.findByRole('button', { name: /reset password/i }));
    expect(await screen.findByText(/must set a new one at their next sign-in/i)).toBeInTheDocument();
  });

  it('is available to the CEO as well', async () => {
    renderEmployee(employeeDetail(), ceo());
    expect(await screen.findByRole('button', { name: /reset password/i })).toBeInTheDocument();
  });
});

describe('disable and re-enable', () => {
  it('confirms before disabling, and explains what is preserved', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/disable': {
        body: { status: 'ok', employee: { userId: 'employee-1', state: 'DISABLED' } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /disable account/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/preserved/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: /disable account/i }));
    await waitFor(() => expect(calls.some((call) => call.url.includes('/disable'))).toBe(true));
  });

  it('offers re-enable for a disabled account', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail({ state: 'DISABLED' }), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/enable': {
        body: { status: 'ok', employee: { userId: 'employee-1', state: 'ACTIVE' } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /re-enable account/i }));
    await confirmDialog(user, /re-enable account/i);
    await waitFor(() => expect(calls.some((call) => call.url.includes('/enable'))).toBe(true));
  });

  it('does NOT offer re-enable for a DELETED account - deletion is terminal', async () => {
    renderEmployee(employeeDetail({ state: 'DELETED' }));
    await screen.findByRole('heading', { level: 1, name: 'Ali Khan' });
    expect(screen.getByText(/permanently deleted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-enable account/i })).toBeDisabled();
  });
});

describe('permanent deletion', () => {
  it('is NOT shown to a Site Manager', async () => {
    renderEmployee(employeeDetail(), siteManager());
    await screen.findByRole('heading', { level: 1, name: 'Ali Khan' });
    expect(screen.queryByRole('button', { name: /delete permanently/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/permanent deletion/i)).not.toBeInTheDocument();
  });

  it('is shown to the CEO, behind a strong confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), ceo(), {
      'DELETE /api/v1/admin/employees/employee-1': {
        body: { status: 'ok', employee: { userId: 'employee-1', state: 'DELETED' } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /delete permanently/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
  });

  it('says operational history REMAINS - it never claims records are erased', async () => {
    const user = userEvent.setup();
    renderEmployee(employeeDetail(), ceo());

    await user.click(await screen.findByRole('button', { name: /delete permanently/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/remains exactly as it is/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/never erased/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/login becomes permanently unusable/i)).toBeInTheDocument();
  });
});

describe('View all permits', () => {
  it('is described as visibility only, never approval authority', async () => {
    renderEmployee();
    await screen.findByRole('heading', { level: 1, name: 'Ali Khan' });
    expect(
      screen.getByText(/allows this employee to view all permits\. it does not grant approval authority/i),
    ).toBeInTheDocument();
  });

  it('grants with a POST carrying the one permitted capability name', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/permissions': {
        body: { status: 'ok', employee: { userId: 'employee-1', capability: 'permit.view_all', active: true } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^grant$/i }));
    await confirmDialog(user, /grant permission/i);

    await waitFor(() => expect(calls.some((call) => call.url.includes('/permissions'))).toBe(true));
    const call = calls.find((entry) => entry.url.includes('/permissions'));
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ capability: 'permit.view_all' });
  });

  it('revokes with a DELETE carrying the same capability name', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail({ individualPermissions: ['permit.view_all'] }), siteManager(), {
      'DELETE /api/v1/admin/employees/employee-1/permissions': {
        body: { status: 'ok', employee: { userId: 'employee-1', capability: 'permit.view_all', active: false } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^revoke$/i }));
    await confirmDialog(user, /revoke permission/i);

    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(calls.find((call) => call.method === 'DELETE')?.body).toEqual({ capability: 'permit.view_all' });
  });

  it('offers NO other capability - this is not a general permission-assignment surface', async () => {
    renderEmployee();
    await screen.findByRole('heading', { level: 1, name: 'Ali Khan' });

    const text = document.body.textContent ?? '';
    for (const forbidden of ['cro_review', 'hse_review', 'forward_hse', 'fallback_approve', 'employee.create']) {
      expect(text).not.toContain(forbidden);
    }
    expect(screen.queryByLabelText(/capability/i)).not.toBeInTheDocument();
  });

  it('re-reads the authoritative record after the change, rather than patching locally', async () => {
    const user = userEvent.setup();
    const { calls } = renderEmployee(employeeDetail(), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/permissions': {
        body: { status: 'ok', employee: { userId: 'employee-1', capability: 'permit.view_all', active: true } },
      },
    });

    await user.click(await screen.findByRole('button', { name: /^grant$/i }));
    const before = calls.filter((call) => call.url === '/api/v1/admin/employees/employee-1').length;
    await confirmDialog(user, /grant permission/i);

    await waitFor(() => {
      const after = calls.filter((call) => call.url === '/api/v1/admin/employees/employee-1').length;
      expect(after).toBeGreaterThan(before);
    });
  });
});

describe('administrative history', () => {
  it('reads as friendly events, with no ordinal or actor id', async () => {
    renderEmployee(employeeDetail(), ceo(), {
      'GET /api/v1/admin/employees/employee-1/history': {
        body: {
          items: [
            {
              eventType: 'EMPLOYEE_COMPANY_CHANGED',
              actorUserId: '9f1a2b3c-0000-4000-8000-000000000001',
              occurredAt: '2026-08-20T10:00:00.000Z',
              previousCompanyCode: 'ZPL',
              newCompanyCode: 'E_SET',
              previousTeamPositionId: 'tp-old',
              newTeamPositionId: 'tp-new',
              capabilityName: null,
            },
            {
              eventType: 'EMPLOYEE_PERMISSION_GRANTED',
              actorUserId: '9f1a2b3c-0000-4000-8000-000000000001',
              occurredAt: '2026-08-19T10:00:00.000Z',
              previousCompanyCode: null,
              newCompanyCode: null,
              previousTeamPositionId: null,
              newTeamPositionId: null,
              capabilityName: 'permit.view_all',
            },
          ],
          page: 1,
          pageSize: 25,
          totalCount: 2,
          totalPages: 1,
        },
      },
    });

    expect(await screen.findByText(/Company changed from ZPL to E-SET/)).toBeInTheDocument();
    expect(screen.getByText(/Granted “View all permits”/)).toBeInTheDocument();

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('9f1a2b3c');
    expect(text).not.toContain('tp-old');
    expect(text).not.toContain('EMPLOYEE_COMPANY_CHANGED');
  });

  it('is hidden from a Site Manager, who is never even asked for it', async () => {
    // A Site Manager performs employee administration and so APPEARS in
    // this log as an actor. Reading it would let the administered watch
    // the record of their own administration, so the section is not
    // rendered - and no request is issued, so there is no failed call to
    // hint that a withheld panel exists.
    const { calls } = renderEmployee(employeeDetail(), siteManager());

    // Wait for the page to actually render before asserting an absence.
    expect(await screen.findByRole('button', { name: /disable account/i })).toBeInTheDocument();
    expect(screen.queryByText(/administrative history/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no administrative changes have been recorded/i)).not.toBeInTheDocument();

    await waitFor(() => expect(calls.some((call) => call.url.includes('/admin/employees/employee-1'))).toBe(true));
    expect(calls.some((call) => call.url.includes('/history'))).toBe(false);
  });

  it('is shown to the CEO', async () => {
    renderEmployee(employeeDetail(), ceo());
    expect(await screen.findByText(/administrative history/i)).toBeInTheDocument();
  });

  it('shows an explicit empty state', async () => {
    renderEmployee(employeeDetail(), ceo());
    expect(await screen.findByText(/no administrative changes have been recorded/i)).toBeInTheDocument();
  });
});

describe('failures', () => {
  it('shows a 404 as "not available" rather than an empty record', async () => {
    stubFetch({
      'GET /api/v1/admin/employees/employee-1': { status: 404, body: { error: 'not_found' } },
      'GET /api/v1/admin/employees/employee-1/history': { status: 404, body: { error: 'not_found' } },
      'GET /api/v1/admin/organization': { body: ORGANIZATION },
    });
    renderAs(
      <Routes>
        <Route path={ROUTES.employeePattern} element={<EmployeeDetailPage />} />
      </Routes>,
      siteManager(),
      { route: '/admin/employees/employee-1' },
    );
    expect(await screen.findByText(/that record is not available/i)).toBeInTheDocument();
  });

  it('reports a refused change without technical detail', async () => {
    const user = userEvent.setup();
    renderEmployee(employeeDetail(), siteManager(), {
      'POST /api/v1/admin/employees/employee-1/disable': {
        status: 409,
        body: { error: 'conflict', reason: 'account_deleted', message: 'That change is not permitted' },
      },
    });

    await user.click(await screen.findByRole('button', { name: /disable account/i }));
    await confirmDialog(user, /disable account/i);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/that change is not permitted/i)).toBeInTheDocument();
  });
});
