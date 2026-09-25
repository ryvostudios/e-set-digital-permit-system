import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import { installedDatabase } from '../../test/permitSchemaFixtures.js';
import { hashPassword } from '../auth/passwords.js';
let db:PGlite;
const CEO='10000000-0000-4000-8000-000000000001';
const SESSION='50000000-0000-4000-8000-000000000001';
let target:string;
before(async()=>{
 db=await installedDatabase();
 await db.query("INSERT INTO permit.users(id,email) VALUES ($1,'ceo@example.invalid')",[CEO]);
 await db.query("INSERT INTO permit.app_user_access(user_id,state) VALUES ($1,'ACTIVE')",[CEO]);
 await db.query("INSERT INTO permit.privileged_identities(user_id,display_name) VALUES ($1,'CEO')",[CEO]);
 await db.query("INSERT INTO permit.privileged_access_events(user_id,role,action) VALUES ($1,'CEO','GRANTED')",[CEO]);
 await db.query("INSERT INTO permit.user_sessions(id,user_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",[SESSION,CEO,Buffer.alloc(32,2)]);
 const hash=await hashPassword('FAKE-manager-password');
 await db.exec('SET ROLE permit_privileged');
 target=(await db.query<{id:string}>('SELECT permit.provision_site_manager($1,$2,$3,$4) AS id',[SESSION,'manager@example.invalid',hash,'Manager'])).rows[0]!.id;
});
after(async()=>{await db?.close();});
test('grant/revoke requires a valid CEO session; UUID impersonation and self changes fail',async()=>{
 for(const [session,user] of [[CEO,target],[SESSION,CEO]]){
  await assert.rejects(db.query("SELECT permit.record_site_manager_grant($1,$2,'REVOKED')",[session,user]),{code:'42501'});
 }
});
test('grant/revoke preserves append-only authority and rejects redundant changes',async()=>{
 await db.query("SELECT permit.record_site_manager_grant($1,$2,'REVOKED')",[SESSION,target]);
 await assert.rejects(db.query("SELECT permit.record_site_manager_grant($1,$2,'REVOKED')",[SESSION,target]),{code:'23514'});
 await db.query("SELECT permit.record_site_manager_grant($1,$2,'GRANTED')",[SESSION,target]);
 await db.exec('RESET ROLE');
 assert.deepEqual((await db.query("SELECT action FROM permit.privileged_access_events WHERE user_id=$1 ORDER BY ordinal",[target])).rows,[{action:'GRANTED'},{action:'REVOKED'},{action:'GRANTED'}]);
});
