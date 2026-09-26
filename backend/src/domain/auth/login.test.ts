import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import bcrypt from 'bcryptjs';
import { installedDatabase } from '../../test/permitSchemaFixtures.js';
import { authDatabaseDeps } from '../../test/authDatabase.js';
import { login } from './login.js';
import { hashPassword, isSupportedLegacyHash, verifyPassword } from './passwords.js';
import { findActiveSession, revokeSessionByToken, tokenDigest, SESSION_TTL_MS, REMEMBERED_SESSION_TTL_MS } from './sessions.js';
import { planLegacyUserImport, importLegacyUsers } from './legacyImport.js';
let db:PGlite;
const ID='10000000-0000-4000-8000-000000000001';
const PASSWORD='FAKE-login-test-password';
let legacy:string;
before(async()=>{
 db=await installedDatabase();
 legacy=await bcrypt.hash(PASSWORD,10);
 await db.query('INSERT INTO permit.users(id,email,password_hash,password_scheme) VALUES($1,$2,$3,$4)',[ID,'user@example.invalid',await hashPassword(PASSWORD),'argon2id']);
 await db.query("INSERT INTO permit.app_user_access(user_id,state) VALUES($1,'ACTIVE')",[ID]);
 await db.exec('SET ROLE permit_runtime; SET search_path=pg_catalog,permit,pg_temp');
});
after(async()=>{await db?.close();});
test('normalized login establishes an opaque session; restoration, logout and reuse are database-backed',async()=>{
 const deps=authDatabaseDeps(db);
 for(const remember of [false,true]){
  const result=await login({email:' USER@EXAMPLE.INVALID ',password:PASSWORD,remember},deps);
  assert.equal(result.outcome,'ok'); if(result.outcome!=='ok')return;
  assert.match(result.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await findActiveSession(deps.query,result.token))?.userId,ID);
  const row=(await db.query<{ttl:number;token_hash:Uint8Array}>('SELECT extract(epoch FROM expires_at-created_at)::float8*1000 AS ttl, token_hash FROM user_sessions WHERE token_hash=$1',[tokenDigest(result.token)])).rows[0]!;
  assert.equal(row.ttl,remember?REMEMBERED_SESSION_TTL_MS:SESSION_TTL_MS);
  assert.notEqual(Buffer.from(row.token_hash).toString(),result.token);
  await revokeSessionByToken(deps.query,result.token);
  assert.equal(await findActiveSession(deps.query,result.token),null);
 }
});
test('wrong password, unknown email and disabled account share the same refusal',async()=>{
 const deps=authDatabaseDeps(db);
 for(const [email,password] of [['user@example.invalid','FAKE-wrong'],['unknown@example.invalid',PASSWORD]]){
  assert.deepEqual(await login({email:email!,password:password!,remember:false},deps),{outcome:'invalid_credentials'});
 }
 await db.query("UPDATE app_user_access SET state='DISABLED' WHERE user_id=$1",[ID]);
 assert.deepEqual(await login({email:'user@example.invalid',password:PASSWORD,remember:false},deps),{outcome:'invalid_credentials'});
 await db.query("UPDATE app_user_access SET state='ACTIVE' WHERE user_id=$1",[ID]);
});
test('expired sessions cannot be restored',async()=>{
 await db.exec('RESET ROLE');
 await db.query("INSERT INTO permit.user_sessions(user_id,token_hash,created_at,expires_at) VALUES($1,$2,now()-interval '2 days',now()-interval '1 day')",[ID,tokenDigest('expired')]);
 await db.exec('SET ROLE permit_runtime');
 assert.equal(await findActiveSession(authDatabaseDeps(db).query,'expired'),null);
});
test('supported legacy variants verify; unknown schemes, malformed hashes and truncated legacy passwords fail closed',async()=>{
 for(const prefix of ['$2a$','$2b$','$2y$']){
  assert.deepEqual(await verifyPassword({hash:prefix+legacy.slice(4),scheme:'bcrypt_legacy'},PASSWORD),{ok:true,needsUpgrade:true});
 }
 for(const stored of [{hash:legacy,scheme:'unknown'},{hash:'$unknown$synthetic',scheme:'bcrypt_legacy'},{hash:'$2b$99$'+legacy.slice(7),scheme:'bcrypt_legacy'}]){
  assert.equal((await verifyPassword(stored,PASSWORD)).ok,false);
 }
 assert.equal((await verifyPassword({hash:legacy,scheme:'bcrypt_legacy'},'x'.repeat(73))).ok,false);
});
test('legacy upgrade and session insert commit or roll back together',async()=>{
 await db.query("UPDATE users SET password_hash=$2,password_scheme='bcrypt_legacy' WHERE id=$1",[ID,legacy]);
 await db.exec(`RESET ROLE; CREATE FUNCTION permit.fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic session failure'; END $$;
   CREATE TRIGGER test_fail BEFORE INSERT ON permit.user_sessions FOR EACH ROW EXECUTE FUNCTION permit.fail_session(); SET ROLE permit_runtime;`);
 const deps=authDatabaseDeps(db);
 try{
  await assert.rejects(login({email:'user@example.invalid',password:PASSWORD,remember:false},deps));
  assert.equal((await db.query<{password_scheme:string}>('SELECT password_scheme FROM users WHERE id=$1',[ID])).rows[0]!.password_scheme,'bcrypt_legacy');
 }finally{await db.exec('RESET ROLE; DROP TRIGGER test_fail ON permit.user_sessions; DROP FUNCTION permit.fail_session(); SET ROLE permit_runtime');}
 assert.equal((await login({email:'user@example.invalid',password:PASSWORD,remember:false},deps)).outcome,'ok');
 assert.equal((await db.query<{password_scheme:string}>('SELECT password_scheme FROM users WHERE id=$1',[ID])).rows[0]!.password_scheme,'argon2id');
});
test('synthetic legacy import preserves UUIDs, normalizes email, reconciles counts and refuses unsupported material',async()=>{
 const source=[{id:'10000000-0000-4000-8000-000000000099',email:' IMPORT@EXAMPLE.INVALID ',encryptedPassword:legacy,createdAt:'2020-01-01T00:00:00Z'}];
 const plan=planLegacyUserImport(source); assert.equal(plan.ok,true); if(!plan.ok)return;
 await db.exec('RESET ROLE; SET ROLE permit_migrator');
 const deps=authDatabaseDeps(db);
 assert.equal(await deps.withTransaction((client)=>importLegacyUsers(client.query.bind(client),plan)),1);
 const rows=(await db.query('SELECT id,email FROM users WHERE id=$1',[source[0]!.id])).rows;
 assert.deepEqual(rows,[{id:source[0]!.id,email:'import@example.invalid'}]);
 assert.equal(planLegacyUserImport([...source,...source]).ok,false);
 assert.equal(planLegacyUserImport([{...source[0]!,encryptedPassword:'unsupported'}]).ok,false);
 assert.equal(planLegacyUserImport([{...source[0]!,encryptedPassword:null}]).ok,false);
 assert.equal(planLegacyUserImport([{...source[0]!,encryptedPassword:null}],{allowAccountsWithoutPassword:true}).ok,true);
 await db.exec('SET ROLE permit_runtime');
});
test('A05: legacy bcrypt hashes are accepted at cost 10 only, so no imported row can make sign-in expensive',async()=>{
 assert.equal(isSupportedLegacyHash(legacy),true);
 for(const cost of ['04','09','11','12','16']) assert.equal(isSupportedLegacyHash(`$2b$${cost}$`+legacy.slice(7)),false);
 const plan=planLegacyUserImport([{id:'10000000-0000-4000-8000-000000000098',email:'cost@example.invalid',encryptedPassword:'$2b$12$'+legacy.slice(7),createdAt:'2020-01-01T00:00:00Z'}]);
 assert.equal(plan.ok,false);
});
test('A05: every refusal costs the same - unknown, disabled, unsupported scheme, wrong Argon2id and wrong legacy password',async()=>{
 const argon=await hashPassword(PASSWORD);
 const cases:Record<string,unknown>={
  unknown:undefined,
  disabled:{id:ID,password_hash:argon,password_scheme:'argon2id',state:'DISABLED'},
  unsupported:{id:ID,password_hash:'$md5$synthetic',password_scheme:'md5',state:'ACTIVE'},
  argon2_wrong:{id:ID,password_hash:argon,password_scheme:'argon2id',state:'ACTIVE'},
  legacy_wrong:{id:ID,password_hash:legacy,password_scheme:'bcrypt_legacy',state:'ACTIVE'},
 };
 const deps=(row:unknown)=>({query:async()=>({rows:row?[row]:[]}),withTransaction:async()=>{throw new Error('a refusal never opens a transaction');}}) as never;
 const samples:Record<string,number[]>=Object.fromEntries(Object.keys(cases).map((k)=>[k,[]]));
 await login({email:'warm@example.invalid',password:'FAKE-wrong',remember:false},deps(undefined));
 // The WORK each refusal does, as this process's CPU time (Argon2's worker
 // threads included), so the other test files running in parallel cannot
 // skew it the way they skew wall time. Round-robin so drift lands on every
 // case alike; medians discard outliers.
 for(let round=0;round<7;round+=1){
  for(const [name,row] of Object.entries(cases)){
   const start=process.cpuUsage();
   assert.deepEqual(await login({email:'user@example.invalid',password:'FAKE-wrong',remember:false},deps(row)),{outcome:'invalid_credentials'});
   const used=process.cpuUsage(start);
   samples[name]!.push((used.user+used.system)/1000);
  }
 }
 const median=(xs:number[])=>[...xs].sort((a,b)=>a-b)[xs.length>>1]!;
 const medians=Object.values(samples).map(median);
 // Before A05 a wrong legacy password took ~2.3x the others; equal work keeps them within scheduling noise.
 assert.ok(Math.max(...medians)/Math.min(...medians)<1.3,JSON.stringify(Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,Math.round(median(v))]))));
});
