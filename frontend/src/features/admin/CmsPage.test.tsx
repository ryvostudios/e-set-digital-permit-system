import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveCapabilities } from '../../auth/capabilities';
import { buildNavigation } from '../../layout/navigation';
import { ceo, croEmployee, hseApprover, normalEmployee, siteManager } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { CmsPage } from './CmsPage';

const state = (assets: object[] = []) => ({
  revision: 4, organizationName: 'E-Set Engineering Services', signInNotice: '', webLogoAssetId: null,
  pwaIconAssetId: null, maxPdfLogos: 4, assets,
});
const pdfLogo = (index: number, active = false) => ({
  id: `5000000${index}-0000-4000-8000-000000000001`, label: `Company ${index}`, purpose: 'PDF_LOGO', active,
  displayOrder: active ? index : 0, documentTypes: active ? ['ISSUED_PERMIT'] : [], createdAt: '2026-09-25T00:00:00.000Z',
});

afterEach(() => vi.unstubAllGlobals());

const hasCmsLink = (user: ReturnType<typeof ceo>) =>
  buildNavigation(deriveCapabilities(user)).flatMap((group) => group.items).some((item) => item.label === 'CMS');

describe('Permit CMS access', () => {
  it('is offered to the CEO and an explicit delegate only - never by role', () => {
    expect(hasCmsLink(ceo())).toBe(true);
    expect(hasCmsLink(normalEmployee({ capabilities: ['permit.create', 'permit.cms.manage'] }))).toBe(true);
    expect(hasCmsLink(siteManager())).toBe(false);
    expect(hasCmsLink(croEmployee())).toBe(false);
    expect(hasCmsLink(hseApprover())).toBe(false);
    expect(hasCmsLink(normalEmployee())).toBe(false);
  });

  it('refuses to render for someone without CMS authority, without calling the API', () => {
    const { fetchMock } = stubFetch({});
    renderAs(<CmsPage />, siteManager());
    expect(screen.getByText(/do not have access to the CMS/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a delegate manages branding but never sees the Dropbox integration', async () => {
    stubFetch({ 'GET /api/v1/cms/state': { body: state() } });
    renderAs(<CmsPage />, normalEmployee({ capabilities: ['permit.cms.manage'] }));
    const tabs = await screen.findByRole('tablist', { name: 'CMS sections' });
    expect(within(tabs).queryByRole('tab', { name: 'Integrations' })).toBeNull();
    expect(within(tabs).getByRole('tab', { name: 'PDF branding' })).toBeInTheDocument();
  });
});

describe('PDF logo set', () => {
  it('allows at most four printed logos and saves them in the chosen order', async () => {
    const assets = [1, 2, 3, 4, 5].map((index) => pdfLogo(index));
    const { calls } = stubFetch({
      'GET /api/v1/cms/state': { body: state(assets) },
      'GET /api/v1/cms/assets/50000001-0000-4000-8000-000000000001/image': { status: 404, body: {} },
      'GET /api/v1/cms/assets/50000002-0000-4000-8000-000000000001/image': { status: 404, body: {} },
      'GET /api/v1/cms/assets/50000003-0000-4000-8000-000000000001/image': { status: 404, body: {} },
      'GET /api/v1/cms/assets/50000004-0000-4000-8000-000000000001/image': { status: 404, body: {} },
      'GET /api/v1/cms/assets/50000005-0000-4000-8000-000000000001/image': { status: 404, body: {} },
      'PUT /api/v1/cms/pdf-logos': { body: { revision: 5 } },
    });
    const user = userEvent.setup();
    renderAs(<CmsPage />, ceo());
    await user.click(await screen.findByRole('tab', { name: 'PDF branding' }));
    for (const index of [3, 1, 2, 4]) await user.click(screen.getByRole('checkbox', { name: `Company ${index}` }));
    expect(screen.getByRole('checkbox', { name: 'Company 5' })).toBeDisabled();
    const order = screen.getByRole('list', { name: 'Printed logo order' });
    await user.click(within(order).getAllByRole('button', { name: 'Move right' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Save printed logos' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    const put = calls.find((call) => call.method === 'PUT')!;
    expect((put.body as { logos: { assetId: string }[] }).logos.map((logo) => logo.assetId)).toEqual(
      [1, 3, 2, 4].map((index) => `5000000${index}-0000-4000-8000-000000000001`),
    );
    expect(put.body).toMatchObject({ revision: 4 });
  });
});

describe('Dropbox integration (CEO)', () => {
  it('shows dependent files and blocks disconnecting a connection that files depend on', async () => {
    stubFetch({
      'GET /api/v1/cms/state': { body: state() },
      'GET /api/v1/cms/dropbox/status': {
        body: {
          setupComplete: true, selectionRevision: 2, activeConnectionId: null,
          connections: [{ id: '60000000-0000-4000-8000-000000000001', status: 'connected', accountLabel: 'files@example.test', revision: 3, dependentFiles: 12, healthVerified: true }],
        },
      },
    });
    const user = userEvent.setup();
    renderAs(<CmsPage />, ceo());
    await user.click(await screen.findByRole('tab', { name: 'Integrations' }));
    expect(await screen.findByText('12 file(s)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled();
  });

  it('never navigates anywhere except Dropbox for authorization', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    stubFetch({
      'GET /api/v1/cms/state': { body: state() },
      'GET /api/v1/cms/dropbox/status': { body: { setupComplete: true, selectionRevision: 1, activeConnectionId: null, connections: [] } },
      'POST /api/v1/cms/dropbox/connect': { body: { authorizationUrl: 'https://evil.example/oauth2/authorize?state=x' } },
    });
    const user = userEvent.setup();
    renderAs(<CmsPage />, ceo());
    await user.click(await screen.findByRole('tab', { name: 'Integrations' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Dropbox' }));
    expect(await screen.findByText('Unexpected authorization address')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('CMS uploads (A03 retry identity)', () => {
  it('a retry of the same file and label reuses its request id; a changed label starts a new request', async () => {
    const requestIds: string[] = [];
    stubFetch({
      'GET /api/v1/cms/state': { body: state() },
      'POST /api/v1/cms/assets': (url) => {
        requestIds.push(url.searchParams.get('requestId') ?? '');
        return requestIds.length === 1
          ? { status: 503, body: { error: 'storage_unavailable', message: 'Permit storage is not available.' } }
          : { body: { id: '50000009-0000-4000-8000-000000000001' } };
      },
    });
    const user = userEvent.setup();
    renderAs(<CmsPage />, ceo());
    await user.click(await screen.findByRole('tab', { name: 'PDF branding' }));
    const form = screen.getByRole('form', { name: 'Upload PDF_LOGO' });
    await user.type(within(form).getByLabelText('Label'), 'Logo');
    await user.upload(within(form).getByLabelText(/Image \(PNG or JPEG/), new File(['png'], 'logo.png', { type: 'image/png' }));
    await user.click(within(form).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(requestIds).toHaveLength(1));
    await user.click(within(form).getByRole('button', { name: 'Upload' }));   // retry after the failure
    await waitFor(() => expect(requestIds).toHaveLength(2));
    expect(requestIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIds[1]).toBe(requestIds[0]);
  });

  it('changing the label makes it a new upload with a new request id', async () => {
    const requestIds: string[] = [];
    stubFetch({
      'GET /api/v1/cms/state': { body: state() },
      'POST /api/v1/cms/assets': (url) => {
        requestIds.push(url.searchParams.get('requestId') ?? '');
        return { status: 503, body: { error: 'storage_unavailable', message: 'Permit storage is not available.' } };
      },
    });
    const user = userEvent.setup();
    renderAs(<CmsPage />, ceo());
    await user.click(await screen.findByRole('tab', { name: 'PDF branding' }));
    const form = screen.getByRole('form', { name: 'Upload PDF_LOGO' });
    await user.type(within(form).getByLabelText('Label'), 'Logo');
    await user.upload(within(form).getByLabelText(/Image \(PNG or JPEG/), new File(['png'], 'logo.png', { type: 'image/png' }));
    await user.click(within(form).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(requestIds).toHaveLength(1));
    await user.type(within(form).getByLabelText('Label'), ' 2');
    await user.click(within(form).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(requestIds).toHaveLength(2));
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });
});
