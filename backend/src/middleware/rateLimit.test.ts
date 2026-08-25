import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { buildRateLimiter } from './rateLimit.js';

/**
 * Exercises the real `express-rate-limit` mechanism via `buildRateLimiter`
 * (the same factory `app.ts`/`routes/permits.ts` use for the production
 * limiters), just with a tiny window/limit instead of a production-sized
 * one - so these tests actually trip the limit in milliseconds rather
 * than needing hundreds of requests or real wall-clock waiting.
 */

async function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function appWithLimiter(limiter: ReturnType<typeof buildRateLimiter>): Express {
  const app = express();
  app.use(limiter);
  app.get('/', (_req: Request, res: Response) => res.status(200).json({ ok: true }));
  return app;
}

test('buildRateLimiter allows requests up to the configured limit, then rejects with a sanitized 429', async () => {
  const limiter = buildRateLimiter({ windowMs: 60_000, limit: 2 });
  const { url, close } = await startServer(appWithLimiter(limiter));
  try {
    const first = await fetch(url);
    const second = await fetch(url);
    const third = await fetch(url);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);

    const body = (await third.json()) as { error: string; message: string };
    assert.equal(body.error, 'rate_limited');
    assert.equal(typeof body.message, 'string');
    // Sanitized: no internal detail (store type, window internals, stack).
    assert.deepEqual(Object.keys(body).sort(), ['error', 'message']);
  } finally {
    await close();
  }
});

test('buildRateLimiter sets a standard RateLimit response header (not the legacy X-RateLimit-* set)', async () => {
  const limiter = buildRateLimiter({ windowMs: 60_000, limit: 5 });
  const { url, close } = await startServer(appWithLimiter(limiter));
  try {
    const res = await fetch(url);
    assert.ok(res.headers.get('ratelimit'));
    assert.equal(res.headers.get('x-ratelimit-limit'), null);
  } finally {
    await close();
  }
});

test('buildRateLimiter (unkeyed / IP-based) applies the same budget regardless of authentication state - a request cannot exempt itself by authenticating', async () => {
  const limiter = buildRateLimiter({ windowMs: 60_000, limit: 2 });
  const app = express();
  // Simulates requireAuth having already run and attached an identity -
  // the point being that the IP-based (unkeyed) limiter ignores it.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.auth = { id: 'some-authenticated-user', email: null };
    next();
  });
  app.use(limiter);
  app.get('/', (_req: Request, res: Response) => res.status(200).json({ ok: true }));
  const { url, close } = await startServer(app);
  try {
    await fetch(url);
    await fetch(url);
    const third = await fetch(url);
    assert.equal(third.status, 429, 'an authenticated identity must not exempt a request from an IP-keyed limiter');
  } finally {
    await close();
  }
});

test('buildRateLimiter (keyed: true) gives each authenticated identity its own independent budget', async () => {
  const limiter = buildRateLimiter({ windowMs: 60_000, limit: 2, keyed: true });
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const userId = req.header('x-test-user-id');
    if (userId) req.auth = { id: userId, email: null };
    next();
  });
  app.use(limiter);
  app.get('/', (_req: Request, res: Response) => res.status(200).json({ ok: true }));
  const { url, close } = await startServer(app);
  try {
    const userAHeaders = { 'x-test-user-id': 'user-a' };
    const userBHeaders = { 'x-test-user-id': 'user-b' };

    assert.equal((await fetch(url, { headers: userAHeaders })).status, 200);
    assert.equal((await fetch(url, { headers: userAHeaders })).status, 200);
    assert.equal(
      (await fetch(url, { headers: userAHeaders })).status,
      429,
      'user-a exhausted their own budget',
    );

    // user-b, hitting the exact same server/process/IP, has NOT
    // exhausted anything - proves the key is the identity, not the IP.
    assert.equal((await fetch(url, { headers: userBHeaders })).status, 200);
    assert.equal((await fetch(url, { headers: userBHeaders })).status, 200);
    assert.equal((await fetch(url, { headers: userBHeaders })).status, 429);
  } finally {
    await close();
  }
});

test('buildRateLimiter (keyed: true) falls back to IP-keying for a request with no authenticated identity', async () => {
  const limiter = buildRateLimiter({ windowMs: 60_000, limit: 1, keyed: true });
  const { url, close } = await startServer(appWithLimiter(limiter));
  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 429);
  } finally {
    await close();
  }
});
