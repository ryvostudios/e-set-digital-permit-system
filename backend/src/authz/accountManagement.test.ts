import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizeAccountManagement,
  isManageableTarget,
  teamPositionIsSiteManagerAssignable,
  type AccountManagementDeps,
} from './accountManagement.js';
import type { PrivilegedRole } from './privilegedAccess.js';
import type { QueryFn } from '../db/pool.js';

const MANAGER = 'site-manager-1';
const CEO = 'ceo-1';
const EMPLOYEE = 'employee-1';

function buildDeps(
  capabilities: Record<string, string[]>,
  privileged: Record<string, PrivilegedRole[]>,
): AccountManagementDeps {
  return {
    resolveCapabilities: async (userId) => new Set(capabilities[userId] ?? []),
    resolvePrivileged: async (userId) => new Set(privileged[userId] ?? []),
  };
}

test('account management requires BOTH the capability and CEO/Site Manager privileged access', async () => {
  const both = buildDeps({ [MANAGER]: ['employee.create'] }, { [MANAGER]: ['SITE_MANAGER'] });
  assert.deepEqual(await authorizeAccountManagement(MANAGER, 'employee.create', both), {
    authorized: true,
    roles: new Set(['SITE_MANAGER']),
  });

  // Capability alone is NOT enough - otherwise a Team + Position could
  // confer account management, which the governance model forbids.
  const capabilityOnly = buildDeps({ [MANAGER]: ['employee.create'] }, {});
  assert.deepEqual(await authorizeAccountManagement(MANAGER, 'employee.create', capabilityOnly), {
    authorized: false,
    reason: 'missing_privileged_access',
  });

  // Privileged access alone is NOT enough either.
  const privilegedOnly = buildDeps({}, { [MANAGER]: ['SITE_MANAGER'] });
  assert.deepEqual(await authorizeAccountManagement(MANAGER, 'employee.create', privilegedOnly), {
    authorized: false,
    reason: 'missing_capability',
  });
});

test('each account-management action is bound to its own capability', async () => {
  const deps = buildDeps({ [MANAGER]: ['employee.create'] }, { [MANAGER]: ['SITE_MANAGER'] });
  assert.equal((await authorizeAccountManagement(MANAGER, 'employee.create', deps)).authorized, true);
  assert.equal((await authorizeAccountManagement(MANAGER, 'employee.reset_password', deps)).authorized, false);
});

test('a CEO holding the capability may also manage accounts', async () => {
  const deps = buildDeps({ [CEO]: ['employee.create', 'employee.reset_password'] }, { [CEO]: ['CEO'] });
  assert.equal((await authorizeAccountManagement(CEO, 'employee.create', deps)).authorized, true);
  assert.equal((await authorizeAccountManagement(CEO, 'employee.reset_password', deps)).authorized, true);
});

test('an ordinary employee - even one holding every permit capability - is denied', async () => {
  const deps = buildDeps(
    { [EMPLOYEE]: ['permit.create', 'permit.close', 'permit.renew', 'permit.hse_review'] },
    {},
  );
  assert.deepEqual(await authorizeAccountManagement(EMPLOYEE, 'employee.create', deps), {
    authorized: false,
    reason: 'missing_capability',
  });
});

test('a revoked privileged grant no longer authorizes account management', async () => {
  // `resolvePrivilegedAccess` returns only currently-GRANTED roles, so a
  // revoked Site Manager resolves to an empty set here.
  const deps = buildDeps({ [MANAGER]: ['employee.create'] }, { [MANAGER]: [] });
  assert.deepEqual(await authorizeAccountManagement(MANAGER, 'employee.create', deps), {
    authorized: false,
    reason: 'missing_privileged_access',
  });
});

test('a CEO target can never be managed through the normal-employee flow', async () => {
  const deps = buildDeps({}, { [CEO]: ['CEO'] });
  assert.deepEqual(await isManageableTarget(MANAGER, CEO, deps), {
    eligible: false,
    reason: 'target_is_privileged',
  });
});

test('another Site Manager (protected upper management) can never be managed either', async () => {
  const deps = buildDeps({}, { 'site-manager-2': ['SITE_MANAGER'] });
  assert.deepEqual(await isManageableTarget(MANAGER, 'site-manager-2', deps), {
    eligible: false,
    reason: 'target_is_privileged',
  });
});

test('a manager cannot act on their own account through the management endpoints', async () => {
  const deps = buildDeps({}, { [MANAGER]: ['SITE_MANAGER'] });
  assert.deepEqual(await isManageableTarget(MANAGER, MANAGER, deps), {
    eligible: false,
    reason: 'target_is_self',
  });
});

test('a normal employee holding no privileged grant is a manageable target', async () => {
  const deps = buildDeps({ [EMPLOYEE]: ['permit.create'] }, {});
  assert.deepEqual(await isManageableTarget(MANAGER, EMPLOYEE, deps), { eligible: true });
});

test('protection is derived from privileged grants, not from capabilities or any client hint', async () => {
  // An account with sweeping operational capabilities but no privileged
  // grant is still a normal employee...
  const operational = buildDeps({ [EMPLOYEE]: ['permit.close', 'permit.renew'] }, {});
  assert.deepEqual(await isManageableTarget(MANAGER, EMPLOYEE, operational), { eligible: true });

  // ...while an account with NO capabilities but a privileged grant is
  // protected. Nothing here consults user_metadata, an email, or a name.
  const governed = buildDeps({}, { [EMPLOYEE]: ['SITE_MANAGER'] });
  assert.deepEqual(await isManageableTarget(MANAGER, EMPLOYEE, governed), {
    eligible: false,
    reason: 'target_is_privileged',
  });
});

test('teamPositionIsSiteManagerAssignable requires explicit authoritative approval', async () => {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const queryFn = (async (text: string, params: unknown[] = []) => {
    captured.push({ sql: String(text), params });
    return { rows: String(params[0]) === 'known-tp' ? [{ exists: true }] : [] };
  }) as unknown as QueryFn;

  assert.equal(await teamPositionIsSiteManagerAssignable('known-tp', queryFn), true);
  assert.equal(await teamPositionIsSiteManagerAssignable('made-up-tp', queryFn), false);
  assert.ok(captured[0]?.sql.includes('FROM team_positions'));
  assert.ok(captured[0]?.sql.includes('site_manager_assignable = TRUE'));
  assert.deepEqual(captured[0]?.params, ['known-tp'], 'the identifier is always a bound parameter');
});
