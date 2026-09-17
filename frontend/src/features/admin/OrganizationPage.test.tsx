import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { buildNavigation } from '../../layout/navigation';
import { deriveCapabilities } from '../../auth/capabilities';
import { ceo, normalEmployee, siteManager, zplSiteManagerEmployee } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { OrganizationPage } from './OrganizationPage';

/**
 * Organization Management.
 *
 * The guarantees that matter here are not layout but authority and
 * request shape: who may open this at all, that a Position NAMED like a
 * privileged role grants nothing, that no capability or authority flag
 * can leave the browser, that retiring is a PATCH and never a DELETE,
 * and that a server refusal is shown as a sentence rather than as
 * database text.
 */

const STRUCTURE = '/api/v1/admin/organization/structure';

const TREE = {
  companies: [
    {
      id: 'c-eset',
      code: 'E_SET',
      name: 'E-SET',
      deactivatedAt: null,
      teams: [
        {
          id: 't-ebop',
          companyId: 'c-eset',
          name: 'E-BOP',
          deactivatedAt: null,
          positions: [
            {
              teamPositionId: 'tp-cro',
              teamId: 't-ebop',
              positionId: 'p-cro',
              positionName: 'CRO',
              deactivatedAt: null,
              siteManagerAssignable: true,
            },
          ],
        },
        {
          id: 't-retired',
          companyId: 'c-eset',
          name: 'Legacy Team',
          deactivatedAt: '2026-01-02T00:00:00.000Z',
          positions: [],
        },
      ],
    },
    {
      id: 'c-abc',
      code: 'ABC_CONTRACTORS',
      name: 'ABC Contractors',
      deactivatedAt: '2026-01-01T00:00:00.000Z',
      teams: [],
    },
  ],
};

const structureOnly = () => stubFetch({ [`GET ${STRUCTURE}`]: { body: TREE } });

describe('who may open this screen', () => {
  it('refuses an ordinary employee, and does not even request the structure', () => {
    const { calls } = stubFetch({});
    renderAs(<OrganizationPage />, normalEmployee());

    expect(screen.getByText(/reserved to the ceo and system site managers/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('refuses an employee whose POSITION is named "Site Manager"', () => {
    // The ZPL job-title collision. Authority comes from privilegedRoles,
    // which this employee does not hold - the name changes nothing.
    const { calls } = stubFetch({});
    renderAs(<OrganizationPage />, zplSiteManagerEmployee());

    expect(screen.getByText(/reserved to the ceo and system site managers/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('allows the CEO', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());
    expect(await screen.findByText('E-SET')).toBeInTheDocument();
  });

  it('allows an authorized System Site Manager', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, siteManager());
    expect(await screen.findByText('E-SET')).toBeInTheDocument();
  });
});

describe('navigation', () => {
  it('is offered to both privileged roles and to nobody else', () => {
    const labels = (user: Parameters<typeof deriveCapabilities>[0]): string[] =>
      buildNavigation(deriveCapabilities(user))
        .flatMap((group) => group.items)
        .map((item) => item.label);

    expect(labels(ceo())).toContain('Organization');
    expect(labels(siteManager())).toContain('Organization');
    expect(labels(normalEmployee())).not.toContain('Organization');
    // And the ZPL "Site Manager" POSITION is an ordinary employee here.
    expect(labels(zplSiteManagerEmployee())).not.toContain('Organization');
  });
});

describe('the hierarchy', () => {
  it('renders company, team and position, with the generated code', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());

    expect(await screen.findByText('E-SET')).toBeInTheDocument();
    expect(screen.getByText('E_SET')).toBeInTheDocument();
    expect(screen.getByText('E-BOP')).toBeInTheDocument();
    expect(screen.getByText('CRO')).toBeInTheDocument();
  });

  it('omits retired companies and teams from the current organization tree', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());

    expect(await screen.findByText('E-SET')).toBeInTheDocument();
    expect(screen.queryByText('ABC Contractors')).not.toBeInTheDocument();
    expect(screen.queryByText('Legacy Team')).not.toBeInTheDocument();
    expect(screen.queryByText('Inactive')).not.toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1);
  });

  it('offers actions only for active structure', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('E-SET');
    expect(screen.getAllByRole('button', { name: /add team/i })).toHaveLength(1);
    expect(screen.queryByText('ABC Contractors')).not.toBeInTheDocument();
  });

  it('never offers a delete control anywhere', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('E-SET');
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('offers no rename or reactivation control, because no endpoint supports them', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('E-SET');
    expect(screen.queryByRole('button', { name: /rename/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reactivate|restore/i })).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no companies', async () => {
    stubFetch({ [`GET ${STRUCTURE}`]: { body: { companies: [] } } });
    renderAs(<OrganizationPage />, ceo());
    expect(await screen.findByText(/no companies yet/i)).toBeInTheDocument();
  });
});

describe('creating a company', () => {
  it('sends ONLY the name - never a code, id or privileged field', async () => {
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'POST /api/v1/admin/organization/companies': {
        status: 201,
        body: { company: { id: 'c-new', code: 'NORTH_WIND', name: 'North Wind' } },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add company/i }));
    await userEvent.type(screen.getByLabelText(/company name/i), 'North Wind');
    await userEvent.click(screen.getByRole('button', { name: /create company/i }));

    await waitFor(() => {
      const created = calls.find((call) => call.method === 'POST');
      expect(created?.body).toEqual({ name: 'North Wind' });
    });
  });

  it('refetches the hierarchy after success and reports the SERVER-generated code', async () => {
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'POST /api/v1/admin/organization/companies': {
        status: 201,
        body: { company: { id: 'c-new', code: 'NORTH_WIND_2', name: 'North Wind' } },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add company/i }));
    await userEvent.type(screen.getByLabelText(/company name/i), 'North Wind');
    await userEvent.click(screen.getByRole('button', { name: /create company/i }));

    // The code shown is the one the server answered with.
    expect(await screen.findByText(/NORTH_WIND_2/)).toBeInTheDocument();
    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'GET' && call.url.includes('structure'))).toHaveLength(2);
    });
  });

  it('shows a duplicate-name refusal as a sentence, not as database text', async () => {
    stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'POST /api/v1/admin/organization/companies': {
        status: 409,
        body: {
          error: 'conflict',
          reason: 'duplicate_name',
          message: 'A company with that name already exists',
        },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add company/i }));
    await userEvent.type(screen.getByLabelText(/company name/i), 'E-SET');
    await userEvent.click(screen.getByRole('button', { name: /create company/i }));

    expect(await screen.findByText(/that name is already in use/i)).toBeInTheDocument();
    expect(screen.queryByText(/constraint|duplicate key|23505|SELECT/i)).not.toBeInTheDocument();
  });
});

describe('creating a team', () => {
  it('targets the selected company by id', async () => {
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'POST /api/v1/admin/organization/companies/c-eset/teams': {
        status: 201,
        body: { team: { id: 't-new', name: 'Electrical', companyId: 'c-eset' } },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add team/i }));
    await userEvent.type(screen.getByLabelText(/team name/i), 'Electrical');
    await userEvent.click(screen.getByRole('button', { name: /create team/i }));

    await waitFor(() => {
      const created = calls.find((call) => call.method === 'POST');
      expect(created?.url).toBe('/api/v1/admin/organization/companies/c-eset/teams');
      expect(created?.body).toEqual({ name: 'Electrical' });
    });
  });

  it('shows an inactive-company refusal safely', async () => {
    stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'POST /api/v1/admin/organization/companies/c-eset/teams': {
        status: 409,
        body: { error: 'conflict', reason: 'company_inactive', message: 'inactive' },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add team/i }));
    await userEvent.type(screen.getByLabelText(/team name/i), 'Electrical');
    await userEvent.click(screen.getByRole('button', { name: /create team/i }));

    expect(await screen.findByText(/retired and cannot take new teams/i)).toBeInTheDocument();
  });
});

describe('adding a position', () => {
  const POSITION_URL = '/api/v1/admin/organization/companies/c-eset/teams/t-ebop/positions';

  /**
   * Opens the dialog and submits from INSIDE it. The team row keeps its
   * own same-named trigger on the page behind the modal, so every
   * dialog interaction is scoped the way a person experiences it.
   */
  async function addPosition(name: string): Promise<void> {
    await userEvent.click(await screen.findByRole('button', { name: /add position/i }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/position name/i), name);
    await userEvent.click(dialog.getByRole('button', { name: /^add position$/i }));
  }

  it('targets the selected company AND team, sending only the position name', async () => {
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      [`POST ${POSITION_URL}`]: {
        status: 201,
        body: {
          association: {
            teamPositionId: 'tp-new',
            positionId: 'p-sup',
            positionName: 'Supervisor',
            teamId: 't-ebop',
            baselineCapabilities: ['permit.create', 'permit.submit'],
          },
        },
      },
    });
    renderAs(<OrganizationPage />, ceo());
    await addPosition('Supervisor');

    await waitFor(() => {
      const created = calls.find((call) => call.method === 'POST');
      expect(created?.url).toBe(POSITION_URL);
      expect(created?.body).toEqual({ positionName: 'Supervisor' });
    });
  });

  it('sends NO capabilities and NO siteManagerAssignable, even for a privileged-sounding name', async () => {
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      [`POST ${POSITION_URL}`]: {
        status: 201,
        body: {
          association: {
            teamPositionId: 'tp-new',
            positionId: 'p-cro2',
            positionName: 'CRO',
            teamId: 't-ebop',
            baselineCapabilities: ['permit.create', 'permit.submit'],
          },
        },
      },
    });
    renderAs(<OrganizationPage />, ceo());
    await addPosition('CRO');

    await waitFor(() => {
      const created = calls.find((call) => call.method === 'POST');
      expect(created?.body).toEqual({ positionName: 'CRO' });
      const keys = Object.keys(created?.body as Record<string, unknown>);
      expect(keys).toEqual(['positionName']);
      for (const forbidden of ['capabilities', 'capability', 'capabilityIds', 'siteManagerAssignable', 'privileged', 'role']) {
        expect(keys).not.toContain(forbidden);
      }
    });
  });

  it('exposes no capability picker in the dialog', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add position/i }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.queryByLabelText(/capabilit/i)).not.toBeInTheDocument();
    expect(dialog.queryByLabelText(/assignable/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/permit\.cro_review|permit\.hse_review/)).not.toBeInTheDocument();
  });

  it('prevents a double submit while the request is pending', async () => {
    let inFlight = 0;
    let peak = 0;
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      [`POST ${POSITION_URL}`]: () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        inFlight -= 1;
        return {
          status: 201,
          body: {
            association: {
              teamPositionId: 'tp-new',
              positionId: 'p-sup',
              positionName: 'Supervisor',
              teamId: 't-ebop',
              baselineCapabilities: ['permit.create', 'permit.submit'],
            },
          },
        };
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add position/i }));
    const dialog = within(await screen.findByRole('dialog'));
    await userEvent.type(dialog.getByLabelText(/position name/i), 'Supervisor');
    const submit = dialog.getByRole('button', { name: /^add position$/i });
    // Two clicks in immediate succession.
    await userEvent.click(submit);
    await userEvent.click(submit);

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    });
    expect(peak).toBeLessThanOrEqual(1);
  });
});

describe('retiring a record', () => {
  it('requires confirmation before anything is sent', async () => {
    const { calls } = stubFetch({ [`GET ${STRUCTURE}`]: { body: TREE } });
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('E-SET');
    await userEvent.click(screen.getAllByRole('button', { name: /^retire$/i })[0]!);

    // The dialog is open and NOTHING has been sent yet.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('uses PATCH on the deactivate route, never DELETE', async () => {
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'PATCH /api/v1/admin/organization/team-positions/tp-cro/deactivate': { body: { status: 'ok' } },
    });
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('CRO');
    // The position row's own Retire button.
    const positionRow = screen.getByText('CRO').closest('li');
    await userEvent.click(within(positionRow as HTMLElement).getByRole('button', { name: /retire/i }));
    const confirm = within(await screen.findByRole('dialog'));
    await userEvent.click(confirm.getByRole('button', { name: /^retire$/i }));

    await waitFor(() => {
      const mutation = calls.find((call) => call.method !== 'GET');
      expect(mutation?.method).toBe('PATCH');
      expect(mutation?.url).toBe('/api/v1/admin/organization/team-positions/tp-cro/deactivate');
      expect(mutation?.body).toEqual({});
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('explains an active-employee refusal instead of leaking database detail', async () => {
    stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'PATCH /api/v1/admin/organization/team-positions/tp-cro/deactivate': {
        status: 409,
        body: { error: 'conflict', reason: 'active_employees', message: 'still has active employees' },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('CRO');
    const positionRow = screen.getByText('CRO').closest('li');
    await userEvent.click(within(positionRow as HTMLElement).getByRole('button', { name: /retire/i }));
    const confirm = within(await screen.findByRole('dialog'));
    await userEvent.click(confirm.getByRole('button', { name: /^retire$/i }));

    expect(await screen.findByText(/active employees are still assigned here/i)).toBeInTheDocument();
    expect(screen.queryByText(/23503|constraint|relation|SELECT/i)).not.toBeInTheDocument();
  });

  it('explains a required-coverage refusal', async () => {
    stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'PATCH /api/v1/admin/organization/team-positions/tp-cro/deactivate': {
        status: 409,
        body: { error: 'conflict', reason: 'capability_coverage', message: 'coverage' },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('CRO');
    const positionRow = screen.getByText('CRO').closest('li');
    await userEvent.click(within(positionRow as HTMLElement).getByRole('button', { name: /retire/i }));
    const confirm = within(await screen.findByRole('dialog'));
    await userEvent.click(confirm.getByRole('button', { name: /^retire$/i }));

    expect(
      await screen.findByText(/would leave required permit review coverage unstaffed/i),
    ).toBeInTheDocument();
  });

  it('offers retire controls only on active records', async () => {
    structureOnly();
    renderAs(<OrganizationPage />, ceo());

    await screen.findByText('E-SET');
    expect(screen.getAllByRole('button', { name: /^retire$/i })).toHaveLength(3);
    expect(screen.queryByText('Legacy Team')).not.toBeInTheDocument();
  });
});

describe('failing closed', () => {
  it('shows an error and no stale hierarchy when the server refuses with 403', async () => {
    stubFetch({
      [`GET ${STRUCTURE}`]: { status: 403, body: { error: 'forbidden', message: 'Insufficient authority' } },
    });
    renderAs(<OrganizationPage />, ceo());

    await waitFor(() => {
      expect(screen.queryByTestId('organization-tree')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('E-SET')).not.toBeInTheDocument();
  });

  it('does not retry a refused mutation on its own', async () => {
    const { calls } = stubFetch({
      [`GET ${STRUCTURE}`]: { body: TREE },
      'POST /api/v1/admin/organization/companies': {
        status: 403,
        body: { error: 'forbidden', message: 'Insufficient authority' },
      },
    });
    renderAs(<OrganizationPage />, ceo());

    await userEvent.click(await screen.findByRole('button', { name: /add company/i }));
    await userEvent.type(screen.getByLabelText(/company name/i), 'North Wind');
    await userEvent.click(screen.getByRole('button', { name: /create company/i }));

    await waitFor(() => {
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    });
    // Still exactly one after settling - no retry loop.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});
