import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createApp } from './app.js';

/**
 * HTTP/API hardening, exercised against the REAL app (`createApp()`)
 * over actual HTTP requests. Every case here is deliberately reachable
 * without a database or an authenticated identity - body parsing, CORS,
 * security headers, and the global rate limiter all run before
 * `requireAuth`/any route handler, so none of it needs the Pool/Supabase
 * stubbing `routes/permits.test.ts` uses for the routes that do reach
 * the database.
 */

async function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('malformed JSON body gets a sanitized 400, never a stack trace or generic 500', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/permits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not valid json',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; message: string };
    assert.equal(body.error, 'invalid_request');
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
  } finally {
    await close();
  }
});

test('a request body over the configured limit gets a sanitized 413, not a crash', async () => {
  const { url, close } = await startServer();
  try {
    const oversized = JSON.stringify({ padding: 'x'.repeat(200_000) }); // well over the 100kb limit
    const res = await fetch(`${url}/api/v1/permits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    assert.equal(res.status, 413);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'payload_too_large');
  } finally {
    await close();
  }
});

test('an unknown path gets a sanitized JSON 404, never Express\'s default HTML error page', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/this-route-does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'not_found');
  } finally {
    await close();
  }
});

test('an unsupported method on a real path gets the same sanitized 404 (no method-specific information disclosure)', async () => {
  const { url, close } = await startServer();
  try {
    // /permits/mine only defines GET.
    const res = await fetch(`${url}/api/v1/permits/mine`, { method: 'PUT' });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('a disallowed CORS origin is rejected with a sanitized 403, not a stack trace', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/health`, {
      headers: { origin: 'https://definitely-not-an-allowed-origin.invalid' },
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'forbidden');
  } finally {
    await close();
  }
});

test('a request with no Origin header (server-to-server / curl) is never blocked by CORS', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/health`);
    assert.equal(res.status, 200);
  } finally {
    await close();
  }
});

test('security headers are present (helmet) and the framework is not fingerprinted (no X-Powered-By)', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/health`);
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-dns-prefetch-control'), 'off');
  } finally {
    await close();
  }
});

test('every /api/v1 request carries a RateLimit response header (the global limiter is mounted app-wide)', async () => {
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/health`);
    assert.ok(res.headers.get('ratelimit'));
  } finally {
    await close();
  }
});

test('every response carries an X-Request-Id header, and an inbound one is echoed back when it looks safe', async () => {
  const { url, close } = await startServer();
  try {
    const withoutInbound = await fetch(`${url}/api/v1/health`);
    assert.ok(withoutInbound.headers.get('x-request-id'));

    const inboundId = 'client-supplied-correlation-id-123';
    const withInbound = await fetch(`${url}/api/v1/health`, { headers: { 'x-request-id': inboundId } });
    assert.equal(withInbound.headers.get('x-request-id'), inboundId);

    // A CR/LF-containing value isn't even transmittable as a header via
    // fetch (illegal at the HTTP layer, rejected client-side) - the
    // shape this guards against is a value that's syntactically a valid
    // header but doesn't match SAFE_REQUEST_ID (e.g. contains spaces or
    // slashes), which a generated UUID never would.
    const unsafeValue = 'has spaces/and/slashes';
    const unsafeInbound = await fetch(`${url}/api/v1/health`, { headers: { 'x-request-id': unsafeValue } });
    assert.notEqual(unsafeInbound.headers.get('x-request-id'), unsafeValue);
  } finally {
    await close();
  }
});
