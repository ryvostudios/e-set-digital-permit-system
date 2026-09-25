import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { setSessionEndedHandler } from '../api/client';
import type { CurrentUser } from '../api/types';
import { AuthContext, type AuthState } from '../auth/AuthProvider';
import { deriveCapabilities } from '../auth/capabilities';
import { ToastProvider } from '../ui/Toast';

/**
 * Rendering helpers.
 *
 * `renderAs` mounts a screen with a specific authenticated identity - the
 * exact `/auth/me` shape the backend returns - so every capability
 * decision under test is driven by real response data rather than by a
 * flag invented for the test.
 */

export function authStateFor(user: CurrentUser, overrides: Partial<AuthState> = {}): AuthState {
  return {
    phase: 'ready',
    user,
    capabilities: deriveCapabilities(user),
    identityError: null,
    signIn: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    refreshIdentity: vi.fn(async () => {}),
    ...overrides,
  };
}

export function renderAs(
  ui: ReactElement,
  user: CurrentUser,
  options: { route?: string; auth?: Partial<AuthState> } = {},
): RenderResult & { auth: AuthState } {
  const auth = authStateFor(user, options.auth ?? {});
  const result = render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <AuthContext.Provider value={auth}>
        <ToastProvider>{ui}</ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
  return { ...result, auth };
}

export function renderWithAuthState(ui: ReactElement, auth: AuthState, route = '/'): RenderResult {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthContext.Provider value={auth}>
        <ToastProvider>{ui}</ToastProvider>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

export interface StubbedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Replaces `fetch` with a router keyed on "METHOD /path". Anything not
 * matched is a hard failure, so a test can never silently pass because a
 * screen called an endpoint nobody stubbed.
 */
export function stubFetch(routes: Record<string, StubbedResponse | ((url: URL, init?: RequestInit) => StubbedResponse)>) {
  const calls: { method: string; url: string; body: unknown }[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsedBody = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url: `${url.pathname}${url.search}`, body: parsedBody });

    const key = `${method} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      throw new Error(`Unstubbed request: ${key}`);
    }

    const resolved = typeof route === 'function' ? route(url, init) : route;
    const status = resolved.status ?? 200;
    const headers = new Headers({ 'content-type': 'application/json', ...(resolved.headers ?? {}) });

    return {
      ok: status >= 200 && status < 300,
      status,
      headers,
      json: async () => resolved.body ?? null,
      blob: async () => new Blob([JSON.stringify(resolved.body ?? {})]),
    } as unknown as Response;
  });

  vi.stubGlobal('fetch', fetchMock);
  // The API client asks for a token per request; give it a fixed one.
  setSessionEndedHandler(() => {});

  return { fetchMock, calls };
}
