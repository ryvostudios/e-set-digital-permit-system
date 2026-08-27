import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { invalidateAll } from '../../lib/cache';
import { ceo, emptyPagination, normalEmployee, permitSummary } from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { RecordsPage } from './RecordsPage';

/**
 * Permit records.
 *
 * SEARCH NEVER WIDENS ACCESS: the screen sends filters, and the backend
 * decides what is inside them. What is pinned here is that filtering and
 * paging really are server-side, that nothing is cached across a
 * permission change, and that a narrowed result after a revocation is
 * shown as-is rather than topped up from a stale list.
 */

function searchResponse(permits: unknown[], pagination = {}) {
  return { body: { permits, pagination: emptyPagination({ totalCount: permits.length, totalPages: 1, ...pagination }) } };
}

/**
 * Permit Records never shows a DRAFT, so its fixtures are formal records.
 * The shared `permitSummary` factory still defaults to DRAFT, which is
 * right for My Drafts and wrong here.
 */
const record = (overrides: Parameters<typeof permitSummary>[0] = {}) =>
  permitSummary({ status: 'ISSUED', ...overrides });

describe('the list', () => {
  it('is worded "My permits" for an ordinary employee', async () => {
    stubFetch({ 'GET /api/v1/permits/search': searchResponse([]) });
    renderAs(<RecordsPage />, normalEmployee());
    expect(await screen.findByRole('heading', { level: 1, name: /my permits/i })).toBeInTheDocument();
  });

  it('is worded "Permit records" for someone the backend grants broad visibility', async () => {
    stubFetch({ 'GET /api/v1/permits/search': searchResponse([]) });
    renderAs(<RecordsPage />, normalEmployee({ capabilities: ['permit.create', 'permit.view_all'] }));
    expect(await screen.findByRole('heading', { level: 1, name: /permit records/i })).toBeInTheDocument();
  });

  it('shows the fields the API actually returns', async () => {
    stubFetch({ 'GET /api/v1/permits/search': searchResponse([record()]) });
    renderAs(<RecordsPage />, normalEmployee());

    await screen.findAllByText('000001');
    expect(screen.getAllByText(/WTG Work Permit/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/North Farm · WTG-14/).length).toBeGreaterThan(0);
  });

  it('never renders a DRAFT row even if a stale backend fixture contains one', async () => {
    stubFetch({
      'GET /api/v1/permits/search': searchResponse([
        permitSummary({ id: 'draft', status: 'DRAFT', permitDisplayNumber: '000013' }),
        permitSummary({ id: 'record', status: 'ISSUED', permitDisplayNumber: '000014' }),
      ]),
    });
    renderAs(<RecordsPage />, normalEmployee());
    expect(await screen.findAllByText('000014')).not.toHaveLength(0);
    expect(screen.queryByText('000013')).not.toBeInTheDocument();
  });

  it('does not offer DRAFT as a Permit Records status filter', async () => {
    stubFetch({ 'GET /api/v1/permits/search': searchResponse([]) });
    renderAs(<RecordsPage />, normalEmployee());
    const status = await screen.findByLabelText(/^status/i);
    expect(status).not.toHaveTextContent('Draft');
  });

  it('shows an empty state rather than a blank panel', async () => {
    stubFetch({ 'GET /api/v1/permits/search': searchResponse([]) });
    renderAs(<RecordsPage />, normalEmployee());
    expect(await screen.findByText(/no permits match these filters/i)).toBeInTheDocument();
  });

  it('shows an error state with a retry when the load fails', async () => {
    stubFetch({ 'GET /api/v1/permits/search': { status: 500, body: { error: 'internal_error' } } });
    renderAs(<RecordsPage />, normalEmployee());
    expect(await screen.findByText(/could not load this/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});

describe('filtering', () => {
  it('sends the filters to the server rather than filtering in the browser', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({ 'GET /api/v1/permits/search': searchResponse([record()]) });
    renderAs(<RecordsPage />, normalEmployee());
    await screen.findAllByText('000001');

    await user.selectOptions(screen.getByLabelText(/^status/i), 'ISSUED');
    await user.click(screen.getByRole('button', { name: /apply filters/i }));

    await waitFor(() => expect(calls.some((call) => call.url.includes('status=ISSUED'))).toBe(true));
  });

  it('always sends a bounded page size', async () => {
    stubFetch({ 'GET /api/v1/permits/search': searchResponse([]) });
    const { calls } = stubFetch({ 'GET /api/v1/permits/search': searchResponse([]) });
    renderAs(<RecordsPage />, normalEmployee());

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.url).toMatch(/pageSize=\d+/);
  });

  it('resets to page 1 when filters change', async () => {
    const user = userEvent.setup();
    const { calls } = stubFetch({
      'GET /api/v1/permits/search': searchResponse([record()], { totalCount: 60, totalPages: 3, hasNextPage: true }),
    });
    renderAs(<RecordsPage />, normalEmployee());
    await screen.findAllByText('000001');

    await user.click(screen.getByRole('button', { name: /^next$/i }));
    await waitFor(() => expect(calls.some((call) => call.url.includes('page=2'))).toBe(true));

    await user.selectOptions(screen.getByLabelText(/permit type/i), 'HOT_WORK');
    await user.click(screen.getByRole('button', { name: /apply filters/i }));

    await waitFor(() => {
      const last = calls[calls.length - 1]?.url ?? '';
      expect(last).toContain('permitType=HOT_WORK');
      expect(last).toContain('page=1');
    });
  });
});

describe('visibility after a permission change', () => {
  it('re-asks the server when authorization-sensitive state is invalidated', async () => {
    let responses = [record({ id: 'p-1' }), record({ id: 'p-2', permitDisplayNumber: '000002' })];
    const { calls } = stubFetch({
      'GET /api/v1/permits/search': () => searchResponse(responses),
    });
    renderAs(<RecordsPage />, ceo());

    await screen.findAllByText('000002');
    const before = calls.length;

    // A revocation happened elsewhere; the backend now returns less.
    responses = [record({ id: 'p-1' })];
    invalidateAll();

    await waitFor(() => expect(calls.length).toBeGreaterThan(before));
    // The narrower answer is shown as-is - there is no cached wider list.
    await waitFor(() => expect(screen.queryByText('000002')).not.toBeInTheDocument());
  });

  it('shows a refusal honestly if the backend starts answering 403', async () => {
    let forbidden = false;
    stubFetch({
      'GET /api/v1/permits/search': () =>
        forbidden ? { status: 403, body: { error: 'forbidden' } } : searchResponse([record()]),
    });
    renderAs(<RecordsPage />, normalEmployee());
    await screen.findAllByText('000001');

    forbidden = true;
    invalidateAll();

    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
  });
});
