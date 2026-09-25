import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { PoolClient } from 'pg';
import type { QueryFn } from '../../db/pool.js';
import { installedDatabase } from '../../test/permitSchemaFixtures.js';
import type { PGlite } from '@electric-sql/pglite';
import type { PrivilegedAccessAdmin } from '../../db/privilegedPool.js';
import { hashPassword } from '../auth/passwords.js';
import { createSiteManagerAccount } from './privilegedManagement.js';
import { createEmployeeAccount, type AccountsServiceDeps } from './service.js';

const ACTOR = '10000000-0000-4000-8000-000000000001';
const CREATED = '10000000-0000-4000-8000-000000000009';
const input = {
  email: 'synthetic@example.invalid',
  temporaryPassword: 'FAKE-atomicity-test-password',
  displayName: 'Synthetic Test Account',
  companyId: '20000000-0000-4000-8000-000000000001',
  teamPositionId: '30000000-0000-4000-8000-000000000001',
};

/** Synthetic transaction model: only committed table writes survive. No external I/O. */
function fixture(failTable?: string) {
  let committed: string[] = [];
  let pending: string[] | null = null;
  const query = (async (sql: string) => {
    const table = /^INSERT INTO (\w+)/.exec(sql.trim())?.[1];
    assert.ok(table, 'fixture must handle each statement explicitly');
    assert.ok(pending, 'every account write must be inside a transaction');
    if (table === failTable) throw new Error('synthetic write failure');
    pending.push(table);
    return { rows: table === 'users' ? [{ id: CREATED }] : [] };
  }) as QueryFn;
  const deps: AccountsServiceDeps = {
    query,
    withTransaction: async (fn) => {
      pending = [...committed];
      try {
        const result = await fn({ query } as unknown as PoolClient);
        committed = pending;
        return result;
      } finally {
        pending = null;
      }
    },
  };
  return { deps, committed: () => [...committed] };
}

test('employee creation commits identity, access, assignment, profile and audit together', async () => {
  const db = fixture();
  assert.deepEqual(await createEmployeeAccount(ACTOR, input, db.deps), { outcome: 'ok', userId: CREATED });
  assert.deepEqual(db.committed(), [
    'users', 'app_user_access', 'user_team_positions', 'workforce_profiles', 'account_audit_events',
  ]);
});

test('employee creation rolls back identity and all account writes when its audit fails', async () => {
  const db = fixture('account_audit_events');
  assert.deepEqual(await createEmployeeAccount(ACTOR, input, db.deps), {
    outcome: 'failed', reason: 'provisioning_rolled_back',
  });
  assert.deepEqual(db.committed(), []);
});


let db: PGlite;
let hash: string;
const SESSION = '50000000-0000-4000-8000-000000000001';
before(async () => {
  db = await installedDatabase();
  hash = await hashPassword(input.temporaryPassword);
  await db.query("INSERT INTO permit.users (id, email) VALUES ($1, 'ceo@example.invalid')", [ACTOR]);
  await db.query("INSERT INTO permit.app_user_access (user_id, state) VALUES ($1, 'ACTIVE')", [ACTOR]);
  await db.query("INSERT INTO permit.privileged_identities (user_id, display_name) VALUES ($1, 'Synthetic CEO')", [ACTOR]);
  await db.query("INSERT INTO permit.privileged_access_events (user_id, role, action) VALUES ($1, 'CEO', 'GRANTED')", [ACTOR]);
  await db.query("INSERT INTO permit.user_sessions (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,now()+interval '1 day')", [SESSION, ACTOR, Buffer.alloc(32, 1)]);
});
after(async () => { await db?.close(); });

async function counts() {
  const tables = ['users', 'app_user_access', 'privileged_identities', 'privileged_access_events'];
  return Promise.all(tables.map(async (table) =>
    (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM permit.${table}`)).rows[0]!.n));
}
async function provision(session = SESSION, email = input.email, passwordHash = hash) {
  await db.exec('SET ROLE permit_privileged');
  try {
    return (await db.query<{ id: string }>('SELECT permit.provision_site_manager($1,$2,$3,$4) AS id',
      [session, email, passwordHash, input.displayName])).rows[0]!.id;
  } catch (error) {
    throw Object.assign(new Error('provisioning refused'), { code: (error as { code?: string }).code });
  } finally { await db.exec('RESET ROLE').catch(() => undefined); }
}
const privileged: PrivilegedAccessAdmin = {
  provisionSiteManager: async (session, email, passwordHash) => {
    try { return { ok: true, userId: await provision(session, email, passwordHash) }; }
    catch { return { ok: false, reason: 'refused' }; }
  },
  recordSiteManagerGrant: async () => { throw new Error('creation must not call a separate grant'); },
  recordSiteManagerRevoke: async () => { throw new Error('unexpected revoke'); },
};

for (const table of ['users', 'app_user_access', 'privileged_identities', 'privileged_access_events']) {
  test(table === 'privileged_access_events'
    ? 'Site Manager creation must not leave a partial account when the privileged grant fails'
    : `Site Manager ${table} failure rolls back every provisioning write`, async () => {
    const before = await counts();
    await db.exec(`CREATE FUNCTION permit.test_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
      CREATE TRIGGER test_reject BEFORE INSERT ON permit.${table}
        FOR EACH ROW EXECUTE FUNCTION permit.test_reject_insert();`);
    try {
      assert.deepEqual(await createSiteManagerAccount(SESSION, input, privileged),
        { outcome: 'failed', reason: 'provisioning_rolled_back' });
      assert.deepEqual(await counts(), before);
    } finally {
      await db.exec(`DROP TRIGGER test_reject ON permit.${table}; DROP FUNCTION permit.test_reject_insert();`);
    }
  });
}

test('Site Manager success creates identity, access, name and privileged audit atomically', async () => {
  const before = await counts();
  const id = await provision();
  assert.deepEqual(await counts(), before.map((n) => n + 1));
  const result = await db.query(`SELECT a.must_change_password, e.actor_user_id, e.role, e.action,
      u.password_scheme FROM permit.users u JOIN permit.app_user_access a ON a.user_id=u.id
      JOIN permit.privileged_access_events e ON e.user_id=u.id WHERE u.id=$1`, [id]);
  assert.deepEqual(result.rows, [{ must_change_password: true, actor_user_id: ACTOR,
    role: 'SITE_MANAGER', action: 'GRANTED', password_scheme: 'argon2id' }]);
  const after = await counts();
  await assert.rejects(provision());
  assert.deepEqual(await counts(), after, 'duplicate email leaves no extra rows');
});

for (const state of ['unknown', 'ceo_uuid', 'expired', 'revoked', 'disabled', 'forced_change', 'ordinary', 'site_manager']) {
  test(`privileged provisioning rejects ${state} context before writes`, async () => {
    await db.exec('BEGIN');
    const before = await counts();
    try {
      let session = SESSION;
      if (state === 'unknown') session = CREATED;
      if (state === 'ceo_uuid') session = ACTOR;
      if (state === 'expired') {
        await db.exec('ALTER TABLE permit.user_sessions DISABLE TRIGGER user_sessions_revocation_is_final');
        await db.query("UPDATE permit.user_sessions SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=$1", [SESSION]);
      }
      if (state === 'revoked') await db.query('UPDATE permit.user_sessions SET revoked_at=now() WHERE id=$1', [SESSION]);
      if (state === 'disabled') await db.query("UPDATE permit.app_user_access SET state='DISABLED' WHERE user_id=$1", [ACTOR]);
      if (state === 'forced_change') await db.query('UPDATE permit.app_user_access SET must_change_password=true WHERE user_id=$1', [ACTOR]);
      if (state === 'ordinary' || state === 'site_manager') {
        await db.query("INSERT INTO permit.privileged_access_events (user_id, role, action) VALUES ($1,'CEO','REVOKED')", [ACTOR]);
        if (state === 'site_manager') await db.query("INSERT INTO permit.privileged_access_events (user_id, role, action) VALUES ($1,'SITE_MANAGER','GRANTED')", [ACTOR]);
      }
      await assert.rejects(provision(session, `denied-${state}@example.invalid`), { code: '42501' });
    } finally { await db.exec('ROLLBACK; RESET ROLE'); }
    assert.deepEqual(await counts(), before);
  });
}

test('privileged function grants and ownership stay narrow', async () => {
  const functions = await db.query<{ proname: string; owner: string; proconfig: string[] }>(`
    SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.proconfig FROM pg_proc p
    WHERE p.pronamespace='permit'::regnamespace AND has_function_privilege('permit_privileged',p.oid,'EXECUTE') ORDER BY 1`);
  assert.deepEqual(functions.rows.map((r) => r.proname), ['provision_site_manager', 'record_site_manager_grant']);
  for (const fn of functions.rows) {
    assert.equal(fn.owner, 'permit_migrator');
    assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, pg_temp']);
  }
  assert.deepEqual((await db.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='permit'::regnamespace
    AND c.relkind='r' AND has_any_column_privilege('permit_privileged',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')`)).rows, []);
  for (const role of ['permit_runtime', 'anon', 'authenticated', 'service_role']) {
    await db.exec(`SET ROLE ${role}`);
    try { await assert.rejects(db.query('SELECT permit.provision_site_manager($1,$2,$3,$4)', [SESSION,input.email,hash,input.displayName]), { code: '42501' }); }
    finally { await db.exec('RESET ROLE'); }
  }
});
