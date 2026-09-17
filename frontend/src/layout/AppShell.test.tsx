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
 * There is exactly ONE logo in the shell and it lives in the top brand
 * header, beside the E-SET / Permit to Work text. The large standalone
 * logo that used to float between the navigation and Alerts is gone.
 *
 * These specs check the logo AND, in the same breath, that navigation,
 * Review, Alerts, the identity and Logout are all still there and still
 * behave the way they did. Nothing asserts a pixel size or a CSS value -
 * where the logo sits is expressed as containment and document order,
 * which is the part that carries meaning.
 */

/** Every official-logo image the shell renders. */
function logos(): HTMLImageElement[] {
  return Array.from(document.querySelectorAll('img[src="/branding/eset-logo.png"]'));
}

describe('the sidebar branding', () => {
  it('renders the official logo exactly once', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    await screen.findByRole('button', { name: /^logout$/i });
    expect(logos()).toHaveLength(1);
  });

  it('puts it in the top brand header, beside the name', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    await screen.findByRole('button', { name: /^logout$/i });
    const brand = logos()[0]?.closest('.brand');
    expect(brand).not.toBeNull();
    expect(brand?.textContent).toContain('E-SET');
    expect(brand?.textContent).toContain('Permit to Work');
  });

  it('comes before the E-SET text in document order', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    await screen.findByRole('button', { name: /^logout$/i });
    const logo = logos()[0];
    const name = screen.getByText('E-SET');
    // DOCUMENT_POSITION_FOLLOWING: the text comes after the logo.
    expect(logo.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('no longer floats between the navigation and Alerts', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    await screen.findByRole('button', { name: /^logout$/i });
    // The old standalone element is gone entirely...
    expect(document.querySelector('.sidebar__logo')).toBeNull();
    // ...and the one remaining logo is not inside the navigation at all.
    expect(logos()[0]?.closest('nav')).toBeNull();
  });

  it('is decorative, so the name is announced once', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    await screen.findByRole('button', { name: /^logout$/i });
    // The brand link already reads "E-SET Permit to Work".
    expect(logos()[0]).toHaveAttribute('alt', '');
    expect(screen.queryByRole('img', { name: /e-set/i })).not.toBeInTheDocument();
  });

  it('leaves the main navigation in place', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    expect(await screen.findByRole('navigation', { name: /main navigation/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /my permits/i })).toBeInTheDocument();
  });

  it('leaves Review in place where the actor has it', async () => {
    quietBackend();
    renderAs(<AppShell />, croEmployee());

    expect(await screen.findByRole('link', { name: /cro review/i })).toBeInTheDocument();
  });

  it('leaves Alerts and Notifications in place', async () => {
    quietBackend();
    renderAs(<AppShell />, normalEmployee());

    expect(await screen.findByRole('link', { name: /notifications/i })).toBeInTheDocument();
  });

  it('leaves the identity and Logout in place', async () => {
    quietBackend();
    renderAs(<AppShell />, siteManager());

    const logout = await screen.findByRole('button', { name: /^logout$/i });
    const footer = logout.closest('.sidebar__footer');
    expect(footer?.textContent).toMatch(/\S/);
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
