import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ORGANIZATION, ceo, normalEmployee, siteManager } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { CreateEmployeePage } from './CreateEmployeePage';

/**
 * Provisioning a normal employee.
 *
 * The properties with real consequences: the Company/Team/Position
 * choices come from the SERVER (never a hard-coded map), the request
 * body carries only genuine provisioning fields, and the temporary
 * password is cleared from component state the moment the request
 * completes - in success and in failure alike.
 */

const TEMP_PASSWORD = 'a-temporary-password';

function stubCreate(extra: Record<string, unknown> = {}) {
  return stubFetch({
    'GET /api/v1/admin/organization': { body: ORGANIZATION },
    'POST /api/v1/admin/employees': {
      status: 201,
      body: { employee: { userId: 'employee-new', mustChangePassword: true } },
    },
    ...extra,
  } as never);
}

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText(/display name/i), 'Ayesha Khan');
  await user.type(screen.getByLabelText(/^email/i), 'ayesha@example.com');
  await user.type(screen.getByLabelText(/temporary password/i), TEMP_PASSWORD);
  await user.selectOptions(screen.getByLabelText(/^company/i), 'ZPL');
  await user.selectOptions(screen.getByLabelText(/^position/i), 'tp-zpl-engineer');
}

describe('authorization', () => {
  it('refuses an ordinary employee who reaches the URL directly', () => {
    stubFetch({});
    renderAs(<CreateEmployeePage />, normalEmployee());
    expect(screen.getByText(/reserved to the ceo and system site managers/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/display name/i)).not.toBeInTheDocument();
  });

  it('is available to a Site Manager', async () => {
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());
    expect(await screen.findByLabelText(/display name/i)).toBeInTheDocument();
  });

  it('is available to the CEO', async () => {
    stubCreate();
    renderAs(<CreateEmployeePage />, ceo());
    expect(await screen.findByLabelText(/display name/i)).toBeInTheDocument();
  });
});

describe('the organization choices', () => {
  it('come from the server, not from a hard-coded frontend map', async () => {
    const { calls } = stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    expect(calls.some((call) => call.url === '/api/v1/admin/organization')).toBe(true);
  });

  it('offer exactly the three provisioning companies', async () => {
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    const companySelect = await screen.findByLabelText(/^company/i);
    const options = Array.from(companySelect.querySelectorAll('option')).map((option) => option.value);
    expect(options).toEqual(['', 'E_SET', 'ZPL', 'SGRE']);
  });

  it('scope the Team + Position list to the chosen company', async () => {
    const user = userEvent.setup();
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await user.selectOptions(await screen.findByLabelText(/^company/i), 'ZPL');
    // ZPL has a single team, so it is resolved internally and only
    // positions are offered - named as positions, not as flattened
    // "ZPL — Engineer" combinations.
    expect(screen.queryByLabelText(/^team/i)).not.toBeInTheDocument();
    const assignments = screen.getByLabelText(/^position/i);
    const labels = Array.from(assignments.querySelectorAll('option')).map((option) => option.textContent);
    expect(labels).toContain('Engineer');
    expect(labels).toContain('Site Manager');
    // E-SET's positions are not offered under ZPL.
    expect(labels).not.toContain('CRO');
  });

  it('clear the assignment when the company changes, because an assignment belongs to its company', async () => {
    const user = userEvent.setup();
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await user.selectOptions(await screen.findByLabelText(/^company/i), 'ZPL');
    await user.selectOptions(screen.getByLabelText(/^position/i), 'tp-zpl-engineer');
    expect(screen.getByLabelText(/^position/i)).toHaveValue('tp-zpl-engineer');

    await user.selectOptions(screen.getByLabelText(/^company/i), 'E_SET');
    expect(screen.getByLabelText(/^position/i)).toHaveValue('');
  });

  it('cannot be typed freely - the assignment is a closed list', async () => {
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());
    const assignments = await screen.findByLabelText(/^position/i);
    expect(assignments.tagName).toBe('SELECT');
  });
});

describe('the request', () => {
  it('carries exactly the five provisioning fields, and nothing else', async () => {
    const user = userEvent.setup();
    const { calls } = stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'companyCode',
      'displayName',
      'email',
      'teamPositionId',
      'temporaryPassword',
    ]);
    expect(body).toMatchObject({ companyCode: 'ZPL', teamPositionId: 'tp-zpl-engineer' });
  });

  it('never carries a role, a capability list, an account state, or a user id', async () => {
    const user = userEvent.setup();
    const { calls } = stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    for (const forbidden of ['role', 'roles', 'capabilities', 'privileged', 'state', 'userId', 'mustChangePassword']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe('the temporary password', () => {
  it('is a password field with a deliberate reveal', async () => {
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());
    expect(await screen.findByLabelText(/temporary password/i)).toHaveAttribute('type', 'password');
    expect(screen.getByRole('button', { name: /show password/i })).toBeInTheDocument();
  });

  it('is refused below the backend minimum, before anything is sent', async () => {
    const user = userEvent.setup();
    const { calls } = stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await user.type(screen.getByLabelText(/display name/i), 'Ayesha Khan');
    await user.type(screen.getByLabelText(/^email/i), 'ayesha@example.com');
    await user.type(screen.getByLabelText(/temporary password/i), 'short');
    await user.selectOptions(screen.getByLabelText(/^company/i), 'ZPL');
    await user.selectOptions(screen.getByLabelText(/^position/i), 'tp-zpl-engineer');
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    expect(await screen.findByText(/use at least 12 characters/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('is cleared from the form after a SUCCESSFUL request', async () => {
    const user = userEvent.setup();
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    await screen.findByText(/has been added/i);
    expect(screen.getByLabelText(/temporary password/i)).toHaveValue('');
  });

  it('is cleared from the form after a FAILED request too', async () => {
    const user = userEvent.setup();
    stubCreate({
      'POST /api/v1/admin/employees': {
        status: 409,
        body: { error: 'conflict', reason: 'email_already_registered', message: 'That email cannot be used' },
      },
    });
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    await screen.findByRole('alert');
    expect(screen.getByLabelText(/temporary password/i)).toHaveValue('');
  });

  it('is never echoed back on screen after submission', async () => {
    const user = userEvent.setup();
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    await screen.findByText(/has been added/i);
    expect(document.body.textContent).not.toContain(TEMP_PASSWORD);
  });
});

describe('after a successful creation', () => {
  it('says the employee must change the temporary password at first sign-in', async () => {
    const user = userEvent.setup();
    stubCreate();
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    expect(await screen.findByText(/must change the temporary password the first time they sign in/i)).toBeInTheDocument();
  });
});

describe('when account management is unavailable in this environment', () => {
  it('says so without naming any credential or variable', async () => {
    const user = userEvent.setup();
    stubCreate({
      'POST /api/v1/admin/employees': {
        status: 503,
        body: { error: 'account_management_unavailable', message: 'Account management is not available right now' },
      },
    });
    renderAs(<CreateEmployeePage />, siteManager());

    await screen.findByLabelText(/display name/i);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: /create employee account/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not available in this environment/i);
    expect(alert.textContent).not.toMatch(/SERVICE_ROLE|DATABASE_URL|supabase|credential/i);
  });
});
