import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PERMIT_TYPES } from '../../api/types';
import { ceo, croEmployee, normalEmployee, siteManager, zplSiteManagerEmployee } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { ApplyPermitPage } from './ApplyPermitPage';

/**
 * Starting a permit.
 *
 * The two rules with teeth: exactly four permit types exist and the
 * backend's own enum value is what gets sent, and the applicant identity
 * is READ-ONLY - there is no control anywhere on this page that could
 * change who the permit will be recorded against.
 */

describe('permit types', () => {
  it('offers exactly the four the backend supports, and no fifth', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, normalEmployee());

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(4);
    expect(radios.map((radio) => (radio as HTMLInputElement).value).sort()).toEqual([...PERMIT_TYPES].sort());
  });

  it('shows friendly labels for each', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, normalEmployee());
    for (const label of [
      'WTG Work Permit',
      'Cold Work Permit',
      'Hot Work Permit',
      'Confined Space Entry Permit',
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it.each(PERMIT_TYPES)('sends the exact backend enum value for %s', async (permitType) => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'POST /api/v1/permits': { status: 201, body: { permit: { id: 'permit-new' }, jsa: { id: 'jsa-new' } } },
    });
    renderAs(<ApplyPermitPage />, normalEmployee());

    await user.click(screen.getByRole('radio', { name: new RegExp(permitType.replaceAll('_', '.'), 'i') }));
    await user.click(screen.getByRole('button', { name: /create draft permit/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    // Exactly one field, and the enum value verbatim.
    expect(calls[0]?.body).toEqual({ permitType });
  });
});

describe('the applicant line', () => {
  it('is read-only for a normal employee, worded "Mr. NAME"', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, normalEmployee());

    expect(screen.getByText('Mr. Ali Khan')).toBeInTheDocument();
    expect(screen.queryByText(/of Company/i)).not.toBeInTheDocument();
    // No editable control for any part of the applicant identity.
    expect(screen.queryByLabelText(/applicant name/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/applicant company/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/company code/i)).not.toBeInTheDocument();
  });

  it('shows a privileged applicant by personal name ALONE', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, ceo());

    expect(screen.getByText('Farhan Aziz')).toBeInTheDocument();
    // Never a role title, a company, or a fabricated organizational line.
    expect(screen.queryByText(/Mr\. Farhan Aziz/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Farhan Aziz.*CEO/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Farhan Aziz.*E-SET/)).not.toBeInTheDocument();
  });

  it('shows a Site Manager the same way - name only', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, siteManager());
    expect(screen.getByText('Sara Ahmed')).toBeInTheDocument();
    expect(screen.queryByText(/Sara Ahmed.*Site Manager/)).not.toBeInTheDocument();
  });

  it('says explicitly that the system records it', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, normalEmployee());
    expect(screen.getByText(/cannot be changed here/i)).toBeInTheDocument();
  });

  it('never appears in the request body - the server derives it', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'POST /api/v1/permits': { status: 201, body: { permit: { id: 'permit-new' }, jsa: { id: 'jsa-new' } } },
    });
    renderAs(<ApplyPermitPage />, normalEmployee());

    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: /create draft permit/i }));

    await waitFor(() => expect(calls).toHaveLength(1));
    const body = calls[0]?.body as Record<string, unknown>;
    for (const forbidden of ['applicantName', 'applicant', 'displayName', 'company', 'companyCode', 'createdBy']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });
});

describe('who may apply', () => {
  it('lets an ordinary ZPL employee apply', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, normalEmployee());
    expect(screen.getByRole('button', { name: /create draft permit/i })).toBeInTheDocument();
  });

  it('lets ZPL’s "Site Manager" POSITION apply - it is an ordinary applicant', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, zplSiteManagerEmployee());
    expect(screen.getByText('Mr. Imran Sheikh')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create draft permit/i })).toBeInTheDocument();
  });

  it('lets privileged accounts apply', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, ceo());
    expect(screen.getByRole('button', { name: /create draft permit/i })).toBeInTheDocument();
  });

  it('tells E-SET E-BOP CRO that applying is not part of their role', () => {
    stubFetch({});
    renderAs(<ApplyPermitPage />, croEmployee());
    expect(screen.getByText(/not part of your role/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create draft permit/i })).not.toBeInTheDocument();
  });
});

describe('failure', () => {
  it('reports a refusal from the server without technical detail', async () => {
    const user = userEvent.setup();
    stubFetch({
      'POST /api/v1/permits': {
        status: 403,
        body: { error: 'forbidden', message: 'Permit application is not allowed for this identity' },
      },
    });
    renderAs(<ApplyPermitPage />, normalEmployee());

    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: /create draft permit/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/do not have permission/i);
  });

  it('reports rate limiting as a wait, not an error the person caused', async () => {
    const user = userEvent.setup();
    stubFetch({ 'POST /api/v1/permits': { status: 429, body: { error: 'rate_limited' } } });
    renderAs(<ApplyPermitPage />, normalEmployee());

    await user.click(screen.getAllByRole('radio')[0] as HTMLElement);
    await user.click(screen.getByRole('button', { name: /create draft permit/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many requests/i);
  });
});
