import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ceo, normalEmployee, siteManager } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { SiteManagersPage } from './SiteManagersPage';

/**
 * Site Manager administration.
 *
 * Three rules with teeth: it is CEO-ONLY (a Site Manager cannot appoint
 * or unmake another), a privileged account has NO organizational fields,
 * and when the privileged channel is not configured the screen says so
 * professionally without naming a credential.
 */

const TEMP_PASSWORD = 'a-temporary-password';

const SITE_MANAGER_ROW = {
  userId: 'sm-1',
  displayName: 'Sara Ahmed',
  active: true,
  accountState: 'ACTIVE' as const,
};

describe('who may open this screen', () => {
  it('refuses an ordinary employee', () => {
    stubFetch({});
    renderAs(<SiteManagersPage />, normalEmployee());
    expect(screen.getByText(/reserved to the ceo/i)).toBeInTheDocument();
  });

  it('refuses a Site Manager - they cannot appoint or remove another', () => {
    const { calls } = stubFetch({});
    renderAs(<SiteManagersPage />, siteManager());

    expect(screen.getByText(/cannot appoint or remove another site manager/i)).toBeInTheDocument();
    // The listing is not even requested.
    expect(calls).toHaveLength(0);
  });

  it('allows the CEO', async () => {
    stubFetch({ 'GET /api/v1/admin/site-managers': { body: { siteManagers: [SITE_MANAGER_ROW] } } });
    renderAs(<SiteManagersPage />, ceo());
    expect(await screen.findByText('Sara Ahmed')).toBeInTheDocument();
  });
});

describe('creating a Site Manager', () => {
  it('asks only for a personal name, a login email, and a temporary password', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET /api/v1/admin/site-managers': { body: { siteManagers: [] } } });
    renderAs(<SiteManagersPage />, ceo());

    await user.click(screen.getByRole('button', { name: /add site manager/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText(/personal name/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/login email/i)).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/temporary password/i)).toBeInTheDocument();

    // A privileged account has NO organizational membership, and none is
    // offered here.
    expect(within(dialog).queryByLabelText(/company/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/team/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/position/i)).not.toBeInTheDocument();
  });

  it('sends exactly those three fields, and no role', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET /api/v1/admin/site-managers': { body: { siteManagers: [] } },
      'POST /api/v1/admin/site-managers': {
        status: 201,
        body: { siteManager: { userId: 'sm-new', mustChangePassword: true } },
      },
    });
    renderAs(<SiteManagersPage />, ceo());

    await user.click(screen.getByRole('button', { name: /add site manager/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/personal name/i), 'Bilal Raza');
    await user.type(within(dialog).getByLabelText(/login email/i), 'bilal@eset.example.com');
    await user.type(within(dialog).getByLabelText(/temporary password/i), TEMP_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: /create site manager/i }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['displayName', 'email', 'temporaryPassword']);
    for (const forbidden of ['role', 'companyCode', 'teamPositionId', 'privilegedRoles']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('clears the temporary password after the request, in success and failure alike', async () => {
    const user = userEvent.setup();
    stubFetch({
      'GET /api/v1/admin/site-managers': { body: { siteManagers: [] } },
      'POST /api/v1/admin/site-managers': {
        status: 409,
        body: { error: 'conflict', reason: 'email_already_registered', message: 'That email cannot be used' },
      },
    });
    renderAs(<SiteManagersPage />, ceo());

    await user.click(screen.getByRole('button', { name: /add site manager/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/personal name/i), 'Bilal Raza');
    await user.type(within(dialog).getByLabelText(/login email/i), 'bilal@eset.example.com');
    await user.type(within(dialog).getByLabelText(/temporary password/i), TEMP_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: /create site manager/i }));

    await screen.findByRole('alert');
    expect(within(dialog).getByLabelText(/temporary password/i)).toHaveValue('');
    expect(document.body.textContent).not.toContain(TEMP_PASSWORD);
  });

  it('refuses a temporary password below the backend minimum before sending', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET /api/v1/admin/site-managers': { body: { siteManagers: [] } } });
    renderAs(<SiteManagersPage />, ceo());

    await user.click(screen.getByRole('button', { name: /add site manager/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/personal name/i), 'Bilal Raza');
    await user.type(within(dialog).getByLabelText(/login email/i), 'bilal@eset.example.com');
    await user.type(within(dialog).getByLabelText(/temporary password/i), 'short');
    await user.click(within(dialog).getByRole('button', { name: /create site manager/i }));

    expect(await within(dialog).findByText(/use at least 12 characters/i)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

describe('granting and revoking', () => {
  it('revokes behind a confirmation, with an empty body - the role is fixed by the endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET /api/v1/admin/site-managers': { body: { siteManagers: [SITE_MANAGER_ROW] } },
      'POST /api/v1/admin/site-managers/sm-1/revoke': {
        body: { status: 'ok', siteManager: { userId: 'sm-1', active: false } },
      },
    });
    renderAs(<SiteManagersPage />, ceo());

    await user.click(await screen.findByRole('button', { name: /revoke authority/i }));
    const dialog = await screen.findByRole('dialog');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: /revoke authority/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('/revoke'))).toBe(true));
    expect(calls.find((call) => call.url.includes('/revoke'))?.body).toEqual({});
  });

  it('restores authority through the grant endpoint', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET /api/v1/admin/site-managers': { body: { siteManagers: [{ ...SITE_MANAGER_ROW, active: false }] } },
      'POST /api/v1/admin/site-managers/sm-1/grant': {
        body: { status: 'ok', siteManager: { userId: 'sm-1', active: true } },
      },
    });
    renderAs(<SiteManagersPage />, ceo());

    await user.click(await screen.findByRole('button', { name: /restore authority/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /restore authority/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('/grant'))).toBe(true));
  });

  it('says that past actions remain recorded against their name', async () => {
    const user = userEvent.setup();
    stubFetch({ 'GET /api/v1/admin/site-managers': { body: { siteManagers: [SITE_MANAGER_ROW] } } });
    renderAs(<SiteManagersPage />, ceo());

    await user.click(await screen.findByRole('button', { name: /revoke authority/i }));
    expect(await screen.findByText(/remains recorded against their name/i)).toBeInTheDocument();
  });
});

describe('what a privileged account is shown as', () => {
  it('carries no Company, Team, or Position anywhere on the screen', async () => {
    stubFetch({ 'GET /api/v1/admin/site-managers': { body: { siteManagers: [SITE_MANAGER_ROW] } } });
    renderAs(<SiteManagersPage />, ceo());

    await screen.findByText('Sara Ahmed');
    expect(screen.getAllByText(/no company, team, or position/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/E-BOP|Engineer|Paramedic/)).not.toBeInTheDocument();
  });
});

describe('when the privileged channel is not configured', () => {
  it('shows a professional fail-closed message', async () => {
    stubFetch({
      'GET /api/v1/admin/site-managers': {
        status: 503,
        body: {
          error: 'privileged_management_unavailable',
          message: 'Privileged account administration is not available right now',
        },
      },
    });
    renderAs(<SiteManagersPage />, ceo());

    expect(await screen.findByText(/not available in this environment/i)).toBeInTheDocument();
    expect(screen.getByText(/employee administration and the permit workflow are unaffected/i)).toBeInTheDocument();
  });

  it('names no credential, variable, database, or host', async () => {
    stubFetch({
      'GET /api/v1/admin/site-managers': {
        status: 503,
        body: { error: 'privileged_management_unavailable' },
      },
    });
    renderAs(<SiteManagersPage />, ceo());

    await screen.findByText(/not available in this environment/i);
    const text = document.body.textContent ?? '';
    for (const forbidden of [
      'PRIVILEGED_DATABASE_URL',
      'DATABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'privileged_runtime',
      'postgres',
      'password',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('does not also show a raw error panel on top of the explanation', async () => {
    stubFetch({
      'GET /api/v1/admin/site-managers': {
        status: 503,
        body: { error: 'privileged_management_unavailable' },
      },
    });
    renderAs(<SiteManagersPage />, ceo());

    await screen.findByText(/not available in this environment/i);
    expect(screen.queryByText(/could not load this/i)).not.toBeInTheDocument();
  });
});
