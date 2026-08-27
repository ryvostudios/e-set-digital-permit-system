import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ceo, normalEmployee, siteManager } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { EmployeeListPage } from './EmployeeListPage';

/**
 * The employee directory.
 *
 * What matters here: privileged accounts are not listed as employees,
 * no email address is displayed (the API does not return one), and
 * searching/paging really happen on the server.
 */

const EMPLOYEE = {
  userId: 'employee-1',
  displayName: 'Ali Khan',
  state: 'ACTIVE' as const,
  mustChangePassword: false,
  company: { code: 'ZPL', name: 'ZPL' },
  teamName: 'ZPL',
  positionName: 'Engineer',
  teamPositionId: 'tp-zpl-engineer',
  viewAllPermits: false,
};

function listResponse(employees: unknown[], overrides = {}) {
  return {
    body: {
      employees,
      pagination: { page: 1, pageSize: 25, totalCount: employees.length, totalPages: 1, ...overrides },
    },
  };
}

describe('the list', () => {
  it('shows the safe fields the API returns', async () => {
    stubFetch({ 'GET /api/v1/admin/employees': listResponse([EMPLOYEE]) });
    renderAs(<EmployeeListPage />, siteManager());

    await waitFor(() => expect(screen.getAllByText('Ali Khan').length).toBeGreaterThan(0));
    expect(screen.getAllByText('ZPL').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Engineer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
  });

  it('shows no email address, because the API returns none', async () => {
    stubFetch({ 'GET /api/v1/admin/employees': listResponse([EMPLOYEE]) });
    renderAs(<EmployeeListPage />, siteManager());

    await waitFor(() => expect(screen.getAllByText('Ali Khan').length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toMatch(/@/);
  });

  it('shows the View all permits state where the API reports it', async () => {
    stubFetch({
      'GET /api/v1/admin/employees': listResponse([{ ...EMPLOYEE, viewAllPermits: true }]),
    });
    renderAs(<EmployeeListPage />, siteManager());

    await waitFor(() => expect(screen.getAllByText(/granted/i).length).toBeGreaterThan(0));
  });

  it('shows an explicit empty state', async () => {
    stubFetch({ 'GET /api/v1/admin/employees': listResponse([]) });
    renderAs(<EmployeeListPage />, siteManager());
    expect(await screen.findByText(/no employees match this search/i)).toBeInTheDocument();
  });

  it('never renders a privileged identity as an employee - the backend excludes them', async () => {
    const { calls } = stubFetch({ 'GET /api/v1/admin/employees': listResponse([EMPLOYEE]) });
    renderAs(<EmployeeListPage />, ceo());

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // The screen renders exactly what the endpoint returned; it never
    // merges in a separate privileged listing.
    expect(calls.every((call) => !call.url.includes('site-managers'))).toBe(true);
    expect(screen.queryByText('Sara Ahmed')).not.toBeInTheDocument();
  });
});

describe('searching and filtering', () => {
  it('sends the search term to the server', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET /api/v1/admin/employees': listResponse([EMPLOYEE]) });
    renderAs(<EmployeeListPage />, siteManager());
    await waitFor(() => expect(screen.getAllByText('Ali Khan').length).toBeGreaterThan(0));

    await user.type(screen.getByLabelText(/^name/i), 'Khan');
    await user.click(screen.getByRole('button', { name: /^search$/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('search=Khan'))).toBe(true));
  });

  it('sends the company and state filters to the server', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET /api/v1/admin/employees': listResponse([EMPLOYEE]) });
    renderAs(<EmployeeListPage />, siteManager());
    await waitFor(() => expect(screen.getAllByText('Ali Khan').length).toBeGreaterThan(0));

    await user.selectOptions(screen.getByLabelText(/^company/i), 'E_SET');
    await waitFor(() => expect(calls.some((call) => call.url.includes('companyCode=E_SET'))).toBe(true));

    await user.selectOptions(screen.getByLabelText(/account status/i), 'DISABLED');
    await waitFor(() => expect(calls.some((call) => call.url.includes('state=DISABLED'))).toBe(true));
  });

  it('always sends a bounded page size', async () => {
    const { calls } = stubFetch({ 'GET /api/v1/admin/employees': listResponse([]) });
    renderAs(<EmployeeListPage />, siteManager());
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.url).toMatch(/pageSize=\d+/);
  });
});

describe('authorization', () => {
  it('tells an ordinary employee this is not theirs, and shows the server refusal', async () => {
    stubFetch({ 'GET /api/v1/admin/employees': { status: 403, body: { error: 'forbidden' } } });
    renderAs(<EmployeeListPage />, normalEmployee());

    expect(screen.getByText(/reserved to the ceo and system site managers/i)).toBeInTheDocument();
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
  });
});

describe('when account management is unavailable in this environment', () => {
  it('reports it without naming a credential or a host', async () => {
    stubFetch({
      'GET /api/v1/admin/employees': {
        status: 503,
        body: { error: 'account_management_unavailable', message: 'Account management is not available right now' },
      },
    });
    renderAs(<EmployeeListPage />, siteManager());

    const message = await screen.findByText(/not available in this environment/i);
    expect(message.textContent).not.toMatch(/SERVICE_ROLE|DATABASE_URL|supabase|postgres/i);
  });
});
