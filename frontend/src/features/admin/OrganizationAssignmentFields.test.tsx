import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ceo } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { CreateEmployeePage } from './CreateEmployeePage';

/**
 * Company → Team → Position, exercised through the real employee
 * creation screen rather than the field component alone, so what is
 * proved is what an administrator actually sees and submits.
 *
 * The organization fixture mirrors the real seeded structure: E-SET has
 * several teams, ZPL and SGRE each have exactly one named after the
 * company.
 */

const ORG_ROUTE = 'GET /api/v1/admin/organization';

function renderCreatePage() {
  const stub = stubFetch({
    [ORG_ROUTE]: {
      body: {
        companies: [
          {
            code: 'E_SET',
            name: 'E-SET',
            teams: [
              {
                teamName: 'E-BOP',
                positions: [
                  { teamPositionId: 'tp-ebop-cro', positionName: 'CRO' },
                  { teamPositionId: 'tp-ebop-lead', positionName: 'Team Lead' },
                ],
              },
              {
                teamName: 'WTG',
                positions: [
                  { teamPositionId: 'tp-wtg-technician', positionName: 'Technician' },
                  { teamPositionId: 'tp-wtg-engineer', positionName: 'Engineer' },
                ],
              },
            ],
          },
          {
            code: 'ZPL',
            name: 'ZPL',
            teams: [
              {
                teamName: 'ZPL',
                positions: [
                  { teamPositionId: 'tp-zpl-site-manager', positionName: 'Site Manager' },
                  { teamPositionId: 'tp-zpl-engineer', positionName: 'Engineer' },
                ],
              },
            ],
          },
          {
            code: 'SGRE',
            name: 'SGRE',
            teams: [
              { teamName: 'SGRE', positions: [{ teamPositionId: 'tp-sgre-lead', positionName: 'Team Lead' }] },
            ],
          },
        ],
      },
    },
  });
  renderAs(<CreateEmployeePage />, ceo());
  return stub;
}

const company = () => screen.getByLabelText(/^company/i);
const team = () => screen.getByLabelText(/^team/i);
const position = () => screen.getByLabelText(/^position/i);

async function waitForForm(): Promise<void> {
  await waitFor(() => expect(screen.getByLabelText(/^company/i)).toBeInTheDocument());
}

describe('E-SET: Company, Team and Position are three separate questions', () => {
  it('asks for a Team once E-SET is chosen', async () => {
    const user = userEvent.setup();
    renderCreatePage();
    await waitForForm();

    // No team question until a company makes one meaningful.
    expect(screen.queryByLabelText(/^team/i)).not.toBeInTheDocument();

    await user.selectOptions(company(), 'E_SET');
    expect(team()).toBeInTheDocument();
    expect(within(team()).queryByRole('option', { name: 'E-BOP' })).toBeTruthy();
    expect(within(team()).queryByRole('option', { name: 'WTG' })).toBeTruthy();
  });

  it('filters Positions by the chosen Team', async () => {
    const user = userEvent.setup();
    renderCreatePage();
    await waitForForm();

    await user.selectOptions(company(), 'E_SET');
    await user.selectOptions(team(), 'E-BOP');
    expect(within(position()).queryByRole('option', { name: 'CRO' })).toBeTruthy();
    expect(within(position()).queryByRole('option', { name: 'Technician' })).toBeNull();

    await user.selectOptions(team(), 'WTG');
    expect(within(position()).queryByRole('option', { name: 'Technician' })).toBeTruthy();
    expect(within(position()).queryByRole('option', { name: 'CRO' })).toBeNull();
  });

  it('never shows a flattened organization label', async () => {
    const user = userEvent.setup();
    renderCreatePage();
    await waitForForm();

    await user.selectOptions(company(), 'E_SET');
    await user.selectOptions(team(), 'E-BOP');

    // The shapes this change exists to remove.
    for (const flattened of [/ESET-E_BOP-CRO/i, /ESET-WTG/i, /E-BOP\s*—\s*CRO/i, /E_SET-/i]) {
      expect(screen.queryByText(flattened)).not.toBeInTheDocument();
    }
    // A position option is the position, and nothing more.
    expect(within(position()).getByRole('option', { name: 'CRO' })).toBeInTheDocument();
  });
});

describe('changing a choice clears what it invalidates', () => {
  it('changing Company clears both Team and Position', async () => {
    const user = userEvent.setup();
    renderCreatePage();
    await waitForForm();

    await user.selectOptions(company(), 'E_SET');
    await user.selectOptions(team(), 'E-BOP');
    await user.selectOptions(position(), 'tp-ebop-cro');
    expect((position() as HTMLSelectElement).value).toBe('tp-ebop-cro');

    await user.selectOptions(company(), 'ZPL');
    // ZPL has one team, so the team question disappears entirely - and the
    // E-SET position cannot survive the move.
    expect(screen.queryByLabelText(/^team/i)).not.toBeInTheDocument();
    expect((position() as HTMLSelectElement).value).toBe('');
  });

  it('changing Team clears the Position that belonged to the old team', async () => {
    const user = userEvent.setup();
    renderCreatePage();
    await waitForForm();

    await user.selectOptions(company(), 'E_SET');
    await user.selectOptions(team(), 'E-BOP');
    await user.selectOptions(position(), 'tp-ebop-cro');

    await user.selectOptions(team(), 'WTG');
    expect((position() as HTMLSelectElement).value).toBe('');
  });
});

describe('single-team companies do not ask a question with one answer', () => {
  it('ZPL offers its positions directly, with no redundant Team choice', async () => {
    const user = userEvent.setup();
    renderCreatePage();
    await waitForForm();

    await user.selectOptions(company(), 'ZPL');
    expect(screen.queryByLabelText(/^team/i)).not.toBeInTheDocument();

    for (const role of ['Site Manager', 'Engineer']) {
      expect(within(position()).getByRole('option', { name: role })).toBeInTheDocument();
    }
    // Nothing from another company leaks in.
    expect(within(position()).queryByRole('option', { name: 'CRO' })).toBeNull();
    expect(within(position()).queryByRole('option', { name: 'Technician' })).toBeNull();
  });

  it('SGRE offers only its own single position', async () => {
    const user = userEvent.setup();
    renderCreatePage();
    await waitForForm();

    await user.selectOptions(company(), 'SGRE');
    expect(screen.queryByLabelText(/^team/i)).not.toBeInTheDocument();

    const options = within(position())
      .getAllByRole('option')
      .map((option) => option.textContent)
      .filter((label) => label !== 'Choose a position');
    expect(options).toEqual(['Team Lead']);
  });
});

describe('what is actually submitted', () => {
  it('sends the normalized teamPositionId, never a team or position name', async () => {
    const user = userEvent.setup();
    const stub = renderCreatePage();
    await waitForForm();

    await user.type(screen.getByLabelText(/display name/i), 'Ayesha Khan');
    await user.type(screen.getByLabelText(/^email/i), 'ayesha@example.com');
    await user.type(screen.getByLabelText(/temporary password/i), 'a-temporary-password');
    await user.selectOptions(company(), 'E_SET');
    await user.selectOptions(team(), 'WTG');
    await user.selectOptions(position(), 'tp-wtg-engineer');
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    await waitFor(() => {
      const created = stub.calls.find((call) => call.url.includes('/admin/employees') && call.method === 'POST');
      expect(created).toBeTruthy();
      const body = created!.body as Record<string, unknown>;
      expect(body.companyCode).toBe('E_SET');
      expect(body.teamPositionId).toBe('tp-wtg-engineer');
      // The team is a narrowing aid for the person, not part of the
      // contract - the backend resolves the team from the assignment.
      expect(body).not.toHaveProperty('teamName');
      expect(body).not.toHaveProperty('positionName');
    });
  });

  it('a ZPL Site Manager is an ordinary workforce position, not the privileged role', async () => {
    const user = userEvent.setup();
    const stub = renderCreatePage();
    await waitForForm();

    await user.type(screen.getByLabelText(/display name/i), 'Bilal Ahmed');
    await user.type(screen.getByLabelText(/^email/i), 'bilal@zpl.example.com');
    await user.type(screen.getByLabelText(/temporary password/i), 'a-temporary-password');
    await user.selectOptions(company(), 'ZPL');
    await user.selectOptions(position(), 'tp-zpl-site-manager');
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    await waitFor(() => {
      const created = stub.calls.find((call) => call.url.includes('/admin/employees') && call.method === 'POST');
      expect(created).toBeTruthy();
      const body = created!.body as Record<string, unknown>;
      // A normalized workforce assignment and nothing else. Privileged
      // roles live in the append-only grant log and are not reachable
      // from employee administration at all.
      expect(body.teamPositionId).toBe('tp-zpl-site-manager');
      expect(body).not.toHaveProperty('privilegedRole');
      expect(body).not.toHaveProperty('role');
      expect(JSON.stringify(body)).not.toMatch(/SITE_MANAGER/);
    });

    // The screen never offers privileged appointment either.
    expect(screen.queryByText(/system site manager/i)).not.toBeInTheDocument();
  });
});
