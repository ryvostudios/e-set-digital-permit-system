import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { ROUTES } from '../../app/routes';
import { employeeDetail, ORGANIZATION, siteManager } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { CreateEmployeePage } from './CreateEmployeePage';
import { EmployeeDetailPage } from './EmployeeDetailPage';

/**
 * RUNTIME-CREATED COMPANIES IN EMPLOYEE ADMINISTRATION.
 *
 * Organization Management creates companies at runtime, and
 * `GET /admin/organization` already returns them. These screens used to
 * hold their own hardcoded three-company array, so a company like ABB
 * was invisible here even while the API offered it.
 *
 * What these specs pin down is that the Company options come from the
 * SERVER RESPONSE and from nothing else - so a company created after
 * this build shipped appears with no code change, and no test encodes
 * an expectation that the options are exactly E_SET/ZPL/SGRE.
 */

/**
 * The production shape that exposed the gap:
 *
 *   ABB
 *   └── ADMIN
 *       ├── Assist ADMIN
 *       └── LEAD
 *
 * One team, so it also exercises the single-team shortcut - the Team
 * control is hidden and the team resolved internally.
 */
const ABB = {
  code: 'ABB',
  name: 'ABB',
  teams: [
    {
      teamName: 'ADMIN',
      positions: [
        { teamPositionId: 'tp-abb-assist', positionName: 'Assist ADMIN' },
        { teamPositionId: 'tp-abb-lead', positionName: 'LEAD' },
      ],
    },
  ],
};

const ORGANIZATION_WITH_ABB = { companies: [...ORGANIZATION.companies, ABB] };

function stubAdmin(extra: Record<string, unknown> = {}) {
  return stubFetch({
    'GET /api/v1/admin/organization': { body: ORGANIZATION_WITH_ABB },
    ...extra,
  });
}

async function chooseCompany(code: string): Promise<void> {
  const company = await screen.findByLabelText(/company/i);
  await userEvent.selectOptions(company, code);
}

describe('Add employee', () => {
  it('renders a runtime company returned by the server', async () => {
    stubAdmin();
    renderAs(<CreateEmployeePage />, siteManager());

    const company = await screen.findByLabelText(/company/i);
    expect(within(company).getByRole('option', { name: 'ABB' })).toBeInTheDocument();
    // ...alongside the seeded ones, which must not regress.
    expect(within(company).getByRole('option', { name: 'E-SET' })).toBeInTheDocument();
  });

  it('takes its Company options from the SERVER, not from a built-in list', async () => {
    // A response containing only a runtime company must produce only that
    // option. A hardcoded array would still show E-SET/ZPL/SGRE here.
    stubFetch({
      'GET /api/v1/admin/organization': { body: { companies: [ABB] } },
    });
    renderAs(<CreateEmployeePage />, siteManager());

    const company = await screen.findByLabelText(/company/i);
    const options = within(company)
      .getAllByRole('option')
      .map((option) => option.textContent)
      .filter((label) => label && !/choose a company/i.test(label));
    expect(options).toEqual(['ABB']);
  });

  it('uses the runtime company OWN teams and positions', async () => {
    stubAdmin();
    renderAs(<CreateEmployeePage />, siteManager());
    await chooseCompany('ABB');

    // One team, so the Team control is not asked about at all.
    expect(screen.queryByLabelText(/team/i)).not.toBeInTheDocument();

    const position = await screen.findByLabelText(/position/i);
    const options = within(position)
      .getAllByRole('option')
      .map((option) => option.textContent)
      .filter((label) => label && !/choose/i.test(label));
    expect(options).toEqual(['Assist ADMIN', 'LEAD']);
  });

  it('submits the runtime companyCode with the chosen teamPositionId', async () => {
    const { calls } = stubAdmin({
      'POST /api/v1/admin/employees': { status: 201, body: { employee: { userId: 'u-new' } } },
    });
    renderAs(<CreateEmployeePage />, siteManager());

    await userEvent.type(await screen.findByLabelText(/full name|display name/i), 'New Hire');
    await userEvent.type(screen.getByLabelText(/email/i), 'new.hire@abb.example.com');
    await userEvent.type(screen.getByLabelText(/temporary password/i), 'a-temporary-password');
    await chooseCompany('ABB');
    await userEvent.selectOptions(await screen.findByLabelText(/position/i), 'tp-abb-lead');
    await userEvent.click(screen.getByRole('button', { name: /create (employee|account)/i }));

    await waitFor(() => {
      const created = calls.find((call) => call.method === 'POST');
      expect(created).toBeDefined();
      const body = created?.body as Record<string, unknown>;
      expect(body.companyCode).toBe('ABB');
      expect(body.teamPositionId).toBe('tp-abb-lead');
    });
  });

  it('never submits a company id, name, capability or authority field', async () => {
    const { calls } = stubAdmin({
      'POST /api/v1/admin/employees': { status: 201, body: { employee: { userId: 'u-new' } } },
    });
    renderAs(<CreateEmployeePage />, siteManager());

    await userEvent.type(await screen.findByLabelText(/full name|display name/i), 'New Hire');
    await userEvent.type(screen.getByLabelText(/email/i), 'new.hire@abb.example.com');
    await userEvent.type(screen.getByLabelText(/temporary password/i), 'a-temporary-password');
    await chooseCompany('ABB');
    await userEvent.selectOptions(await screen.findByLabelText(/position/i), 'tp-abb-lead');
    await userEvent.click(screen.getByRole('button', { name: /create (employee|account)/i }));

    await waitFor(() => {
      const created = calls.find((call) => call.method === 'POST');
      expect(created).toBeDefined();
      const keys = Object.keys(created?.body as Record<string, unknown>);
      for (const forbidden of [
        'companyId',
        'companyName',
        'capabilities',
        'capability',
        'siteManagerAssignable',
        'privilegedRoles',
        'role',
        'teamName',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  it('still asks for a Team where a company genuinely has several', async () => {
    stubAdmin();
    renderAs(<CreateEmployeePage />, siteManager());
    await chooseCompany('E_SET');

    // E-SET has three teams, so the question is real - no regression to
    // the single-team shortcut logic.
    expect(await screen.findByLabelText(/team/i)).toBeInTheDocument();
  });
});

describe('Transfer employee', () => {
  function renderDetail(extra: Record<string, unknown> = {}) {
    // Same envelope and id the existing EmployeeDetailPage suite uses:
    // the detail is wrapped in `{ employee }`, and the page also loads
    // its history.
    const stub = stubAdmin({
      'GET /api/v1/admin/employees/employee-1': { body: { employee: employeeDetail() } },
      'GET /api/v1/admin/employees/employee-1/history': {
        body: { items: [], page: 1, pageSize: 25, totalCount: 0, totalPages: 0 },
      },
      ...extra,
    } as never);
    renderAs(
      <Routes>
        <Route path={ROUTES.employeePattern} element={<EmployeeDetailPage />} />
      </Routes>,
      siteManager(),
      { route: '/admin/employees/employee-1' },
    );
    return stub;
  }

  /** Opens the Transfer dialog and returns it, scoped. */
  async function openTransfer() {
    await userEvent.click(await screen.findByRole('button', { name: /^transfer$/i }));
    return within(await screen.findByRole('dialog'));
  }

  it('renders the runtime company as a transfer destination', async () => {
    renderDetail();
    const dialog = await openTransfer();
    const company = dialog.getByLabelText(/company/i);
    expect(within(company).getByRole('option', { name: 'ABB' })).toBeInTheDocument();
  });

  it('submits a transfer to the runtime company and its assignment', async () => {
    const { calls } = renderDetail({
      'PATCH /api/v1/admin/employees/employee-1': { body: { status: 'ok', employee: { userId: 'employee-1' } } },
    });

    const dialog = await openTransfer();
    await userEvent.selectOptions(dialog.getByLabelText(/company/i), 'ABB');
    await userEvent.selectOptions(dialog.getByLabelText(/position/i), 'tp-abb-assist');
    // The dialog's own confirm button - the page behind it keeps a
    // same-named trigger.
    await userEvent.click(dialog.getByRole('button', { name: /^transfer$/i }));

    await waitFor(() => {
      const patched = calls.find((call) => call.method === 'PATCH');
      expect(patched).toBeDefined();
      const body = patched?.body as Record<string, unknown>;
      expect(body.companyCode).toBe('ABB');
      expect(body.teamPositionId).toBe('tp-abb-assist');
      expect(Object.keys(body)).not.toContain('companyId');
    });
  });
});
