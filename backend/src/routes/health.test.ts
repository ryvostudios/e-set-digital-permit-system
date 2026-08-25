import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { createApp } from '../app.js';

/**
 * Only `Pool.prototype.query` is stubbed (the one true I/O boundary
 * `/ready` touches) - never a real database connection.
 */

let dbShouldFail = false;
const originalPoolQuery = Pool.prototype.query;

before(() => {
  Pool.prototype.query = (async () => {
    if (dbShouldFail) throw new Error('simulated database outage');
    return { rows: [{ '?column?': 1 }] };
  }) as unknown as typeof Pool.prototype.query;
});

after(() => {
  Pool.prototype.query = originalPoolQuery;
});

beforeEach(() => {
  dbShouldFail = false;
});

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

test('GET /health never touches the database (liveness does no dangerous/expensive work) and always returns 200', async () => {
  dbShouldFail = true; // even with the database "down", liveness must not care
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; service: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'backend');
  } finally {
    await close();
  }
});

test('GET /ready returns 200 when the database is reachable', async () => {
  dbShouldFail = false;
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/ready`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, 'ready');
  } finally {
    await close();
  }
});

test('GET /ready returns a sanitized 503 when the database is unreachable - never connection strings/driver detail', async () => {
  dbShouldFail = true;
  const { url, close } = await startServer();
  try {
    const res = await fetch(`${url}/api/v1/ready`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, 'not_ready');
    assert.deepEqual(Object.keys(body), ['status']);
    assert.equal(JSON.stringify(body).includes('simulated database outage'), false);
  } finally {
    await close();
  }
});
