import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { requirePrivilegedAccess } from './requirePrivilegedAccess.js';

class MockResponse {
  statusCode: number | null = null;
  body: unknown = null;

  readonly res: Response = {
    status: (code: number) => {
      this.statusCode = code;
      return this.res;
    },
    json: (body: unknown) => {
      this.body = body;
      return this.res;
    },
  } as unknown as Response;
}

function mockRequest(auth: Request['auth']): Request {
  return { auth } as unknown as Request;
}

test('requirePrivilegedAccess denies a request with no authenticated identity (401)', async () => {
  const middleware = requirePrivilegedAccess('CEO', async () => new Set(['CEO']));
  const req = mockRequest(undefined);
  const mock = new MockResponse();
  let nextCalled = false;

  await middleware(req, mock.res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 401);
  assert.deepEqual(mock.body, { error: 'unauthorized', message: 'Authentication required' });
});

test('requirePrivilegedAccess denies when the resolved set is empty (default-deny)', async () => {
  const middleware = requirePrivilegedAccess('CEO', async () => new Set());
  const req = mockRequest({ id: 'user-1', email: null, mustChangePassword: false });
  const mock = new MockResponse();
  let nextCalled = false;

  await middleware(req, mock.res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 403);
  assert.deepEqual(mock.body, { error: 'forbidden', message: 'Privileged access required' });
});

test('requirePrivilegedAccess denies a Site Manager when CEO is required (no implicit escalation)', async () => {
  const middleware = requirePrivilegedAccess('CEO', async () => new Set(['SITE_MANAGER']));
  const req = mockRequest({ id: 'user-1', email: null, mustChangePassword: false });
  const mock = new MockResponse();
  let nextCalled = false;

  await middleware(req, mock.res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 403);
});

test('requirePrivilegedAccess calls next() when the resolved set grants the required role', async () => {
  const middleware = requirePrivilegedAccess('SITE_MANAGER', async () => new Set(['CEO', 'SITE_MANAGER']));
  const req = mockRequest({ id: 'user-1', email: null, mustChangePassword: false });
  const mock = new MockResponse();
  let nextCalled = false;

  await middleware(req, mock.res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, true);
  assert.equal(mock.statusCode, null);
});

test('requirePrivilegedAccess fails closed (403) when resolution throws', async () => {
  const middleware = requirePrivilegedAccess('CEO', async () => {
    throw new Error('simulated database failure');
  });
  const req = mockRequest({ id: 'user-1', email: null, mustChangePassword: false });
  const mock = new MockResponse();
  let nextCalled = false;

  await middleware(req, mock.res, (() => {
    nextCalled = true;
  }) as NextFunction);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 403);
  assert.deepEqual(mock.body, { error: 'forbidden', message: 'Privileged access required' });
});
