import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { installedDatabase } from '../../test/permitSchemaFixtures.js';
import { authDatabaseDeps } from '../../test/authDatabase.js';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import { login } from '../auth/login.js';
import { findActiveSession } from '../auth/sessions.js';
import { changeOwnPassword, resetEmployeePassword } from './service.js';
import { setEmployeeAccountState } from './employees.js';

let db: PGlite;
const USER = '10000000-0000-4000-8000-000000000003';
const MANAGER = '10000000-0000-4000-8000-000000000002';
const OLD = 'FAKE-original-password';
const NEW = 'FAKE-new-password';
before(async () => {
  db = await installedDatabase();
  await db.query('INSERT INTO permit.users (id,email,password_hash,password_scheme) VALUES ($1,$2,$3,$4)', [USER,'employee@example.invalid',await hashPassword(OLD),'argon2id']);
  await db.query("INSERT INTO permit.users (id,email) VALUES ($1,'manager@example.invalid')", [MANAGER]);
  await db.query("INSERT INTO permit.app_user_access (user_id,state) VALUES ($1,'ACTIVE'),($2,'ACTIVE')", [USER,MANAGER]);
  await db.exec('SET ROLE permit_runtime; SET search_path=pg_catalog,permit,pg_temp');
});
after(async () => { await db?.close(); });
async function session(password: string) {
  const result = await login({ email:'employee@example.invalid',password,remember:false },authDatabaseDeps(db));
  assert.equal(result.outcome,'ok');
  if (result.outcome !== 'ok') throw new Error('synthetic login failed');
  return result.token;
}

test('manager reset replaces credential, revokes sessions, and forces change atomically', async () => {
  const deps = authDatabaseDeps(db);
  const token = await session(OLD);
  assert.deepEqual(await resetEmployeePassword(MANAGER,USER,NEW,deps),{outcome:'ok'});
  assert.equal(await findActiveSession(deps.query,token),null);
  assert.deepEqual(await login({email:'employee@example.invalid',password:OLD,remember:false},deps),{outcome:'invalid_credentials'});
  assert.equal((await db.query<{ must_change_password:boolean }>('SELECT must_change_password FROM app_user_access WHERE user_id=$1',[USER])).rows[0]!.must_change_password,true);
  const own = await session(NEW);
  const other = await session(NEW);
  const current = await findActiveSession(deps.query,own);
  assert.ok(current);
  assert.deepEqual(await changeOwnPassword(USER,NEW,deps,current.sessionId),{outcome:'invalid',reason:'password_unchanged'});
  assert.deepEqual(await changeOwnPassword(USER,OLD,deps,current.sessionId),{outcome:'ok'});
  assert.ok(await findActiveSession(deps.query,own));
  assert.equal(await findActiveSession(deps.query,other),null);
  assert.equal((await db.query<{ must_change_password:boolean }>('SELECT must_change_password FROM app_user_access WHERE user_id=$1',[USER])).rows[0]!.must_change_password,false);
  assert.deepEqual(await changeOwnPassword(USER,NEW,deps,current.sessionId),{outcome:'refused',reason:'no_password_change_required'});
});

test('reset cannot target self or a protected CEO', async () => {
  const deps=authDatabaseDeps(db);
  assert.deepEqual(await resetEmployeePassword(USER,USER,NEW,deps),{outcome:'not_manageable'});
  await db.exec('RESET ROLE');
  await db.query("INSERT INTO permit.privileged_identities (user_id,display_name) VALUES ($1,'Synthetic CEO')",[MANAGER]);
  await db.query("INSERT INTO permit.privileged_access_events (user_id,role,action) VALUES ($1,'CEO','GRANTED')",[MANAGER]);
  await db.exec('SET ROLE permit_runtime');
  assert.deepEqual(await resetEmployeePassword(USER,MANAGER,NEW,deps),{outcome:'not_manageable'});
});

test('disable revokes sessions permanently; re-enable does not revive them', async () => {
  const deps=authDatabaseDeps(db);
  const token=await session(OLD);
  assert.deepEqual(await setEmployeeAccountState(MANAGER,USER,'DISABLED',deps),{outcome:'ok'});
  assert.equal(await findActiveSession(deps.query,token),null);
  assert.deepEqual(await login({email:'employee@example.invalid',password:OLD,remember:false},deps),{outcome:'invalid_credentials'});
  assert.deepEqual(await setEmployeeAccountState(MANAGER,USER,'ACTIVE',deps),{outcome:'ok'});
  assert.equal(await findActiveSession(deps.query,token),null);
  await session(OLD);
});

test('audit failure rolls password, forced-change state and session revocation back together',async()=>{
  const deps=authDatabaseDeps(db);
  const token=await session(OLD);
  await db.exec(`RESET ROLE; CREATE FUNCTION permit.test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
    CREATE TRIGGER test_failure BEFORE INSERT ON permit.account_audit_events FOR EACH ROW EXECUTE FUNCTION permit.test_audit_failure(); SET ROLE permit_runtime;`);
  try {
    assert.deepEqual(await resetEmployeePassword(MANAGER,USER,NEW,deps),{outcome:'failed',reason:'state_update_failed'});
    assert.ok(await findActiveSession(deps.query,token));
    const credential=(await db.query<{password_hash:string;password_scheme:string}>('SELECT password_hash,password_scheme FROM users WHERE id=$1',[USER])).rows[0]!;
    assert.equal((await verifyPassword({hash:credential.password_hash,scheme:credential.password_scheme},OLD)).ok,true);
  } finally { await db.exec('RESET ROLE; DROP TRIGGER test_failure ON permit.account_audit_events; DROP FUNCTION permit.test_audit_failure(); SET ROLE permit_runtime'); }
});
