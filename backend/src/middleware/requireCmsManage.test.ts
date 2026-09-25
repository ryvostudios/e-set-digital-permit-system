import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Request, Response, NextFunction } from 'express';
import { requireCmsManage } from './requireCmsManage.js';

async function outcome(roles: string[], capabilities: string[], authenticated = true): Promise<number> {
  let status = 0;
  const req = (authenticated ? { auth: { id: 'synthetic-user' } } : {}) as Request;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  const next = (() => { status = 200; }) as NextFunction;
  await requireCmsManage(async () => new Set(roles) as never,
    async () => new Set(capabilities))(req, res, next);
  return status;
}

test('CMS requires a live CEO grant or explicit individual capability', async () => {
  assert.equal(await outcome(['CEO'], []), 200);
  assert.equal(await outcome([], ['permit.cms.manage']), 200);
  assert.equal(await outcome(['SITE_MANAGER'], []), 403);
  assert.equal(await outcome([], ['permit.view_all']), 403);
  assert.equal(await outcome([], [], false), 401);
});

test('authorization lookup failures deny CMS access', async () => {
  const req = { auth: { id: 'synthetic-user' } } as Request;
  let status = 0;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  const guard = requireCmsManage(async () => { throw new Error('synthetic DB outage'); }, async () => new Set());
  await guard(req, res, (() => { status = 200; }) as NextFunction);
  assert.equal(status, 403);
});
