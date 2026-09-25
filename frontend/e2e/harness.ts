import type { Page } from '@playwright/test';

/**
 * Shared setup for the visual specs.
 *
 * Every backend call is intercepted and answered from fixtures here, so a
 * spec can render an authenticated screen without a real session. Nothing
 * in this file, and nothing a spec can reach through it, touches the live
 * API or `backend/.env` - the token below is a literal placeholder string
 * with no meaning to any server.
 */

export interface StubbedIdentity {
  userId: string;
  email: string;
  /** What `/auth/me` should answer. */
  me: Record<string, unknown>;
}

/** A normal employee with a real workforce profile. */
export const employeeIdentity: StubbedIdentity = {
  userId: '10000000-0000-4000-8000-0000000000e0',
  email: 'employee@example.test',
  me: {
    auth: { id: '10000000-0000-4000-8000-0000000000e0', email: 'employee@example.test' },
    accessState: 'ACTIVE',
    mustChangePassword: false,
    profile: {
      displayName: 'Ali Khan',
      company: { code: 'ZPL', name: 'ZPL' },
      teamName: 'Operations',
      positionName: 'Technician',
    },
    privilegedRoles: [],
    privilegedDisplayName: null,
    capabilities: ['permit.create', 'permit.submit'],
  },
};

/**
 * Installs the route stubs and a signed-in session, then navigates.
 * Call before every spec that needs an authenticated screen.
 */
export async function signInAs(
  page: Page,
  identity: StubbedIdentity,
  routes: Record<string, unknown> = {},
): Promise<void> {
  // The application API.
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const key = `${route.request().method()} ${url.pathname.replace('/api/v1', '')}`;
    const override = routes[key];

    if (override !== undefined) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(override) });
      return;
    }
    if (key === 'GET /auth/me') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(identity.me) });
      return;
    }
    // Anything a screen incidentally asks for gets an empty, valid shape
    // rather than a failure that would blank the page under test.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        permits: [],
        notifications: [],
        siteManagers: [],
        items: [],
        pagination: { page: 1, pageSize: 20, totalCount: 0, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
      }),
    });
  });
}

/** Fails the spec if the page scrolls sideways - the classic mobile document defect. */
export async function hasHorizontalPageOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}
