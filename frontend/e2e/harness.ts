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

const FAKE_ACCESS_TOKEN = 'e2e-not-a-real-token';

/** A Supabase-shaped persisted session, enough for the app to consider itself signed in. */
function fakeSupabaseSession(userId: string, email: string) {
  return {
    access_token: FAKE_ACCESS_TOKEN,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: 'e2e-not-a-real-refresh-token',
    user: { id: userId, email, aud: 'authenticated', role: 'authenticated' },
  };
}

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
  const supabaseUrl = 'https://test-project.supabase.co';

  // Seed the persisted session BEFORE the app boots.
  await page.addInitScript(
    ([url, session]) => {
      const ref = String(url).replace('https://', '').split('.')[0];
      // The client installs a remember-aware storage adapter: without this
      // flag it reads sessionStorage, so a localStorage-only seed would be
      // silently ignored. Set both so either path finds the session.
      window.localStorage.setItem('eset.auth.remember', '1');
      window.localStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session));
      window.sessionStorage.setItem(`sb-${ref}-auth-token`, JSON.stringify(session));
    },
    [supabaseUrl, fakeSupabaseSession(identity.userId, identity.email)] as const,
  );

  // Supabase token/user endpoints - answered locally, never called out.
  await page.route('**/auth/v1/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...fakeSupabaseSession(identity.userId, identity.email) }),
    });
  });

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
