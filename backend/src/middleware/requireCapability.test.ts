import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { requireCapability } from './requireCapability.js';

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

test('requireCapability denies a request with no authenticated identity (401)', async () => {
  const middleware = requireCapability('permit.hold', async () => new Set(['permit.hold']));
  const req = mockRequest(undefined);
  const mock = new MockResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await middleware(req, mock.res, next);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 401);
  assert.deepEqual(mock.body, { error: 'unauthorized', message: 'Authentication required' });
});

test('requireCapability denies when the resolved set is empty (default-deny)', async () => {
  const middleware = requireCapability('permit.hold', async () => new Set());
  const req = mockRequest({ id: 'user-1', email: null });
  const mock = new MockResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await middleware(req, mock.res, next);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 403);
  assert.deepEqual(mock.body, { error: 'forbidden', message: 'Insufficient capability' });
});

test('requireCapability denies when the resolved set has other capabilities but not the required one', async () => {
  const middleware = requireCapability('permit.hold', async () => new Set(['permit.cancel', 'permit.close']));
  const req = mockRequest({ id: 'user-1', email: null });
  const mock = new MockResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await middleware(req, mock.res, next);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 403);
  assert.deepEqual(mock.body, { error: 'forbidden', message: 'Insufficient capability' });
});

test('requireCapability calls next() when the resolved set grants the required capability', async () => {
  const middleware = requireCapability('permit.hold', async () => new Set(['permit.cancel', 'permit.hold']));
  const req = mockRequest({ id: 'user-1', email: null });
  const mock = new MockResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await middleware(req, mock.res, next);

  assert.equal(nextCalled, true);
  assert.equal(mock.statusCode, null);
  assert.equal(mock.body, null);
});

test('requireCapability fails closed (403) when capability resolution throws', async () => {
  const middleware = requireCapability('permit.hold', async () => {
    throw new Error('simulated database failure');
  });
  const req = mockRequest({ id: 'user-1', email: null });
  const mock = new MockResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };

  await middleware(req, mock.res, next);

  assert.equal(nextCalled, false);
  assert.equal(mock.statusCode, 403);
  assert.deepEqual(mock.body, { error: 'forbidden', message: 'Insufficient capability' });
});

test('requireCapability is scoped per required capability, not an all-or-nothing grant', async () => {
  const capabilities = new Set(['permit.hold']);
  const holdMiddleware = requireCapability('permit.hold', async () => capabilities);
  const cancelMiddleware = requireCapability('permit.cancel', async () => capabilities);
  const req = mockRequest({ id: 'user-1', email: null });

  const holdMock = new MockResponse();
  let holdNextCalled = false;
  await holdMiddleware(req, holdMock.res, () => {
    holdNextCalled = true;
  });
  assert.equal(holdNextCalled, true);

  const cancelMock = new MockResponse();
  let cancelNextCalled = false;
  await cancelMiddleware(req, cancelMock.res, () => {
    cancelNextCalled = true;
  });
  assert.equal(cancelNextCalled, false);
  assert.equal(cancelMock.statusCode, 403);
});
