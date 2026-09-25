import { ApiError, toApiError, toNetworkError } from './errors';

/** Single backend boundary. The browser attaches an HttpOnly Permit cookie;
 * JavaScript never reads, stores, or propagates an authentication token. */

const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? '';

/** The versioned API prefix every backend route is mounted under (backend/src/app.ts). */
const API_PREFIX = '/api/v1';

/**
 * Called whenever the backend reports that the session is no longer
 * usable (401). The auth layer installs a handler that tears down local
 * state and returns the person to login, so a revoked, disabled, or
 * deleted account cannot keep rendering an application shell.
 */
type SessionEndedHandler = () => void;
let onSessionEnded: SessionEndedHandler = () => {};

export function setSessionEndedHandler(handler: SessionEndedHandler): void {
  onSessionEnded = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
  /**
   * Endpoints that must stay reachable while a forced password change is
   * outstanding (`/auth/me`, `/auth/change-password`). For everything
   * else a `password_change_required` response is a real error the
   * router acts on.
   */
  allowDuringPasswordChange?: boolean;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const url = `${API_BASE_URL}${API_PREFIX}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `${url}?${serialized}` : url;
}

async function parseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return null;
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Performs one authenticated API call and returns its parsed JSON body. */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, signal, allowDuringPasswordChange = false } = options;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      credentials: 'include',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw toNetworkError();
  }

  const requestId = response.headers.get('x-request-id');

  if (response.status === 204) return undefined as T;

  const parsed = await parseBody(response);

  if (!response.ok) {
    const apiError = toApiError(response.status, parsed, requestId);
    // A dead session must not be left to each caller to notice: tear
    // down centrally, so no screen can keep showing data for an account
    // the backend has stopped accepting.
    if (apiError.isSessionEnded) onSessionEnded();
    if (apiError.code === 'password_change_required' && allowDuringPasswordChange) {
      // The caller explicitly handles this state (the bootstrap does).
      throw apiError;
    }
    throw apiError;
  }

  return parsed as T;
}

/**
 * Downloads a binary response (the permit PDF). Kept here, alongside
 * `apiRequest`, so the PDF path uses exactly the same cookie credentials
 * and error mapping as every JSON call - and so no component ever builds
 * a storage URL of its own. The bytes are served BY THE BACKEND after it
 * authorizes the permit; the browser never sees a bucket, a key, or a
 * signed storage link.
 */
export async function apiDownload(
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ blob: Blob; fileName: string | null }> {
  const headers: Record<string, string> = {};

  let response: Response;
  try {
    response = await fetch(buildUrl(path, undefined), {
      method: 'GET',
      headers,
      credentials: 'include',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw toNetworkError();
  }

  const requestId = response.headers.get('x-request-id');

  if (!response.ok) {
    const apiError = toApiError(response.status, await parseBody(response), requestId);
    if (apiError.isSessionEnded) onSessionEnded();
    throw apiError;
  }

  // 202 means the document is not ready (or generation failed) - a real
  // state, not a PDF. Surfaced as a distinct code so the UI can say so
  // rather than handing the person an empty file.
  if (response.status === 202) {
    const parsed = await parseBody(response);
    const status =
      typeof parsed === 'object' && parsed !== null && 'status' in parsed
        ? String((parsed as { status: unknown }).status)
        : 'processing';
    throw new ApiError({
      code: 'document_processing',
      status: 202,
      message:
        status === 'failed'
          ? 'The permit document could not be generated. An operator has been notified.'
          : 'The permit document is still being prepared. Try again shortly.',
      reason: status,
      requestId,
    });
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob: await response.blob(), fileName: match?.[1] ?? null };
}
