import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import express, { type Request, type Response } from 'express';
import { parseTrustProxyCidrs } from './trustProxy.js';

/**
 * Exercises the REAL Express/proxy-addr `trust proxy` mechanism over
 * actual HTTP requests - not a mock - using the exact same
 * `parseTrustProxyCidrs` helper `app.ts` wires up from
 * `TRUST_PROXY_CIDRS`. Built as small standalone apps (rather than the
 * full `createApp()`) because `config/env.ts`'s `env` singleton reads
 * real `process.env` once at import time, so per-test trust-proxy
 * configurations can't be exercised through it - see `env.test.ts`'s
 * doc comment for the same reasoning.
 */

async function startServer(trustProxyCidrsRaw: string | undefined): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  const trusted = parseTrustProxyCidrs(trustProxyCidrsRaw);
  if (trusted.length > 0) {
    app.set('trust proxy', trusted);
  }
  app.get('/', (req: Request, res: Response) => {
    res.status(200).json({ ip: req.ip, ips: req.ips });
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const SPOOFED_IP = '203.0.113.99';

test('with no trusted proxies configured (TRUST_PROXY_CIDRS unset), a spoofed X-Forwarded-For cannot choose req.ip - it is always the direct socket address', async () => {
  const { url, close } = await startServer(undefined);
  try {
    const res = await fetch(url, { headers: { 'x-forwarded-for': SPOOFED_IP } });
    const body = (await res.json()) as { ip: string };
    assert.notEqual(body.ip, SPOOFED_IP);
    assert.equal(body.ip, '127.0.0.1');
  } finally {
    await close();
  }
});

test('an untrusted intermediary (its address not in the allowlist) is ignored - X-Forwarded-For has no effect on req.ip', async () => {
  // The real connecting peer in this test is loopback (127.0.0.1) - the
  // allowlist below trusts a different, unrelated address, so the
  // actual peer is NOT trusted and must not consult X-Forwarded-For.
  const { url, close } = await startServer('10.0.0.1');
  try {
    const res = await fetch(url, { headers: { 'x-forwarded-for': SPOOFED_IP } });
    const body = (await res.json()) as { ip: string };
    assert.notEqual(body.ip, SPOOFED_IP);
    assert.equal(body.ip, '127.0.0.1');
  } finally {
    await close();
  }
});

test('a trusted configured proxy (matching the real connecting peer) yields the forwarded client IP', async () => {
  const { url, close } = await startServer('127.0.0.1');
  try {
    const res = await fetch(url, { headers: { 'x-forwarded-for': SPOOFED_IP } });
    const body = (await res.json()) as { ip: string };
    assert.equal(body.ip, SPOOFED_IP);
  } finally {
    await close();
  }
});

test('the "loopback" preset trusts the real connecting peer the same way as listing its address explicitly', async () => {
  const { url, close } = await startServer('loopback');
  try {
    const res = await fetch(url, { headers: { 'x-forwarded-for': SPOOFED_IP } });
    const body = (await res.json()) as { ip: string };
    assert.equal(body.ip, SPOOFED_IP);
  } finally {
    await close();
  }
});

test('a multi-hop X-Forwarded-For chain resolves to the leftmost (original client) address once the immediate peer is trusted', async () => {
  const { url, close } = await startServer('loopback');
  try {
    // "client, internal-hop" - the internal hop (127.0.0.1) is itself
    // trusted (loopback), so resolution walks past it too, landing on
    // the leftmost, untrusted entry as the real client.
    const res = await fetch(url, { headers: { 'x-forwarded-for': `${SPOOFED_IP}, 127.0.0.1` } });
    const body = (await res.json()) as { ip: string };
    assert.equal(body.ip, SPOOFED_IP);
  } finally {
    await close();
  }
});

test('an empty/unconfigured trust list behaves identically to no X-Forwarded-For header at all', async () => {
  const { url, close } = await startServer(undefined);
  try {
    const withHeader = await fetch(url, { headers: { 'x-forwarded-for': SPOOFED_IP } });
    const withoutHeader = await fetch(url);
    const bodyWith = (await withHeader.json()) as { ip: string };
    const bodyWithout = (await withoutHeader.json()) as { ip: string };
    assert.equal(bodyWith.ip, bodyWithout.ip);
  } finally {
    await close();
  }
});
