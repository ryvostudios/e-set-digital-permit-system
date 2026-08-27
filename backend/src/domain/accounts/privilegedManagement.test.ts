import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { QueryFn } from '../../db/pool.js';
import type { PrivilegedAccessAdmin } from '../../db/privilegedPool.js';
import type { AccountAdmin, AccountsServiceDeps } from './service.js';
import {
  createSiteManagerAccount,
  grantSiteManager,
  revokeSiteManager,
} from './privilegedManagement.js';

const CEO = '10000000-0000-4000-8000-000000000001';
const MANAGER = '10000000-0000-4000-8000-000000000002';
const EMPLOYEE = '10000000-0000-4000-8000-000000000003';
const NEW_MANAGER = '10000000-0000-4000-8000-000000000009';

/** A deliberately fake, clearly-labelled test constant - never a real credential. */
const FAKE_TEMPORARY_PASSWORD = 'FAKE-temporary-password-for-tests';

interface PrivilegedEvent {
  user_id: string;
  role: string;
  action: string;
  actor_user_id: string | null;
  reason: string | null;
}

/**
 * An in-memory stand-in for the privileged tables, faithful to the parts
 * that matter: `privileged_access_events` is append-only and status is
 * derived from the LATEST event per (user, role), exactly as
 * `resolvePrivilegedAccess` and migration 0019's guard both do it.
 */
class FakePrivilegedDb {
  accessRows = new Set<string>();
  workforceEmployees = new Set<string>();
  privilegedIdentities = new Map<string, string>();
  events: PrivilegedEvent[] = [];
  authUsers = new Set<string>();
  authCalls: string[] = [];
  failTransaction = false;
  failCompensation = false;
  /** Every statement the service issued, for secret-leak and write-surface assertions. */
  statements: Array<{ sql: string; params: unknown[] }> = [];

  activeRoles(userId: string): Set<string> {
    const latest = new Map<string, string>();
    for (const event of this.events) {
      if (event.user_id === userId) latest.set(event.role, event.action);
    }
    return new Set([...latest].filter(([, action]) => action === 'GRANTED').map(([role]) => role));
  }

  admin: AccountAdmin = {
    createUser: async ({ email, password }) => {
      this.authCalls.push(`create:${email}`);
      assert.equal(password, FAKE_TEMPORARY_PASSWORD);
      if (email === 'taken@example.com') return { ok: false, reason: 'email_unavailable' };
      this.authUsers.add(NEW_MANAGER);
      return { ok: true, userId: NEW_MANAGER };
    },
    setPassword: async () => ({ ok: true }),
    setEmailAndPassword: async () => ({ ok: true as const }),
    deleteUser: async (userId) => {
      this.authCalls.push(`delete:${userId}`);
      if (this.failCompensation) return { ok: false };
      this.authUsers.delete(userId);
      return { ok: true };
    },
  };

  query: QueryFn = (async (text: string, params: unknown[] = []) => {
    const sql = String(text).trim();
    this.statements.push({ sql, params });

    if (sql.startsWith('SELECT user_id FROM app_user_access')) {
      return { rows: this.accessRows.has(String(params[0])) ? [{ user_id: params[0] }] : [] };
    }
    if (sql.includes('FROM privileged_access_events')) {
      const latest = new Map<string, string>();
      for (const event of this.events) {
        if (event.user_id === String(params[0])) latest.set(event.role, event.action);
      }
      return { rows: [...latest].map(([role, action]) => ({ role, action })) };
    }
    if (sql.startsWith('SELECT user_id FROM workforce_profiles')) {
      return { rows: this.workforceEmployees.has(String(params[0])) ? [{ user_id: params[0] }] : [] };
    }
    if (sql.startsWith('SELECT user_id FROM privileged_identities')) {
      return { rows: this.privilegedIdentities.has(String(params[0])) ? [{ user_id: params[0] }] : [] };
    }
    if (sql.startsWith('INSERT INTO app_user_access')) {
      this.accessRows.add(String(params[0]));
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO privileged_identities')) {
      this.privilegedIdentities.set(String(params[0]), String(params[1]));
      return { rows: [] };
    }
    throw new Error(`unhandled query: ${sql}`);
  }) as QueryFn;

  /** Calls made over the SEPARATE privileged database login. */
  privilegedCalls: Array<{ actor: string; target: string; action: string }> = [];
  privilegedUnavailable = false;

  /**
   * Stands in for `db/privilegedPool.ts` talking to migration 0019's
   * SECURITY DEFINER function over the `privileged_runtime` login. It
   * re-derives the actor's CEO status exactly as the real function does,
   * so a service bug cannot slip past it, and it takes no role argument
   * at all - SITE_MANAGER is fixed inside.
   */
  privileged(): PrivilegedAccessAdmin {
    const record = async (actor: string, target: string, action: 'GRANTED' | 'REVOKED') => {
      this.privilegedCalls.push({ actor, target, action });
      if (this.privilegedUnavailable) return { ok: false as const, reason: 'unavailable' as const };
      if (!this.activeRoles(actor).has('CEO')) return { ok: false as const, reason: 'refused' as const };
      if (actor === target) return { ok: false as const, reason: 'refused' as const };
      if (action === 'GRANTED') {
        if (this.workforceEmployees.has(target)) return { ok: false as const, reason: 'refused' as const };
        if (!this.privilegedIdentities.has(target)) return { ok: false as const, reason: 'refused' as const };
      }
      if (this.activeRoles(target).has('CEO')) return { ok: false as const, reason: 'refused' as const };
      this.events.push({
        user_id: target,
        role: 'SITE_MANAGER',
        action,
        actor_user_id: actor,
        reason: action === 'GRANTED' ? 'SITE_MANAGER granted by CEO' : 'SITE_MANAGER revoked by CEO',
      });
      return { ok: true as const };
    };
    return {
      recordSiteManagerGrant: (actor, target) => record(actor, target, 'GRANTED'),
      recordSiteManagerRevoke: (actor, target) => record(actor, target, 'REVOKED'),
    };
  }

  deps(): AccountsServiceDeps {
    return {
      query: this.query,
      admin: this.admin,
      authAdminTimeoutMs: 8_000,
      withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
        if (this.failTransaction) throw new Error('database failure inside the transaction');
        return fn({ query: this.query } as unknown as PoolClient);
      },
    };
  }
}

function seedCeo(db: FakePrivilegedDb): void {
  db.accessRows.add(CEO);
  db.privilegedIdentities.set(CEO, 'Sana Iqbal');
  db.events.push({ user_id: CEO, role: 'CEO', action: 'GRANTED', actor_user_id: null, reason: 'bootstrap' });
}

function seedSiteManager(db: FakePrivilegedDb, userId = MANAGER): void {
  db.accessRows.add(userId);
  db.privilegedIdentities.set(userId, 'Bilal Ahmed');
  db.events.push({ user_id: userId, role: 'SITE_MANAGER', action: 'GRANTED', actor_user_id: CEO, reason: 'seed' });
}

// ---------------------------------------------------------------------
// Establishing a Site Manager
// ---------------------------------------------------------------------

test('a new Site Manager gets a name, a grant and a forced password change - and NO organizational identity', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);

  const result = await createSiteManagerAccount(
    CEO,
    { email: 'manager@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD, displayName: 'Bilal Ahmed' },
    db.deps(),
    db.privileged(),
  );

  assert.deepEqual(result, { outcome: 'ok', userId: NEW_MANAGER });
  assert.equal(db.privilegedIdentities.get(NEW_MANAGER), 'Bilal Ahmed');
  assert.deepEqual([...db.activeRoles(NEW_MANAGER)], ['SITE_MANAGER']);

  // The account owes a password change from the moment it exists.
  const accessInsert = db.statements.find((s) => s.sql.startsWith('INSERT INTO app_user_access'));
  assert.ok(accessInsert?.sql.includes('TRUE'), 'must_change_password is set in the same transaction as the grant');

  // No company, team, position, or workforce profile is fabricated.
  for (const { sql } of db.statements) {
    assert.doesNotMatch(sql, /workforce_profiles|user_team_positions|company_id/i);
  }
  assert.equal(db.workforceEmployees.size, 0);
});

test('the temporary password never reaches PostgreSQL or a returned value', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  const result = await createSiteManagerAccount(
    CEO,
    { email: 'manager@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD, displayName: 'Bilal Ahmed' },
    db.deps(),
    db.privileged(),
  );
  const serialized = JSON.stringify({ result, statements: db.statements });
  assert.ok(!serialized.includes(FAKE_TEMPORARY_PASSWORD), 'no password in any statement, parameter, or result');
});

test('an existing email is refused, never adopted onto the existing Auth identity', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  const result = await createSiteManagerAccount(
    CEO,
    { email: 'taken@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD, displayName: 'Impostor' },
    db.deps(),
    db.privileged(),
  );
  assert.deepEqual(result, { outcome: 'conflict', reason: 'email_unavailable' });
  assert.equal(db.privilegedIdentities.has(NEW_MANAGER), false);
  assert.equal(db.events.filter((e) => e.user_id === NEW_MANAGER).length, 0);
});

test('a database failure after Auth creation is COMPENSATED - no half-privileged account', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  db.failTransaction = true;

  const result = await createSiteManagerAccount(
    CEO,
    { email: 'manager@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD, displayName: 'Bilal Ahmed' },
    db.deps(),
    db.privileged(),
  );
  assert.deepEqual(result, { outcome: 'failed', reason: 'provisioning_rolled_back' });
  assert.ok(db.authCalls.includes(`delete:${NEW_MANAGER}`), 'the Auth identity is removed');
  assert.equal(db.authUsers.has(NEW_MANAGER), false);
  assert.equal(db.activeRoles(NEW_MANAGER).size, 0, 'no privilege survives a failed provisioning');
});

test('when compensation itself fails the orphan is reported and still holds NO privilege', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  db.failTransaction = true;
  db.failCompensation = true;

  const result = await createSiteManagerAccount(
    CEO,
    { email: 'manager@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD, displayName: 'Bilal Ahmed' },
    db.deps(),
    db.privileged(),
  );
  assert.deepEqual(result, {
    outcome: 'failed',
    reason: 'provisioning_orphan_requires_operator',
    orphanUserId: NEW_MANAGER,
  });
  // The orphan has no app_user_access row, so it can reach nothing.
  assert.equal(db.accessRows.has(NEW_MANAGER), false);
  assert.equal(db.activeRoles(NEW_MANAGER).size, 0);
});

// ---------------------------------------------------------------------
// Grant / revoke
// ---------------------------------------------------------------------

test('a revoked Site Manager can be re-granted, and the log stays append-only', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  seedSiteManager(db);

  assert.deepEqual(await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged()), { outcome: 'ok' });
  assert.equal(db.activeRoles(MANAGER).has('SITE_MANAGER'), false);

  assert.deepEqual(await grantSiteManager(CEO, MANAGER, db.deps(), db.privileged()), { outcome: 'ok' });
  assert.equal(db.activeRoles(MANAGER).has('SITE_MANAGER'), true);

  // Three rows: the seed, the revoke, the re-grant. Nothing was edited.
  assert.deepEqual(
    db.events.filter((e) => e.user_id === MANAGER).map((e) => e.action),
    ['GRANTED', 'REVOKED', 'GRANTED'],
  );
  // Every change records who made it.
  for (const event of db.events.filter((e) => e.user_id === MANAGER).slice(1)) {
    assert.equal(event.actor_user_id, CEO);
  }
});

test('revoking leaves the account and its identity intact - only authority is withdrawn', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  seedSiteManager(db);
  await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged());
  assert.equal(db.accessRows.has(MANAGER), true, 'the login survives');
  assert.equal(db.privilegedIdentities.get(MANAGER), 'Bilal Ahmed', 'the name survives');
});

test('a normal workforce employee can NEVER be granted SITE_MANAGER', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  db.accessRows.add(EMPLOYEE);
  db.workforceEmployees.add(EMPLOYEE);
  db.privilegedIdentities.set(EMPLOYEE, 'Should Not Matter');

  assert.deepEqual(await grantSiteManager(CEO, EMPLOYEE, db.deps(), db.privileged()), {
    outcome: 'refused',
    reason: 'target_is_employee',
  });
  assert.equal(db.activeRoles(EMPLOYEE).size, 0);
  // Nothing was deleted or converted to make the grant succeed.
  assert.ok(db.workforceEmployees.has(EMPLOYEE));
  for (const { sql } of db.statements) {
    assert.doesNotMatch(sql, /DELETE|UPDATE workforce_profiles|UPDATE user_team_positions/i);
  }
});

test('a bare Auth id with no privileged identity cannot be handed privilege by identifier alone', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  db.accessRows.add(MANAGER); // has an account, but no privileged identity row
  assert.deepEqual(await grantSiteManager(CEO, MANAGER, db.deps(), db.privileged()), { outcome: 'not_found' });
  assert.equal(db.activeRoles(MANAGER).size, 0);
});

test('an unknown target is not found, and a redundant change is a conflict not a silent success', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  assert.deepEqual(await grantSiteManager(CEO, NEW_MANAGER, db.deps(), db.privileged()), { outcome: 'not_found' });

  seedSiteManager(db);
  assert.deepEqual(await grantSiteManager(CEO, MANAGER, db.deps(), db.privileged()), {
    outcome: 'refused',
    reason: 'already_in_requested_state',
  });
  await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged());
  assert.deepEqual(await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged()), {
    outcome: 'refused',
    reason: 'already_in_requested_state',
  });
});

test('the CEO tier is unreachable from the Site Manager endpoints', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  const otherCeo = '10000000-0000-4000-8000-00000000000c';
  db.accessRows.add(otherCeo);
  db.privilegedIdentities.set(otherCeo, 'Another CEO');
  db.events.push({ user_id: otherCeo, role: 'CEO', action: 'GRANTED', actor_user_id: null, reason: 'seed' });

  assert.deepEqual(await revokeSiteManager(CEO, otherCeo, db.deps(), db.privileged()), {
    outcome: 'refused',
    reason: 'target_is_ceo',
  });
  assert.equal(db.activeRoles(otherCeo).has('CEO'), true);

  // And no statement this service issues can ever write a CEO grant.
  for (const { sql } of db.statements) {
    assert.doesNotMatch(sql, /INSERT INTO privileged_access_events[^]*'CEO'/i);
  }
});

test('a CEO cannot change their own privileged role here', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  assert.deepEqual(await grantSiteManager(CEO, CEO, db.deps(), db.privileged()), { outcome: 'refused', reason: 'target_is_self' });
  assert.deepEqual(await revokeSiteManager(CEO, CEO, db.deps(), db.privileged()), { outcome: 'refused', reason: 'target_is_self' });
});

test('multiple Site Managers are active concurrently, each with the same authority', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  const managerB = '10000000-0000-4000-8000-00000000000b';
  seedSiteManager(db, MANAGER);
  seedSiteManager(db, managerB);

  for (const manager of [MANAGER, managerB]) {
    assert.deepEqual([...db.activeRoles(manager)], ['SITE_MANAGER']);
  }
  // Revoking one leaves the other entirely unaffected.
  await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged());
  assert.equal(db.activeRoles(MANAGER).has('SITE_MANAGER'), false);
  assert.equal(db.activeRoles(managerB).has('SITE_MANAGER'), true);
});

test('the ordinary database connection NEVER touches privileged authority', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  seedSiteManager(db);
  await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged());
  await grantSiteManager(CEO, MANAGER, db.deps(), db.privileged());

  // Nothing this service sends over the app_runtime connection may write
  // or invoke privileged authority. That credential has neither INSERT on
  // the grant log nor EXECUTE on the hardened function, so a statement
  // here would simply fail in production - and must not exist at all.
  for (const { sql } of db.statements) {
    assert.doesNotMatch(sql, /INSERT\s+INTO\s+privileged_access_events/i);
    assert.doesNotMatch(sql, /record_site_manager_grant/i);
  }

  // Every event travelled over the separate privileged login instead.
  assert.deepEqual(db.privilegedCalls, [
    { actor: CEO, target: MANAGER, action: 'REVOKED' },
    { actor: CEO, target: MANAGER, action: 'GRANTED' },
  ]);
  // The adapter's surface carries no role argument at all.
  for (const call of db.privilegedCalls) {
    assert.deepEqual(Object.keys(call).sort(), ['action', 'actor', 'target']);
  }
});

test('a missing privileged channel fails closed - no event, no partial state', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  seedSiteManager(db);
  db.privilegedUnavailable = true;

  assert.deepEqual(await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged()), {
    outcome: 'failed',
    reason: 'grant_write_failed',
  });
  // Authority is unchanged: failing to reach the channel never withdraws
  // or confers anything.
  assert.equal(db.activeRoles(MANAGER).has('SITE_MANAGER'), true);
});

test('creating a Site Manager whose grant does not land leaves an account with NO authority', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  db.privilegedUnavailable = true;

  const result = await createSiteManagerAccount(
    CEO,
    { email: 'manager@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD, displayName: 'Bilal Ahmed' },
    db.deps(),
    db.privileged(),
  );
  assert.deepEqual(result, { outcome: 'failed', reason: 'grant_not_recorded', userId: NEW_MANAGER });

  // The reachable state has LESS authority than intended, never more: a
  // named identity that confers nothing, owing a password change.
  assert.equal(db.privilegedIdentities.get(NEW_MANAGER), 'Bilal Ahmed');
  assert.equal(db.activeRoles(NEW_MANAGER).size, 0);
  // The Auth identity is kept - the failure is retryable through grant.
  assert.equal(db.authUsers.has(NEW_MANAGER), true);
});

test('the service cannot mint a CEO even if it tried - the role is not a parameter', async () => {
  const db = new FakePrivilegedDb();
  seedCeo(db);
  seedSiteManager(db);
  await grantSiteManager(CEO, MANAGER, db.deps(), db.privileged());
  await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged());
  // Every event this module produced is a SITE_MANAGER event.
  const written = db.events.filter((e) => e.actor_user_id === CEO);
  assert.ok(written.length > 0);
  for (const event of written) assert.equal(event.role, 'SITE_MANAGER');
});

test('a non-CEO actor is refused by the function itself, not merely by the route', async () => {
  // Defence in depth: even if the HTTP CEO gate were bypassed, the
  // database function re-derives the actor's CEO status and refuses.
  const db = new FakePrivilegedDb();
  seedCeo(db);
  seedSiteManager(db);
  const impostor = '10000000-0000-4000-8000-00000000000f';
  db.accessRows.add(impostor);
  db.privilegedIdentities.set(impostor, 'Impostor');
  const result = await grantSiteManager(impostor, MANAGER, db.deps(), db.privileged());
  assert.deepEqual(result, { outcome: 'refused', reason: 'already_in_requested_state' });

  await revokeSiteManager(CEO, MANAGER, db.deps(), db.privileged());
  assert.deepEqual(await grantSiteManager(impostor, MANAGER, db.deps(), db.privileged()), {
    outcome: 'failed',
    reason: 'grant_write_failed',
  });
  assert.equal(db.activeRoles(MANAGER).has('SITE_MANAGER'), false);
});
