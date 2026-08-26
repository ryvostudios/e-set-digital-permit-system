import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { QueryFn } from '../../db/pool.js';
import {
  changeOwnPassword,
  credentialResetTransactionTimeouts,
  createEmployeeAccount,
  resetEmployeePassword,
  type AccountAdmin,
  type AccountsServiceDeps,
} from './service.js';
import { createTimeoutFetch } from '../../lib/timeoutFetch.js';

const MANAGER = '10000000-0000-4000-8000-000000000002';
const NEW_USER = '10000000-0000-4000-8000-000000000009';
const EMPLOYEE = '10000000-0000-4000-8000-000000000003';
const TEAM_POSITION = '40000000-0000-4000-8000-000000000001';
const COMPANY_ID = '18000000-0000-4000-8000-000000000001';

/** A deliberately fake, clearly-labelled test constant - never a real credential. */
const FAKE_TEMPORARY_PASSWORD = 'FAKE-temporary-password-for-tests';
const FAKE_NEW_PASSWORD = 'FAKE-chosen-password-for-tests';

interface FakeAuthCall {
  op: 'createUser' | 'setPassword' | 'deleteUser';
  userId?: string;
}

/**
 * An in-memory stand-in for the two systems this domain spans, recording
 * exactly what was written where - so a test can assert not only the
 * outcome but that no password ever reached PostgreSQL.
 */
class FakeAccounts {
  authUsers = new Map<string, { email: string; password: string }>();
  accessRows = new Map<string, {
    state: string;
    must_change_password: boolean;
    credentials_changed_at: string | null;
    credential_version?: number;
    credential_reset_pending?: boolean;
  }>();
  assignments: Array<{ user_id: string; team_position_id: string }> = [];
  profiles: Array<{
    user_id: string;
    display_name: string;
    primary_team_position_id: string;
    company_id: string;
  }> = [];
  auditRows: Array<{ event_type: string; actor_user_id: string; target_user_id: string }> = [];
  authCalls: FakeAuthCall[] = [];
  /** Every SQL statement and every bound parameter the service sent to PostgreSQL. */
  statements: Array<{ sql: string; params: unknown[] }> = [];
  timeline: string[] = [];

  failDbAfterAuth = false;
  failGateTransaction = false;
  failAudit = false;
  failAuthCreate: 'email_unavailable' | 'failed' | null = null;
  failSetPassword = false;
  failDeleteUser = false;
  nextUserId = NEW_USER;
  beforeSetPassword: (() => Promise<void>) | null = null;
  afterGateCommit: (() => Promise<void>) | null = null;

  admin: AccountAdmin = {
    createUser: async (input) => {
      this.authCalls.push({ op: 'createUser' });
      if (this.failAuthCreate) return { ok: false, reason: this.failAuthCreate };
      if ([...this.authUsers.values()].some((user) => user.email === input.email)) {
        return { ok: false, reason: 'email_unavailable' };
      }
      this.authUsers.set(this.nextUserId, { email: input.email, password: input.password });
      return { ok: true, userId: this.nextUserId };
    },
    setPassword: async (userId, password) => {
      this.timeline.push('auth:setPassword');
      if (this.beforeSetPassword) {
        const hook = this.beforeSetPassword;
        this.beforeSetPassword = null;
        await hook();
      }
      this.authCalls.push({ op: 'setPassword', userId });
      if (this.failSetPassword) return { ok: false };
      const existing = this.authUsers.get(userId);
      if (existing) this.authUsers.set(userId, { ...existing, password });
      return { ok: true };
    },
    deleteUser: async (userId) => {
      this.authCalls.push({ op: 'deleteUser', userId });
      if (this.failDeleteUser) return { ok: false };
      this.authUsers.delete(userId);
      return { ok: true };
    },
  };

  private run = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const sql = text.trim();
    this.statements.push({ sql, params });

    if (sql.startsWith("SELECT set_config('lock_timeout'")) {
      return { rows: [{}] };
    }

    if (sql.startsWith('SELECT user_id') && sql.includes('FROM app_user_access')) {
      const row = this.accessRows.get(String(params[0]));
      return { rows: row ? [{ user_id: params[0] }] : [] };
    }
    if (sql.startsWith('INSERT INTO app_user_access')) {
      if (this.failDbAfterAuth) throw new Error('simulated database failure during provisioning');
      const userId = String(params[0]);
      if (this.accessRows.has(userId)) throw new Error('duplicate app_user_access row');
      this.accessRows.set(userId, {
        state: 'ACTIVE', must_change_password: true, credentials_changed_at: 'db-now',
        credential_version: 0, credential_reset_pending: false,
      });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO user_team_positions')) {
      this.assignments.push({ user_id: String(params[0]), team_position_id: String(params[1]) });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO workforce_profiles')) {
      this.profiles.push({
        user_id: String(params[0]),
        display_name: String(params[1]),
        primary_team_position_id: String(params[2]),
        company_id: String(params[3]),
      });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO account_audit_events')) {
      if (this.failAudit) throw new Error('simulated audit failure');
      this.auditRows.push({
        event_type: String(params[0]),
        actor_user_id: String(params[1]),
        target_user_id: String(params[2]),
      });
      return { rows: [] };
    }
    if (sql.includes('FROM privileged_access_events')) {
      return { rows: [{ protected: false }] };
    }
    if (sql.startsWith('SELECT credential_version::text AS credential_version')) {
      const row = this.accessRows.get(String(params[0]));
      return { rows: row ? [{
        credential_version: String(row.credential_version ?? 0),
        credential_reset_pending: row.credential_reset_pending ?? false,
      }] : [] };
    }
    if (sql.startsWith('UPDATE app_user_access') && sql.includes('credential_version = credential_version + 1')) {
      if (this.failGateTransaction) throw new Error('simulated gate transaction failure');
      const userId = String(params[0]);
      const row = this.accessRows.get(userId);
      if (!row) return { rows: [] };
      const version = (row.credential_version ?? 0) + 1;
      this.accessRows.set(userId, {
        ...row,
        must_change_password: true,
        credential_reset_pending: true,
        credential_version: version,
        credentials_changed_at: 'db-now',
      });
      this.timeline.push('db:gate');
      return { rows: [{ credential_version: String(version) }] };
    }
    if (sql.startsWith('UPDATE app_user_access') && sql.includes('credential_reset_pending = FALSE') && !sql.includes('must_change_password')) {
      const userId = String(params[0]);
      const row = this.accessRows.get(userId);
      if (!row || String(row.credential_version ?? 0) !== String(params[1])) return { rows: [] };
      this.accessRows.set(userId, { ...row, credential_reset_pending: false });
      return { rows: [{ user_id: userId }] };
    }
    if (sql.startsWith('UPDATE app_user_access')) {
      if (this.failDbAfterAuth) throw new Error('simulated database failure updating account state');
      const userId = String(params[0]);
      const row = this.accessRows.get(userId);
      if (!row || String(row.credential_version ?? 0) !== String(params[1])) return { rows: [] };
      this.accessRows.set(userId, {
        ...row,
        must_change_password: false,
        credentials_changed_at: 'db-now',
      });
      return { rows: [{ user_id: userId }] };
    }
    throw new Error(`FakeAccounts: unhandled query: ${sql}`);
  };

  deps(): AccountsServiceDeps {
    const query = this.run as unknown as QueryFn;
    return {
      query,
      admin: this.admin,
      authAdminTimeoutMs: 8_000,
      withTransaction: (async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
        // Minimal rollback simulation: snapshot the stores, restore on throw.
        const access = new Map(this.accessRows);
        const assignments = [...this.assignments];
        const profiles = [...this.profiles];
        const audit = [...this.auditRows];
        const gateEventsBefore = this.timeline.filter((entry) => entry === 'db:gate').length;
        try {
          const result = await fn({ query: this.run } as unknown as PoolClient);
          this.timeline.push('db:tx_end');
          const gateEventsAfter = this.timeline.filter((entry) => entry === 'db:gate').length;
          if (gateEventsAfter > gateEventsBefore && this.afterGateCommit) {
            const hook = this.afterGateCommit;
            this.afterGateCommit = null;
            await hook();
          }
          return result;
        } catch (err) {
          this.accessRows = access;
          this.assignments = assignments;
          this.profiles = profiles;
          this.auditRows = audit;
          throw err;
        }
      }) as AccountsServiceDeps['withTransaction'],
    };
  }

  /** Every value this service ever sent to PostgreSQL, flattened. */
  allBoundParameters(): string[] {
    return this.statements.flatMap((statement) => statement.params.map((param) => String(param)));
  }
}

test('provisioning creates the Auth identity, access row, assignment, profile and audit atomically', async () => {
  const db = new FakeAccounts();
  const result = await createEmployeeAccount(
    MANAGER,
    {
      email: 'employee@example.com',
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
      displayName: 'Ayesha Khan',
      companyId: COMPANY_ID,
      teamPositionId: TEAM_POSITION,
    },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'ok', userId: NEW_USER });
  assert.equal(db.accessRows.get(NEW_USER)?.state, 'ACTIVE');
  assert.equal(db.accessRows.get(NEW_USER)?.must_change_password, true, 'a provisioned account owes a password change');
  assert.deepEqual(db.assignments, [{ user_id: NEW_USER, team_position_id: TEAM_POSITION }]);
  assert.deepEqual(db.profiles, [
    {
      user_id: NEW_USER,
      display_name: 'Ayesha Khan',
      primary_team_position_id: TEAM_POSITION,
      company_id: COMPANY_ID,
    },
  ]);
  assert.equal(db.profiles[0]?.company_id, COMPANY_ID);
  // The profile's primary assignment is exactly the assignment created
  // for the same user - migration 0016's composite foreign key can never
  // be violated by this flow.
  assert.equal(db.profiles[0]?.primary_team_position_id, db.assignments[0]?.team_position_id);
  assert.equal(db.profiles[0]?.user_id, db.assignments[0]?.user_id);
  assert.deepEqual(db.auditRows, [
    { event_type: 'EMPLOYEE_ACCOUNT_CREATED', actor_user_id: MANAGER, target_user_id: NEW_USER },
  ]);
});

test('the temporary password is never written to PostgreSQL, in any statement', async () => {
  const db = new FakeAccounts();
  await createEmployeeAccount(
    MANAGER,
    {
      email: 'employee@example.com',
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
      displayName: 'Ayesha Khan',
      companyId: COMPANY_ID,
      teamPositionId: TEAM_POSITION,
    },
    db.deps(),
  );

  const bound = db.allBoundParameters();
  assert.ok(bound.length > 0);
  assert.ok(!bound.includes(FAKE_TEMPORARY_PASSWORD), 'no bound parameter carries the password');
  for (const statement of db.statements) {
    assert.ok(!statement.sql.includes(FAKE_TEMPORARY_PASSWORD), 'no SQL text carries the password');
  }
  // It reached Supabase Auth and nowhere else.
  assert.equal(db.authUsers.get(NEW_USER)?.password, FAKE_TEMPORARY_PASSWORD);
});

test('a database failure after Auth creation is COMPENSATED - no half-provisioned account survives', async () => {
  const db = new FakeAccounts();
  db.failDbAfterAuth = true;

  const result = await createEmployeeAccount(
    MANAGER,
    {
      email: 'employee@example.com',
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
      displayName: 'Ayesha Khan',
      companyId: COMPANY_ID,
      teamPositionId: TEAM_POSITION,
    },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'failed', reason: 'provisioning_rolled_back' });
  assert.equal(db.authUsers.size, 0, 'the Auth identity was deleted');
  assert.equal(db.accessRows.size, 0);
  assert.equal(db.assignments.length, 0);
  assert.equal(db.profiles.length, 0);
  assert.equal(db.auditRows.length, 0, 'no audit row claims an account was created');
  assert.deepEqual(db.authCalls.map((call) => call.op), ['createUser', 'deleteUser']);
});

test('when compensation itself fails, the orphan is reported and still has NO application access', async () => {
  const db = new FakeAccounts();
  db.failDbAfterAuth = true;
  db.failDeleteUser = true;

  const result = await createEmployeeAccount(
    MANAGER,
    {
      email: 'employee@example.com',
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
      displayName: 'Ayesha Khan',
      companyId: COMPANY_ID,
      teamPositionId: TEAM_POSITION,
    },
    db.deps(),
  );

  assert.deepEqual(result, {
    outcome: 'failed',
    reason: 'provisioning_orphan_requires_operator',
    orphanUserId: NEW_USER,
  });
  // The Auth identity exists, but `requireAuth` fails closed on a missing
  // app_user_access row - so it can reach no application endpoint.
  assert.equal(db.authUsers.has(NEW_USER), true);
  assert.equal(db.accessRows.has(NEW_USER), false, 'no application access row exists for the orphan');
});

test('an existing email is refused, never adopted onto the existing Auth identity', async () => {
  const db = new FakeAccounts();
  db.failAuthCreate = 'email_unavailable';

  const result = await createEmployeeAccount(
    MANAGER,
    {
      email: 'ceo@example.com',
      temporaryPassword: FAKE_TEMPORARY_PASSWORD,
      displayName: 'Impostor',
      companyId: COMPANY_ID,
      teamPositionId: TEAM_POSITION,
    },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'email_unavailable' });
  assert.equal(db.accessRows.size, 0);
  assert.equal(db.profiles.length, 0);
  // Only the creation attempt happened - no lookup that could reconcile
  // onto somebody else's identity, and no state written.
  assert.deepEqual(db.authCalls.map((call) => call.op), ['createUser']);
});

test('a duplicate provisioning race cannot create two accounts for one email', async () => {
  const db = new FakeAccounts();
  const input = {
    email: 'employee@example.com',
    temporaryPassword: FAKE_TEMPORARY_PASSWORD,
    displayName: 'Ayesha Khan',
    companyId: COMPANY_ID,
    teamPositionId: TEAM_POSITION,
  };

  const first = await createEmployeeAccount(MANAGER, input, db.deps());
  assert.equal(first.outcome, 'ok');

  // The second attempt hits Supabase Auth's own uniqueness on email.
  const second = await createEmployeeAccount(MANAGER, input, db.deps());
  assert.deepEqual(second, { outcome: 'conflict', reason: 'email_unavailable' });
  assert.equal(db.authUsers.size, 1);
  assert.equal(db.accessRows.size, 1);
  assert.equal(db.profiles.length, 1);
});

test('a manager reset sets the new Auth password, forces a change, and audits without the secret', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: 'FAKE-old' });
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });

  const result = await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, db.deps());

  assert.deepEqual(result, { outcome: 'ok' });
  assert.equal(db.authUsers.get(EMPLOYEE)?.password, FAKE_TEMPORARY_PASSWORD);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true);
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_version, 1);
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_reset_pending, false);
  assert.equal(db.accessRows.get(EMPLOYEE)?.credentials_changed_at, 'db-now', 'credential state advanced');
  assert.deepEqual(db.auditRows, [
    { event_type: 'EMPLOYEE_PASSWORD_RESET_BY_MANAGER', actor_user_id: MANAGER, target_user_id: EMPLOYEE },
  ]);
  assert.ok(!db.allBoundParameters().includes(FAKE_TEMPORARY_PASSWORD));
  assert.ok(
    db.timeline.indexOf('db:tx_end') < db.timeline.indexOf('auth:setPassword'),
    'the forced gate transaction commits before Auth is touched',
  );
});

test('a failed manager-reset gate transaction never calls Supabase Auth', async () => {
  const db = new FakeAccounts();
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });
  db.failGateTransaction = true;

  assert.deepEqual(
    await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, db.deps()),
    { outcome: 'failed', reason: 'state_update_failed' },
  );
  assert.equal(db.authCalls.length, 0);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, false);
});

test('resetting an account that was never provisioned into this application is a plain not-found', async () => {
  const db = new FakeAccounts();
  const result = await resetEmployeePassword(MANAGER, 'never-provisioned', FAKE_TEMPORARY_PASSWORD, db.deps());
  assert.deepEqual(result, { outcome: 'not_found' });
  // Nothing was attempted against Auth, so this cannot be used to probe
  // Supabase for identities.
  assert.equal(db.authCalls.length, 0);
});

test('a failed Auth update after reset gating leaves the employee safely gated', async () => {
  const db = new FakeAccounts();
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });
  db.failSetPassword = true;

  const result = await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, db.deps());
  assert.deepEqual(result, { outcome: 'failed', reason: 'auth_update_failed' });
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true);
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_reset_pending, true);
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_version, 1);
  assert.equal(db.auditRows.length, 0);
});

test('an aborted Auth Admin timeout leaves the reset gate committed and retry-safe', async () => {
  const db = new FakeAccounts();
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });
  let actualFetchWasAborted = false;
  db.admin.setPassword = async () => {
    const stalledFetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          actualFetchWasAborted = true;
          reject(init.signal?.reason);
        }, { once: true });
      })) as typeof fetch;
    try {
      await createTimeoutFetch(stalledFetch, 20)('https://example.invalid/auth/v1/admin/users');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  const result = await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, db.deps());

  assert.deepEqual(result, { outcome: 'failed', reason: 'auth_update_failed' });
  assert.equal(actualFetchWasAborted, true);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true);
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_reset_pending, true);
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_version, 1);
  assert.equal(db.auditRows.length, 0);
});

test('manager reset applies transaction-local lock/statement/idle guards before taking the serialization lock', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: 'FAKE-old' });
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });

  assert.deepEqual(await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, db.deps()), { outcome: 'ok' });

  const guardIndex = db.statements.findIndex(({ sql }) => sql.startsWith("SELECT set_config('lock_timeout'"));
  const phaseBLockIndex = db.statements.findIndex(
    ({ sql }, index) => index > guardIndex && sql.startsWith('SELECT credential_version::text') && sql.includes('FOR UPDATE'),
  );
  assert.ok(guardIndex >= 0);
  assert.ok(phaseBLockIndex > guardIndex);
  assert.deepEqual(db.statements[guardIndex]?.params, ['2000ms', '13000ms', '10000ms']);
  assert.deepEqual(credentialResetTransactionTimeouts(8_000), {
    lockTimeoutMs: 2_000,
    statementTimeoutMs: 13_000,
    idleInTransactionTimeoutMs: 10_000,
  });
});

test('an audit failure after successful Auth reset never reopens application access', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: 'FAKE-old' });
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });
  db.failAudit = true;

  const result = await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, db.deps());
  assert.deepEqual(result, { outcome: 'failed', reason: 'state_update_failed' });
  assert.equal(db.authUsers.get(EMPLOYEE)?.password, FAKE_TEMPORARY_PASSWORD, 'Auth did change');
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true, 'the committed gate survives');
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_reset_pending, true, 'retry remains explicitly required');
  assert.equal(db.auditRows.length, 0);
});

test('a self-change that started before a manager reset cannot clear the newer reset generation', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: FAKE_TEMPORARY_PASSWORD });
  db.accessRows.set(EMPLOYEE, {
    state: 'ACTIVE', must_change_password: true, credentials_changed_at: null,
    credential_version: 0, credential_reset_pending: false,
  });
  db.beforeSetPassword = async () => {
    const reset = await resetEmployeePassword(MANAGER, EMPLOYEE, 'FAKE-newer-manager-password', db.deps());
    assert.deepEqual(reset, { outcome: 'ok' });
  };

  const changed = await changeOwnPassword(EMPLOYEE, FAKE_NEW_PASSWORD, db.deps());
  assert.deepEqual(changed, { outcome: 'failed', reason: 'credential_operation_superseded' });
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_version, 1);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true);
  assert.equal(db.auditRows.filter((row) => row.event_type === 'EMPLOYEE_PASSWORD_CHANGED').length, 0);
});

test('a self-change cannot start while a manager reset operation is pending', async () => {
  const db = new FakeAccounts();
  db.accessRows.set(EMPLOYEE, {
    state: 'ACTIVE', must_change_password: true, credentials_changed_at: null,
    credential_version: 4, credential_reset_pending: true,
  });

  assert.deepEqual(
    await changeOwnPassword(EMPLOYEE, FAKE_NEW_PASSWORD, db.deps()),
    { outcome: 'failed', reason: 'manager_reset_in_progress' },
  );
  assert.equal(db.authCalls.length, 0);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true);
});

test('two racing manager resets preserve the newest credential generation and password', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: 'FAKE-old' });
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });
  let newer: Awaited<ReturnType<typeof resetEmployeePassword>> | undefined;
  db.afterGateCommit = async () => {
    newer = await resetEmployeePassword(MANAGER, EMPLOYEE, 'FAKE-newest-manager-password', db.deps());
  };

  const older = await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, db.deps());
  assert.deepEqual(newer, { outcome: 'ok' });
  assert.deepEqual(older, { outcome: 'failed', reason: 'credential_operation_superseded' });
  assert.equal(db.accessRows.get(EMPLOYEE)?.credential_version, 2);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true);
  assert.equal(db.authUsers.get(EMPLOYEE)?.password, 'FAKE-newest-manager-password');
});

test('self-service change clears the forced flag and audits the account as its own actor', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: FAKE_TEMPORARY_PASSWORD });
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: true, credentials_changed_at: 'earlier' });

  const result = await changeOwnPassword(EMPLOYEE, FAKE_NEW_PASSWORD, db.deps());

  assert.deepEqual(result, { outcome: 'ok' });
  assert.equal(db.authUsers.get(EMPLOYEE)?.password, FAKE_NEW_PASSWORD);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, false);
  assert.deepEqual(db.auditRows, [
    { event_type: 'EMPLOYEE_PASSWORD_CHANGED', actor_user_id: EMPLOYEE, target_user_id: EMPLOYEE },
  ]);
  assert.ok(!db.allBoundParameters().includes(FAKE_NEW_PASSWORD), 'the chosen password never reaches PostgreSQL');
  // Only the caller's own identity was ever touched.
  assert.deepEqual(db.authCalls, [{ op: 'setPassword', userId: EMPLOYEE }]);
});

test('a state-update failure after a successful Auth change leaves a SAFE, recoverable state', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: FAKE_TEMPORARY_PASSWORD });
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: true, credentials_changed_at: null });
  db.failDbAfterAuth = true;

  const result = await changeOwnPassword(EMPLOYEE, FAKE_NEW_PASSWORD, db.deps());

  assert.deepEqual(result, { outcome: 'failed', reason: 'state_update_failed' });
  // The password DID change, and the account still owes a change - so
  // access stays withheld (fail-closed) and the user can simply retry
  // with the password they just chose. The dangerous inverse - normal
  // access restored for a password that never changed - is impossible.
  assert.equal(db.authUsers.get(EMPLOYEE)?.password, FAKE_NEW_PASSWORD);
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, true);
  assert.equal(db.auditRows.length, 0, 'no audit row claims a completed change');

  // Retrying is idempotent and recovers fully.
  db.failDbAfterAuth = false;
  assert.deepEqual(await changeOwnPassword(EMPLOYEE, FAKE_NEW_PASSWORD, db.deps()), { outcome: 'ok' });
  assert.equal(db.accessRows.get(EMPLOYEE)?.must_change_password, false);
});

test('changeOwnPassword has no target parameter - it can only ever act on the caller', async () => {
  const db = new FakeAccounts();
  db.authUsers.set(EMPLOYEE, { email: 'employee@example.com', password: FAKE_TEMPORARY_PASSWORD });
  db.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: true, credentials_changed_at: null });
  db.authUsers.set(MANAGER, { email: 'manager@example.com', password: 'FAKE-manager' });
  db.accessRows.set(MANAGER, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });

  await changeOwnPassword(EMPLOYEE, FAKE_NEW_PASSWORD, db.deps());

  assert.equal(db.authUsers.get(MANAGER)?.password, 'FAKE-manager', "another account's credential is untouched");
  assert.equal(db.accessRows.get(MANAGER)?.must_change_password, false);
  assert.equal(changeOwnPassword.length, 3, 'signature is (userId, newPassword, deps) - no target argument exists');
});

test('no password ever reaches a log line, even on the orphan-compensation path', async () => {
  const captured: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  console.log = (...args: unknown[]) => { captured.push(args.map(String).join(' ')); };
  try {
    const db = new FakeAccounts();
    db.failDbAfterAuth = true;
    db.failDeleteUser = true;
    await createEmployeeAccount(
      MANAGER,
      {
        email: 'employee@example.com',
        temporaryPassword: FAKE_TEMPORARY_PASSWORD,
        displayName: 'Ayesha Khan',
        companyId: COMPANY_ID,
        teamPositionId: TEAM_POSITION,
      },
      db.deps(),
    );

    const resetDb = new FakeAccounts();
    resetDb.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: false, credentials_changed_at: null });
    resetDb.failDbAfterAuth = true;
    await resetEmployeePassword(MANAGER, EMPLOYEE, FAKE_TEMPORARY_PASSWORD, resetDb.deps());

    const changeDb = new FakeAccounts();
    changeDb.accessRows.set(EMPLOYEE, { state: 'ACTIVE', must_change_password: true, credentials_changed_at: null });
    changeDb.failDbAfterAuth = true;
    await changeOwnPassword(EMPLOYEE, FAKE_NEW_PASSWORD, changeDb.deps());
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }

  const logged = captured.join('\n');
  assert.ok(!logged.includes(FAKE_TEMPORARY_PASSWORD), 'a temporary password must never be logged');
  assert.ok(!logged.includes(FAKE_NEW_PASSWORD), 'a chosen password must never be logged');
});
