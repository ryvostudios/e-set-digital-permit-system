import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ceo, croEmployee, emptyPagination, normalEmployee, siteManager } from '../test/factories';
import { renderAs, stubFetch } from '../test/harness';
import { AppShell } from './AppShell';

/**
 * The authenticated frame.
 *
 * Signing out was previously reachable only by opening the user menu, so
 * it was invisible until discovered. It is now a labelled control in the
 * sidebar next to the identity - and it must be the SAME `signOut` the
 * menu uses, never a second copy of the auth logic.
 */

function quietBackend() {
  return stubFetch({
    'GET /api/v1/notifications': { body: { notifications: [], pagination: emptyPagination() } },
  } as never);
}

describe('the sidebar logout', () => {
  for (const [label, actor] of [
    ['a normal employee', normalEmployee],
    ['the CEO', ceo],
    ['a Site Manager', siteManager],
  ] as const) {
    it('is visible without opening any menu for ' + label, async () => {
      quietBackend();
      renderAs(<AppShell />, actor());

      const logout = await screen.findByRole('button', { name: /^logout$/i });
      expect(logout).toBeInTheDocument();
    });
  }

  it('calls the existing signOut, and does not reimplement sign-out itself', async () => {
    const user = userEvent.setup();
    quietBackend();
    const { auth } = renderAs(<AppShell />, ceo());

    await user.click(await screen.findByRole('button', { name: /^logout$/i }));

    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('sits alongside the identity it belongs to', async () => {
    quietBackend();
    renderAs(<AppShell />, ceo());

    const logout = await screen.findByRole('button', { name: /^logout$/i });
    const footer = logout.closest('.sidebar__footer');
    expect(footer).not.toBeNull();
    expect(footer?.textContent).toContain('Farhan Aziz');
  });
});

/**
 * The official E-SET logo in the sidebar.
 *
 * It is branding, not a control: it must appear without displacing any
 * part of the frame that people actually use. These specs therefore
 * check the logo AND, in the same breath, that navigation, Review,
 * Alerts, the identity and Logout are all still there and still behave
 * the way they did. Nothing here asserts a pixel size or a CSS value -
 * where the logo sits is expressed as document order, which is the part
 * that carries meaning.
 */
describe('the sidebar branding', () => {
  it('renders the supplied logo file', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    const logo = await screen.findByTestId('sidebar-brand-logo');
    expect(logo.tagName).toBe('IMG');
    expect(logo).toHaveAttribute('src', '/branding/eset-logo.png');
  });

  it('is decorative and is not a link', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    const logo = await screen.findByTestId('sidebar-brand-logo');
    // Empty alt on purpose: the sidebar already names E-SET in text at
    // the top, and a screen reader must not hear it twice.
    expect(logo).toHaveAttribute('alt', '');
    expect(logo.closest('a')).toBeNull();
    // ...and it is not a navigation destination of any kind.
    expect(logo.closest('li')).toBeNull();
  });

  it('leaves the main navigation in place', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    expect(await screen.findByRole('navigation', { name: /main navigation/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /my permits/i })).toBeInTheDocument();
  });

  it('leaves Review in place, and sits below it', async () => {
    quietBackend();
    renderAs(<AppShell />, croEmployee());

    const review = await screen.findByRole('link', { name: /cro review/i });
    const logo = screen.getByTestId('sidebar-brand-logo');
    // DOCUMENT_POSITION_FOLLOWING: the logo comes after Review.
    expect(review.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves Alerts and Notifications in place, and sits above them', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    const notifications = await screen.findByRole('link', { name: /notifications/i });
    const logo = screen.getByTestId('sidebar-brand-logo');
    expect(logo.compareDocumentPosition(notifications) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('leaves the identity and Logout in place, and sits above them', async () => {
    quietBackend();
    renderAs(<AppShell />, siteManager());

    const logout = await screen.findByRole('button', { name: /^logout$/i });
    const footer = logout.closest('.sidebar__footer');
    expect(footer?.textContent).toMatch(/\S/);

    const logo = screen.getByTestId('sidebar-brand-logo');
    expect(logo.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not change what navigating does', async () => {
    const user = userEvent.setup();
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    const records = await screen.findByRole('link', { name: /my permits/i });
    await user.click(records);

    expect(records).toHaveAttribute('aria-current', 'page');
  });

  it('does not change what Logout does', async () => {
    const user = userEvent.setup();
    quietBackend();
    const { auth } = renderAs(<AppShell />, normalEmployee());

    await user.click(await screen.findByRole('button', { name: /^logout$/i }));

    expect(auth.signOut).toHaveBeenCalledTimes(1);
  });
});
