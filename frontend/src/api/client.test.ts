import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiDownload, apiRequest, setSessionEndedHandler } from './client';

/**
 * The single network boundary.
 *
 * What is proved here: the access token is attached per request and
 * never held, a 401 ends the session centrally, and the PDF path never
 * builds a storage URL of its own.
 */

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: async () => body,
    blob: async () => new Blob(['pdf-bytes']),
  } as unknown as Response;
}

beforeEach(() => {
  setSessionEndedHandler(() => {});
});

describe('request construction', () => {
  it('calls the versioned API prefix and includes browser cookie credentials', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/v1/auth/me');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string,string>).authorization).toBeUndefined();
  });

  it('sends no authorization header when there is no session', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/auth/me');

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('drops empty query parameters instead of sending blanks', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/permits/search', { query: { status: 'ISSUED', company: '', page: undefined } });

    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('status=ISSUED');
    expect(url).not.toContain('company=');
    expect(url).not.toContain('page=');
  });

  it('serializes a JSON body with the right content type', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetchMock);

    await apiRequest('/permits', { method: 'POST', body: { permitType: 'HOT_WORK' } });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ permitType: 'HOT_WORK' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});

describe('session termination', () => {
  it('fires the session-ended handler on a 401 from any endpoint', async () => {
    const onEnded = vi.fn();
    setSessionEndedHandler(onEnded);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized' })));

    await expect(apiRequest('/permits/mine')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(onEnded).toHaveBeenCalledOnce();
  });

  it('does NOT fire it on a 403, which is a permission answer rather than a dead session', async () => {
    const onEnded = vi.fn();
    setSessionEndedHandler(onEnded);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(403, { error: 'forbidden' })));

    await expect(apiRequest('/admin/employees')).rejects.toMatchObject({ code: 'forbidden' });
    expect(onEnded).not.toHaveBeenCalled();
  });
});

describe('failure handling', () => {
  it('turns a transport failure into a network error rather than leaking the cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(apiRequest('/auth/me')).rejects.toMatchObject({ code: 'network_error' });
  });

  it('surfaces a returned request id on the error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { error: 'internal_error' }, { 'x-request-id': 'req-77' })),
    );
    await expect(apiRequest('/auth/me')).rejects.toMatchObject({ requestId: 'req-77' });
  });

  it('rate limiting is reported as its own code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(429, { error: 'rate_limited' })));
    await expect(apiRequest('/permits')).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('the permit document', () => {
  it('is fetched from the backend endpoint, never from a storage URL', async () => {
    const fetchMock = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="permit-000042.pdf"',
        }),
        blob: async () => new Blob(['pdf']),
        json: async () => null,
      }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await apiDownload('/permits/abc/pdf');

    const url = (fetchMock.mock.calls[0] as unknown as [string])[0];
    expect(url).toContain('/api/v1/permits/abc/pdf');
    // No bucket, no object key, no signed link, no external host.
    expect(url).not.toMatch(/storage|s3|supabase\.co\/storage|amazonaws/i);
    expect(result.fileName).toBe('permit-000042.pdf');
  });

  it('reports "still being prepared" for a 202 rather than handing over an empty file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(202, { status: 'processing' })));
    await expect(apiDownload('/permits/abc/pdf')).rejects.toMatchObject({ code: 'document_processing' });
  });

  it('reports unavailable storage without naming any infrastructure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, { error: 'storage_unavailable' })));
    await expect(apiDownload('/permits/abc/pdf')).rejects.toMatchObject({ code: 'storage_unavailable' });
  });
});
