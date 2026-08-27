import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ceo, emptyPagination, normalEmployee, siteManager } from '../test/factories';
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
