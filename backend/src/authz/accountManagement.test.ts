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
/** A NORMAL ZPL employee whose organizational position is literally called "Site Manager". */
const ZPL_SITE_MANAGER = 'zpl-site-manager-1';

function buildDeps(privileged: Record<string, PrivilegedRole[]>): AccountManagementDeps {
  return { resolvePrivileged: async (userId) => new Set(privileged[userId] ?? []) };
}

test('account management is authorized by the privileged system role alone', async () => {
  const manager = buildDeps({ [MANAGER]: ['SITE_MANAGER'] });
  assert.deepEqual(await authorizeAccountManagement(MANAGER, manager), {
    authorized: true,
    roles: new Set(['SITE_MANAGER']),
  });

  const ceo = buildDeps({ [CEO]: ['CEO'] });
  assert.deepEqual(await authorizeAccountManagement(CEO, ceo), {
    authorized: true,
    roles: new Set(['CEO']),
  });
});

test('an E-SET Site Manager needs NO Team + Position capability - they have no Team or Position', async () => {
  // The dependency surface itself is the proof: authorization consults
  // only the privileged grant log. There is no capability resolver to
  // satisfy, so no fake Team + Position could ever be required to give a
  // privileged identity `employee.create` / `employee.reset_password`.
  const deps = buildDeps({ [MANAGER]: ['SITE_MANAGER'] });
  assert.deepEqual(Object.keys(deps), ['resolvePrivileged']);
  assert.equal((await authorizeAccountManagement(MANAGER, deps)).authorized, true);
});

test('an ordinary employee - even one holding every permit capability - is denied', async () => {
  // Capabilities are irrelevant here: the resolver never sees them, so a
  // Team + Position can never confer account management.
  const deps = buildDeps({});
  assert.deepEqual(await authorizeAccountManagement(EMPLOYEE, deps), {
    authorized: false,
    reason: 'missing_privileged_access',
  });
});

test('a ZPL organizational "Site Manager" acquires NO privileged SITE_MANAGER authority', async () => {
  // The ZPL job title is a Position NAME. Privileged status is read only
  // from `privileged_access_events`, so this normal ZPL employee resolves
  // to no privileged role and is denied account management outright -
  // and remains an ordinary manageable target like any other employee.
  const deps = buildDeps({ [MANAGER]: ['SITE_MANAGER'] });
  assert.deepEqual(await authorizeAccountManagement(ZPL_SITE_MANAGER, deps), {
    authorized: false,
    reason: 'missing_privileged_access',
  });
  assert.deepEqual(await isManageableTarget(MANAGER, ZPL_SITE_MANAGER, deps), { eligible: true });
});

test('a revoked privileged grant no longer authorizes account management', async () => {
  // `resolvePrivilegedAccess` returns only currently-GRANTED roles, so a
  // revoked Site Manager resolves to an empty set here.
  const deps = buildDeps({ [MANAGER]: [] });
  assert.deepEqual(await authorizeAccountManagement(MANAGER, deps), {
    authorized: false,
    reason: 'missing_privileged_access',
  });
});

test('multiple active E-SET Site Managers each hold the same full authority', async () => {
  const deps = buildDeps({ 'site-manager-a': ['SITE_MANAGER'], 'site-manager-b': ['SITE_MANAGER'] });
  for (const manager of ['site-manager-a', 'site-manager-b']) {
    assert.deepEqual(await authorizeAccountManagement(manager, deps), {
      authorized: true,
      roles: new Set(['SITE_MANAGER']),
    });
  }
});

test('a CEO target can never be managed through the normal-employee flow', async () => {
  const deps = buildDeps({ [CEO]: ['CEO'] });
  assert.deepEqual(await isManageableTarget(MANAGER, CEO, deps), {
    eligible: false,
    reason: 'target_is_privileged',
  });
});

test('another Site Manager (protected upper management) can never be managed either', async () => {
  const deps = buildDeps({ 'site-manager-2': ['SITE_MANAGER'] });
  assert.deepEqual(await isManageableTarget(MANAGER, 'site-manager-2', deps), {
    eligible: false,
    reason: 'target_is_privileged',
  });
});

test('a manager cannot act on their own account through the management endpoints', async () => {
  const deps = buildDeps({ [MANAGER]: ['SITE_MANAGER'] });
  assert.deepEqual(await isManageableTarget(MANAGER, MANAGER, deps), {
    eligible: false,
    reason: 'target_is_self',
  });
});

test('a normal employee holding no privileged grant is a manageable target', async () => {
  const deps = buildDeps({});
  assert.deepEqual(await isManageableTarget(MANAGER, EMPLOYEE, deps), { eligible: true });
});

test('protection is derived from privileged grants, not from any client hint', async () => {
  // An account with NO privileged grant is a normal employee, whatever
  // its capabilities, company, team or position name happen to be...
  assert.deepEqual(await isManageableTarget(MANAGER, EMPLOYEE, buildDeps({})), { eligible: true });

  // ...while an account with a privileged grant is protected. Nothing
  // here consults user_metadata, an email, or a name.
  const governed = buildDeps({ [EMPLOYEE]: ['SITE_MANAGER'] });
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
