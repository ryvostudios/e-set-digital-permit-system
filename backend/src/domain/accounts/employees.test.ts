import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { QueryFn } from '../../db/pool.js';
import type { AccountsServiceDeps } from './service.js';
import {
  changeEmployeeEmail,
  deleteEmployeeAccount,
  setEmployeeAccountState,
  transferEmployee,
  updateEmployeeDisplayName,
} from './employees.js';
import { verifyPassword } from '../auth/passwords.js';
import { setUserCapabilityGrant } from './userPermissions.js';

const CEO = '30000000-0000-4000-8000-000000000001';
const MANAGER = '30000000-0000-4000-8000-000000000002';
const EMPLOYEE = '30000000-0000-4000-8000-000000000003';
const PRIVILEGED = '30000000-0000-4000-8000-000000000004';

const E_SET = '18000000-0000-4000-8000-000000000001';
const ZPL = '18000000-0000-4000-8000-000000000002';
const TP_CIVIL_WORKER = '40000000-0000-4000-8000-000000000001';
const TP_WTG_TECH = '40000000-0000-4000-8000-000000000002';
const TP_ZPL_ENGINEER = '40000000-0000-4000-8000-000000000003';
const TP_NOT_ASSIGNABLE = '40000000-0000-4000-8000-000000000004';
const VIEW_ALL = '50000000-0000-4000-8000-000000000001';

/** A deliberately fake, clearly-labelled test constant - never a real credential. */
const FAKE_TEMPORARY_PASSWORD = 'FAKE-temporary-password-for-tests';

interface Assignment { user_id: string; team_position_id: string; ended_at: string | null }

/**
 * An in-memory stand-in faithful to the parts that decide safety: the
 * one-current-assignment rule, the append-only grant log, the terminal
 * DELETED state, and the credential generation the reset/email paths
 * serialize on.
 */
class FakeEmployeeDb {
  access = new Map<string, {
    state: 'ACTIVE' | 'DISABLED' | 'DELETED';
    must_change_password: boolean;
    credential_version: number;
    credential_reset_pending: boolean;
  }>();
  profiles = new Map<string, { company_id: string; primary_team_position_id: string; display_name: string }>();
  assignments: Assignment[] = [];
  privilegedUsers = new Set<string>();
  audit: Array<{ event_type: string; actor: string; target: string; params: unknown[] }> = [];
  grants: Array<{ user_id: string; capability_id: string; action: string; actor_user_id: string }> = [];
  authUsers = new Map<string, { email: string; password: string }>();
  authCalls: string[] = [];
  statements: Array<{ sql: string; params: unknown[] }> = [];
  failAuthEmail: 'email_unavailable' | 'failed' | null = null;
  failAuthDelete = false;
  failTransaction = false;
  /** Team + Position -> owning company, and whether provisioning may use it. */
  teamPositions = new Map<string, { company_id: string; assignable: boolean }>([
    [TP_CIVIL_WORKER, { company_id: E_SET, assignable: true }],
    [TP_WTG_TECH, { company_id: E_SET, assignable: true }],
    [TP_ZPL_ENGINEER, { company_id: ZPL, assignable: true }],
    [TP_NOT_ASSIGNABLE, { company_id: E_SET, assignable: false }],
  ]);

  currentAssignment(userId: string): Assignment | undefined {
    return this.assignments.find((a) => a.user_id === userId && a.ended_at === null);
  }

  activeGrant(userId: string, capabilityId: string): boolean {
    const events = this.grants.filter((g) => g.user_id === userId && g.capability_id === capabilityId);
    return events[events.length - 1]?.action === 'GRANTED';
  }

  query: QueryFn = (async (text: string, params: unknown[] = []) => {
    const sql = String(text).trim();
    this.statements.push({ sql, params });
    const id = String(params[0]);

    if (sql.startsWith('UPDATE users SET email = $2')) {
      this.authCalls.push(`setEmailAndPassword:${id}`);
      if (this.failAuthEmail === 'failed') throw new Error('synthetic credential failure');
      if (this.failAuthEmail === 'email_unavailable' || [...this.authUsers.entries()].some(([other,u])=> other !== id && u.email === params[1])) {
        throw Object.assign(new Error('synthetic conflict'), {code:'23505',constraint:'users_email_key'});
      }
      this.authUsers.set(id,{email:String(params[1]),password:String(params[2])});
      return {rows:[{id}]};
    }
    if (sql.startsWith('UPDATE users SET email = NULL')) {
      if (this.failAuthDelete) throw new Error('synthetic credential failure');
      this.authUsers.delete(id);
      this.authCalls.push(`deleteUser:${id}`);
      return {rows:[]};
    }
    if (sql.startsWith('UPDATE user_sessions')) return {rows:[]};
    if (sql.startsWith('SELECT state, credential_version::text')) {
      const row = this.access.get(id);
      return { rows: row ? [{
        state: row.state,
        credential_version: String(row.credential_version),
        credential_reset_pending: row.credential_reset_pending,
      }] : [] };
    }
    if (sql.includes('FROM privileged_access_events')) {
      return { rows: [{ protected: this.privilegedUsers.has(id) }] };
    }
    if (sql.startsWith('SELECT company_id, primary_team_position_id FROM workforce_profiles')) {
      const p = this.profiles.get(id);
      return { rows: p ? [{ company_id: p.company_id, primary_team_position_id: p.primary_team_position_id }] : [] };
    }
    if (sql.startsWith('SELECT t.company_id, tp.site_manager_assignable')) {
      const tp = this.teamPositions.get(id);
      return { rows: tp ? [{ company_id: tp.company_id, assignable: tp.assignable }] : [] };
    }
    if (sql.startsWith('UPDATE workforce_profiles SET display_name')) {
      const p = this.profiles.get(id);
      if (!p || p.display_name === String(params[1])) return { rows: [] };
      p.display_name = String(params[1]);
      return { rows: [{ user_id: id }] };
    }
    if (sql.startsWith('SELECT 1 FROM workforce_profiles')) {
      return { rows: this.profiles.has(id) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.startsWith('UPDATE user_team_positions SET ended_at')) {
      const current = this.currentAssignment(id);
      if (current) current.ended_at = 'db-now';
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO user_team_positions')) {
      const existing = this.assignments.find(
        (a) => a.user_id === id && a.team_position_id === String(params[1]),
      );
      if (existing) existing.ended_at = null;
      else this.assignments.push({ user_id: id, team_position_id: String(params[1]), ended_at: null });
      // The partial unique index made real: exactly one current row.
      const current = this.assignments.filter((a) => a.user_id === id && a.ended_at === null);
      if (current.length > 1) throw new Error('user_team_positions_one_current_per_user');
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE workforce_profiles')) {
      const p = this.profiles.get(id);
      if (p) { p.company_id = String(params[1]); p.primary_team_position_id = String(params[2]); }
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE app_user_access')) {
      const row = this.access.get(id);
      if (!row) return { rows: [] };
      if (sql.includes("state = 'DELETED'")) {
        row.state = 'DELETED';
        row.credential_reset_pending = false;
        row.credential_version += 1;
        return { rows: [] };
      }
      if (sql.includes('SET state = $2')) {
        if (row.state === 'DELETED') throw new Error('a DELETED account is terminal');
        row.state = params[1] as 'ACTIVE' | 'DISABLED';
        return { rows: [] };
      }
      if (sql.includes('credential_version = credential_version + 1')) {
        row.must_change_password = true;
        row.credential_reset_pending = !sql.includes('credential_reset_pending = FALSE');
        row.credential_version += 1;
        return { rows: [{ credential_version: String(row.credential_version) }] };
      }
      if (sql.includes('credential_reset_pending = FALSE')) {
        if (String(row.credential_version) !== String(params[1])) return { rows: [] };
        row.credential_reset_pending = false;
        return { rows: [{ user_id: id }] };
      }
    }
    if (sql.startsWith('SELECT credential_version::text')) {
      const row = this.access.get(id);
      return { rows: row ? [{
        credential_version: String(row.credential_version),
        credential_reset_pending: row.credential_reset_pending,
      }] : [] };
    }
    if (sql.startsWith("SELECT set_config")) return { rows: [] };
    if (sql.startsWith('SELECT id, individually_grantable FROM capabilities')) {
      return { rows: String(params[0]) === 'permit.view_all'
        ? [{ id: VIEW_ALL, individually_grantable: true }]
        : [{ id: 'other', individually_grantable: false }] };
    }
    if (sql.startsWith('SELECT state FROM app_user_access')) {
      const row = this.access.get(id);
      return { rows: row ? [{ state: row.state }] : [] };
    }
    if (sql.startsWith('SELECT action FROM user_capability_grants')) {
      const events = this.grants.filter((g) => g.user_id === id && g.capability_id === String(params[1]));
      const last = events[events.length - 1];
      return { rows: last ? [{ action: last.action }] : [] };
    }
    if (sql.startsWith('INSERT INTO user_capability_grants')) {
      if (String(params[0]) === String(params[3])) throw new Error('user_capability_grants_not_self');
      this.grants.push({
        user_id: id, capability_id: String(params[1]),
        action: String(params[2]), actor_user_id: String(params[3]),
      });
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO account_audit_events')) {
      this.audit.push({
        event_type: String(params[0]), actor: String(params[1]), target: String(params[2]), params,
      });
      return { rows: [] };
    }
    throw new Error(`unhandled query: ${sql}`);
  }) as QueryFn;

  deps(): AccountsServiceDeps {
    return {
      query: this.query,
      withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
        if (this.failTransaction) throw new Error('database failure inside the transaction');
        const access = structuredClone(this.access);
        const users = structuredClone(this.authUsers);
        const audit = structuredClone(this.audit);
        try { return await fn({ query: this.query } as unknown as PoolClient); }
        catch (err) { this.access=access; this.authUsers=users; this.audit=audit; throw err; }
      },
    };
  }
}

function seedEmployee(db: FakeEmployeeDb): void {
  db.access.set(EMPLOYEE, {
    state: 'ACTIVE', must_change_password: false, credential_version: 0, credential_reset_pending: false,
  });
  db.profiles.set(EMPLOYEE, {
    company_id: E_SET, primary_team_position_id: TP_CIVIL_WORKER, display_name: 'Ayesha Khan',
  });
  db.assignments.push({ user_id: EMPLOYEE, team_position_id: TP_CIVIL_WORKER, ended_at: null });
  db.authUsers.set(EMPLOYEE, { email: 'ayesha@example.com', password: 'FAKE-old' });
}

function seedPrivilegedTarget(db: FakeEmployeeDb): void {
  db.access.set(PRIVILEGED, {
    state: 'ACTIVE', must_change_password: false, credential_version: 0, credential_reset_pending: false,
  });
  db.privilegedUsers.add(PRIVILEGED);
}

// ---------------------------------------------------------------------
// Rename
// ---------------------------------------------------------------------

test('a rename is audited and touches nothing historical', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(await updateEmployeeDisplayName(MANAGER, EMPLOYEE, 'Ayesha K. Khan', db.deps()), { outcome: 'ok' });
  assert.equal(db.profiles.get(EMPLOYEE)?.display_name, 'Ayesha K. Khan');
  assert.equal(db.audit.at(-1)?.event_type, 'EMPLOYEE_DISPLAY_NAME_CHANGED');
  // A signature copies the name at signing time, so nothing here may
  // reach permits, signatures, or snapshots.
  for (const { sql } of db.statements) {
    assert.doesNotMatch(sql, /permit_signatures|issued_document_snapshots|UPDATE permits/i);
  }
});

test('a rename to the same name is not reported as a change', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(await updateEmployeeDisplayName(MANAGER, EMPLOYEE, 'Ayesha Khan', db.deps()),
    { outcome: 'invalid', reason: 'unchanged' });
  assert.equal(db.audit.length, 0);
});

// ---------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------

test('a transfer ends the old assignment, starts one new current assignment, and keeps history', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(
    await transferEmployee(MANAGER, EMPLOYEE, { companyId: E_SET, teamPositionId: TP_WTG_TECH }, db.deps()),
    { outcome: 'ok' },
  );
  assert.equal(db.assignments.length, 2, 'the previous assignment row is preserved, never deleted');
  assert.equal(db.currentAssignment(EMPLOYEE)?.team_position_id, TP_WTG_TECH);
  assert.equal(
    db.assignments.filter((a) => a.user_id === EMPLOYEE && a.ended_at === null).length, 1,
    'exactly one current assignment',
  );
  assert.equal(db.assignments.find((a) => a.team_position_id === TP_CIVIL_WORKER)?.ended_at, 'db-now');
  assert.equal(db.audit.at(-1)?.event_type, 'EMPLOYEE_TEAM_POSITION_CHANGED');
  for (const { sql } of db.statements) {
    assert.doesNotMatch(sql, /DELETE\s+FROM\s+user_team_positions/i);
  }
});

test('a cross-company transfer audits both the company and the assignment change', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(
    await transferEmployee(MANAGER, EMPLOYEE, { companyId: ZPL, teamPositionId: TP_ZPL_ENGINEER }, db.deps()),
    { outcome: 'ok' },
  );
  assert.equal(db.profiles.get(EMPLOYEE)?.company_id, ZPL);
  const types = db.audit.map((a) => a.event_type);
  assert.ok(types.includes('EMPLOYEE_COMPANY_CHANGED'));
  assert.ok(types.includes('EMPLOYEE_TEAM_POSITION_CHANGED'));
  // The audit records company IDs, never a name or any free text.
  const companyEvent = db.audit.find((a) => a.event_type === 'EMPLOYEE_COMPANY_CHANGED');
  assert.equal(companyEvent?.params[3], E_SET);
  assert.equal(companyEvent?.params[4], ZPL);
});

test('an assignment whose team belongs to another company is refused', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(
    await transferEmployee(MANAGER, EMPLOYEE, { companyId: E_SET, teamPositionId: TP_ZPL_ENGINEER }, db.deps()),
    { outcome: 'invalid', reason: 'company_team_mismatch' },
  );
  assert.equal(db.currentAssignment(EMPLOYEE)?.team_position_id, TP_CIVIL_WORKER, 'nothing moved');
  assert.equal(db.audit.length, 0);
});

test('a Team + Position not approved for provisioning is refused', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(
    await transferEmployee(MANAGER, EMPLOYEE, { companyId: E_SET, teamPositionId: TP_NOT_ASSIGNABLE }, db.deps()),
    { outcome: 'invalid', reason: 'team_position_not_assignable' },
  );
});

test('returning to a previously held assignment reactivates that row rather than duplicating it', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  await transferEmployee(MANAGER, EMPLOYEE, { companyId: E_SET, teamPositionId: TP_WTG_TECH }, db.deps());
  await transferEmployee(MANAGER, EMPLOYEE, { companyId: E_SET, teamPositionId: TP_CIVIL_WORKER }, db.deps());
  assert.equal(db.assignments.length, 2, 'still two history rows, not three');
  assert.equal(db.currentAssignment(EMPLOYEE)?.team_position_id, TP_CIVIL_WORKER);
  assert.equal(
    db.assignments.filter((a) => a.user_id === EMPLOYEE && a.ended_at === null).length, 1,
  );
});

test('the account row is locked before anything is read or written', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  await transferEmployee(MANAGER, EMPLOYEE, { companyId: E_SET, teamPositionId: TP_WTG_TECH }, db.deps());
  assert.match(db.statements[0]!.sql, /FOR UPDATE/, 'concurrent transfers serialize on the account row');
});

// ---------------------------------------------------------------------
// Privileged targets and self-targeting
// ---------------------------------------------------------------------

test('a privileged target is untouchable through every employee operation', async () => {
  const db = new FakeEmployeeDb();
  seedPrivilegedTarget(db);
  const deps = db.deps();
  const expected = { outcome: 'refused', reason: 'target_is_privileged' };
  assert.deepEqual(await updateEmployeeDisplayName(MANAGER, PRIVILEGED, 'X', deps), expected);
  assert.deepEqual(await transferEmployee(MANAGER, PRIVILEGED, { companyId: E_SET, teamPositionId: TP_WTG_TECH }, deps), expected);
  assert.deepEqual(await setEmployeeAccountState(MANAGER, PRIVILEGED, 'DISABLED', deps), expected);
  assert.deepEqual(await changeEmployeeEmail(MANAGER, PRIVILEGED,
    { newEmail: 'x@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD }, deps), expected);
  assert.deepEqual(await deleteEmployeeAccount(CEO, PRIVILEGED, deps), expected);
  assert.equal(db.audit.length, 0);
  assert.equal(db.authCalls.length, 0, 'no Auth work is attempted against a privileged identity');
});

test('a manager cannot act on their own account through the employee endpoints', async () => {
  const db = new FakeEmployeeDb();
  const deps = db.deps();
  const expected = { outcome: 'refused', reason: 'target_is_self' };
  assert.deepEqual(await updateEmployeeDisplayName(MANAGER, MANAGER, 'X', deps), expected);
  assert.deepEqual(await setEmployeeAccountState(MANAGER, MANAGER, 'DISABLED', deps), expected);
  assert.deepEqual(await deleteEmployeeAccount(CEO, CEO, deps), expected);
});

// ---------------------------------------------------------------------
// Disable / re-enable
// ---------------------------------------------------------------------

test('disable and re-enable preserve the assignment and every individual permission', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  db.grants.push({ user_id: EMPLOYEE, capability_id: VIEW_ALL, action: 'GRANTED', actor_user_id: CEO });

  assert.deepEqual(await setEmployeeAccountState(MANAGER, EMPLOYEE, 'DISABLED', db.deps()), { outcome: 'ok' });
  assert.equal(db.access.get(EMPLOYEE)?.state, 'DISABLED');
  assert.equal(db.currentAssignment(EMPLOYEE)?.team_position_id, TP_CIVIL_WORKER, 'assignment untouched');
  assert.equal(db.activeGrant(EMPLOYEE, VIEW_ALL), true, 'permission untouched');

  assert.deepEqual(await setEmployeeAccountState(MANAGER, EMPLOYEE, 'ACTIVE', db.deps()), { outcome: 'ok' });
  assert.equal(db.access.get(EMPLOYEE)?.state, 'ACTIVE');
  assert.equal(db.currentAssignment(EMPLOYEE)?.team_position_id, TP_CIVIL_WORKER);
  assert.equal(db.activeGrant(EMPLOYEE, VIEW_ALL), true);
  assert.deepEqual(db.audit.map((a) => a.event_type), ['EMPLOYEE_DISABLED', 'EMPLOYEE_REENABLED']);
});

test('a redundant state change is a conflict, not a silent success', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(await setEmployeeAccountState(MANAGER, EMPLOYEE, 'ACTIVE', db.deps()),
    { outcome: 'refused', reason: 'already_in_state' });
  assert.equal(db.audit.length, 0);
});

// ---------------------------------------------------------------------
// Email transition
// ---------------------------------------------------------------------

test('an email change moves the login, forces a password change, and audits no address', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(
    await changeEmployeeEmail(MANAGER, EMPLOYEE,
      { newEmail: 'new@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD }, db.deps()),
    { outcome: 'ok' },
  );
  assert.equal(db.authUsers.get(EMPLOYEE)?.email, 'new@example.com');
  assert.equal((await verifyPassword({hash:db.authUsers.get(EMPLOYEE)!.password,scheme:'argon2id'},FAKE_TEMPORARY_PASSWORD)).ok,true);
  assert.equal(db.access.get(EMPLOYEE)?.must_change_password, true);
  assert.equal(db.access.get(EMPLOYEE)?.credential_reset_pending, false, 'the operation completed');
  assert.equal(db.audit.at(-1)?.event_type, 'EMPLOYEE_EMAIL_CHANGED');

  // Neither the address nor the password may appear anywhere in SQL.
  const serialized = JSON.stringify(db.statements);
  assert.ok(!serialized.includes(FAKE_TEMPORARY_PASSWORD));
  assert.ok(!JSON.stringify(db.audit).includes('new@example.com'));
  assert.ok(!JSON.stringify(db.audit).includes('argon2id'));
});

test('a credential failure rolls the email change back without a partial gate', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  db.failAuthEmail = 'failed';
  assert.deepEqual(
    await changeEmployeeEmail(MANAGER, EMPLOYEE,
      { newEmail: 'new@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD }, db.deps()),
    { outcome: 'failed', reason: 'state_update_failed' },
  );
  assert.equal(db.access.get(EMPLOYEE)?.must_change_password, false, 'the unchanged account remains usable');
  assert.equal(db.access.get(EMPLOYEE)?.credential_reset_pending, false, 'no partial reset survives');
  assert.equal(db.authUsers.get(EMPLOYEE)?.email, 'ayesha@example.com', 'the login did not move');
  assert.equal(db.audit.length, 0);
});

test('an email already used by another identity is refused as a conflict', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  db.authUsers.set(MANAGER, { email: 'taken@example.com', password: 'FAKE' });
  assert.deepEqual(
    await changeEmployeeEmail(MANAGER, EMPLOYEE,
      { newEmail: 'taken@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD }, db.deps()),
    { outcome: 'conflict', reason: 'email_unavailable' },
  );
  assert.equal(db.authUsers.get(EMPLOYEE)?.email, 'ayesha@example.com');
});

test('an email change advances the credential generation, invalidating an older in-flight operation', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  const before = db.access.get(EMPLOYEE)!.credential_version;
  await changeEmployeeEmail(MANAGER, EMPLOYEE,
    { newEmail: 'new@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD }, db.deps());
  assert.ok(db.access.get(EMPLOYEE)!.credential_version > before);
});

test('a deleted account cannot have its email changed or its state altered', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  db.access.get(EMPLOYEE)!.state = 'DELETED';
  const deps = db.deps();
  assert.deepEqual(await changeEmployeeEmail(MANAGER, EMPLOYEE,
    { newEmail: 'n@example.com', temporaryPassword: FAKE_TEMPORARY_PASSWORD }, deps),
    { outcome: 'refused', reason: 'account_deleted' });
  assert.deepEqual(await setEmployeeAccountState(MANAGER, EMPLOYEE, 'ACTIVE', deps),
    { outcome: 'refused', reason: 'account_deleted' });
  assert.deepEqual(await updateEmployeeDisplayName(MANAGER, EMPLOYEE, 'X', deps),
    { outcome: 'refused', reason: 'account_deleted' });
});

// ---------------------------------------------------------------------
// CEO-only deletion
// ---------------------------------------------------------------------

test('deletion tombstones locally FIRST, then removes the Auth login, and destroys no history', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  db.grants.push({ user_id: EMPLOYEE, capability_id: VIEW_ALL, action: 'GRANTED', actor_user_id: CEO });

  assert.deepEqual(await deleteEmployeeAccount(CEO, EMPLOYEE, db.deps()), { outcome: 'ok' });
  assert.equal(db.access.get(EMPLOYEE)?.state, 'DELETED');
  assert.equal(db.authUsers.has(EMPLOYEE), false, 'the login is gone');

  // Everything historical survives.
  assert.ok(db.profiles.has(EMPLOYEE));
  assert.equal(db.assignments.filter((a) => a.user_id === EMPLOYEE).length, 1);
  assert.equal(db.grants.length, 1);
  assert.equal(db.audit.at(-1)?.event_type, 'EMPLOYEE_ACCOUNT_DELETED');
  for (const { sql } of db.statements) {
    assert.doesNotMatch(sql, /DELETE\s+FROM/i, 'nothing is ever deleted from the database');
  }
  // The local tombstone committed before the Auth call.
  const authIndex = db.authCalls.indexOf(`deleteUser:${EMPLOYEE}`);
  assert.ok(authIndex >= 0);
  assert.ok(db.statements.some((s) => s.sql.includes("state = 'DELETED'")));
});

test('failed credential destruction rolls account deletion back', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  db.failAuthDelete = true;
  assert.deepEqual(await deleteEmployeeAccount(CEO, EMPLOYEE, db.deps()),
    { outcome: 'failed', reason: 'state_update_failed' });
  assert.equal(db.access.get(EMPLOYEE)?.state, 'ACTIVE');
  assert.equal(db.audit.length,0);
});

test('a deleted account is terminal - re-enabling it is refused', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  await deleteEmployeeAccount(CEO, EMPLOYEE, db.deps());
  assert.deepEqual(await setEmployeeAccountState(MANAGER, EMPLOYEE, 'ACTIVE', db.deps()),
    { outcome: 'refused', reason: 'account_deleted' });
  assert.equal(db.access.get(EMPLOYEE)?.state, 'DELETED');
});

test('deleting an already deleted account is a conflict and does not re-audit', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  await deleteEmployeeAccount(CEO, EMPLOYEE, db.deps());
  const auditCount = db.audit.length;
  assert.deepEqual(await deleteEmployeeAccount(CEO, EMPLOYEE, db.deps()),
    { outcome: 'refused', reason: 'already_deleted' });
  assert.equal(db.audit.length, auditCount);
});

// ---------------------------------------------------------------------
// Individual permissions
// ---------------------------------------------------------------------

test('view-all is granted and revoked from the latest event, and audited by capability id', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(await setUserCapabilityGrant(CEO, EMPLOYEE, 'permit.view_all', 'GRANTED', db.deps()), { outcome: 'ok' });
  assert.equal(db.activeGrant(EMPLOYEE, VIEW_ALL), true);
  assert.deepEqual(await setUserCapabilityGrant(MANAGER, EMPLOYEE, 'permit.view_all', 'REVOKED', db.deps()), { outcome: 'ok' });
  assert.equal(db.activeGrant(EMPLOYEE, VIEW_ALL), false);

  // Append-only: three rows, nothing edited.
  assert.deepEqual(db.grants.map((g) => g.action), ['GRANTED', 'REVOKED']);
  assert.deepEqual(db.audit.map((a) => a.event_type),
    ['EMPLOYEE_PERMISSION_GRANTED', 'EMPLOYEE_PERMISSION_REVOKED']);
  assert.equal(db.audit.at(-1)?.params[7], VIEW_ALL, 'the capability is recorded by id, never by free text');
});

test('a redundant grant or revoke is refused rather than appended', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  await setUserCapabilityGrant(CEO, EMPLOYEE, 'permit.view_all', 'GRANTED', db.deps());
  assert.deepEqual(await setUserCapabilityGrant(CEO, EMPLOYEE, 'permit.view_all', 'GRANTED', db.deps()),
    { outcome: 'refused', reason: 'already_in_state' });
  assert.equal(db.grants.length, 1);
});

test('a privileged target and a deleted account both refuse an individual permission', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  seedPrivilegedTarget(db);
  assert.deepEqual(await setUserCapabilityGrant(CEO, PRIVILEGED, 'permit.view_all', 'GRANTED', db.deps()),
    { outcome: 'refused', reason: 'target_is_privileged' });

  db.access.get(EMPLOYEE)!.state = 'DELETED';
  assert.deepEqual(await setUserCapabilityGrant(CEO, EMPLOYEE, 'permit.view_all', 'GRANTED', db.deps()),
    { outcome: 'refused', reason: 'account_deleted' });
  assert.equal(db.grants.length, 0);
});

test('nobody can grant an individual permission to themselves', async () => {
  const db = new FakeEmployeeDb();
  seedEmployee(db);
  assert.deepEqual(await setUserCapabilityGrant(EMPLOYEE, EMPLOYEE, 'permit.view_all', 'GRANTED', db.deps()),
    { outcome: 'refused', reason: 'target_is_self' });
  assert.equal(db.grants.length, 0);
});
