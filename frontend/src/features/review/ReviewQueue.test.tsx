import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ceo,
  croEmployee,
  emptyPagination,
  hseApprover,
  permitSummary,
  siteManager,
  zplHseEmployee,
} from '../../test/factories';
import { renderAs, stubFetch } from '../../test/harness';
import { CroQueuePage } from './CroQueuePage';
import { HseQueuePage } from './HseQueuePage';

/**
 * The review queues.
 *
 * These screens are deliberately reachable by anyone who types the URL -
 * the SERVER decides, and its refusal is what the person sees. That is
 * the property being pinned here, along with the two identity collisions
 * that would be dangerous: ZPL's "HSE" position is not an HSE approver,
 * and a privileged Site Manager is not automatically a CRO.
 */

function queueResponse(permits: unknown[]) {
  return { body: { permits, pagination: emptyPagination({ totalCount: permits.length, totalPages: 1 }) } };
}

describe('the CRO queue', () => {
  it('loads the PENDING_CRO queue from the server', async () => {
    const { calls } = stubFetch({ 'GET /api/v1/permits/queue': queueResponse([]) });
    renderAs(<CroQueuePage />, croEmployee());

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.url).toContain('status=PENDING_CRO');
  });

  it('lists the permits awaiting review', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': queueResponse([permitSummary({ status: 'PENDING_CRO' })]) });
    renderAs(<CroQueuePage />, croEmployee());
    expect((await screen.findAllByText('WTG-1')).length).toBeGreaterThan(0);
  });

  it('shows an empty queue as an explicit state, not a blank panel', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': queueResponse([]) });
    renderAs(<CroQueuePage />, croEmployee());
    expect(await screen.findByText(/no permits are waiting for cro review/i)).toBeInTheDocument();
  });

  it('shows the server’s refusal to someone without CRO authority, not an empty queue', async () => {
    stubFetch({
      'GET /api/v1/permits/queue': { status: 403, body: { error: 'forbidden', message: 'Insufficient capability' } },
    });
    renderAs(<CroQueuePage />, hseApprover());

    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    // Critically NOT "no permits are waiting", which would read as "no work".
    expect(screen.queryByText(/no permits are waiting/i)).not.toBeInTheDocument();
  });

  it('refuses a privileged Site Manager too - a privileged role is not CRO authority', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': { status: 403, body: { error: 'forbidden' } } });
    renderAs(<CroQueuePage />, siteManager());
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
  });

  it('refuses the CEO as well', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': { status: 403, body: { error: 'forbidden' } } });
    renderAs(<CroQueuePage />, ceo());
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
  });
});

describe('the HSE queue', () => {
  it('loads the PENDING_HSE queue from the server', async () => {
    const { calls } = stubFetch({ 'GET /api/v1/permits/queue': queueResponse([]) });
    renderAs(<HseQueuePage />, hseApprover());

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0]?.url).toContain('status=PENDING_HSE');
  });

  it('lists permits for a genuine E-SET HSE approver', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': queueResponse([permitSummary({ status: 'PENDING_HSE' })]) });
    renderAs(<HseQueuePage />, hseApprover());
    expect((await screen.findAllByText('WTG-1')).length).toBeGreaterThan(0);
  });

  it('is REFUSED to ZPL’s "HSE" position - a different company’s job title, with no approval authority', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': { status: 403, body: { error: 'forbidden' } } });
    renderAs(<HseQueuePage />, zplHseEmployee());

    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
    expect(screen.queryByText(/no permits are waiting/i)).not.toBeInTheDocument();
  });

  it('is refused to a CRO, who forwards to HSE but does not approve as HSE', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': { status: 403, body: { error: 'forbidden' } } });
    renderAs(<HseQueuePage />, croEmployee());
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument();
  });
});

describe('queue failures', () => {
  it('offers a retry for a server error but not for a refusal', async () => {
    stubFetch({ 'GET /api/v1/permits/queue': { status: 500, body: { error: 'internal_error' } } });
    const { unmount } = renderAs(<CroQueuePage />, croEmployee());
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
    unmount();

    stubFetch({ 'GET /api/v1/permits/queue': { status: 403, body: { error: 'forbidden' } } });
    renderAs(<CroQueuePage />, croEmployee());
    await screen.findByText(/do not have permission/i);
    // Retrying a refusal would just fail again; it is not offered.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });
});
