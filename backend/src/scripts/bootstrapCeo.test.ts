import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installedDatabase } from '../test/permitSchemaFixtures.js';
import { authDatabaseDeps } from '../test/authDatabase.js';
import { bootstrapInitialCeo, runBootstrapCeoCli } from './bootstrapCeo.js';
const input={email:'ceo@example.invalid',password:'FAKE-bootstrap-password',name:'Synthetic CEO'};
test('bootstrap creates one complete CEO, owes password change, and refuses a second CEO',async()=>{
 const db=await installedDatabase();
 try{
  await db.exec('SET ROLE permit_migrator; SET search_path=pg_catalog,permit,pg_temp');
  const result=await bootstrapInitialCeo(input,authDatabaseDeps(db));
  assert.equal(result.outcome,'ok');
  assert.doesNotMatch(JSON.stringify(result),/password|hash|FAKE/);
  assert.deepEqual(await bootstrapInitialCeo(input,authDatabaseDeps(db)),{outcome:'conflict',reason:'ceo_exists'});
  assert.deepEqual((await db.query('SELECT must_change_password FROM app_user_access')).rows,[{must_change_password:true}]);
  assert.deepEqual((await db.query('SELECT display_name FROM privileged_identities')).rows,[{display_name:input.name}]);
  assert.deepEqual((await db.query('SELECT * FROM workforce_profiles')).rows,[]);
 }finally{await db.close();}
});
test('bootstrap failure leaves no user or privileged identity and can retry after reservation expires',async()=>{
 const db=await installedDatabase();
 try{
  await db.exec(`SET ROLE permit_migrator; SET search_path=pg_catalog,permit,pg_temp;
    CREATE FUNCTION permit.test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER test_fail BEFORE INSERT ON permit.privileged_access_events FOR EACH ROW EXECUTE FUNCTION permit.test_fail();`);
  await assert.rejects(bootstrapInitialCeo(input,authDatabaseDeps(db)));
  assert.deepEqual((await db.query('SELECT id FROM users')).rows,[]);
  assert.deepEqual((await db.query('SELECT user_id FROM privileged_identities')).rows,[]);
  await db.exec("DROP TRIGGER test_fail ON permit.privileged_access_events; DROP FUNCTION permit.test_fail(); UPDATE initial_ceo_bootstrap SET claimed_at=now()-interval '6 minutes'");
  assert.equal((await bootstrapInitialCeo(input,authDatabaseDeps(db))).outcome,'ok');
 }finally{await db.close();}
});
test('bootstrap never adopts an existing identity or echoes an exception',async()=>{
 const db=await installedDatabase();
 try{
  await db.exec('SET ROLE permit_migrator; SET search_path=pg_catalog,permit,pg_temp');
  await db.query('INSERT INTO users(email) VALUES($1)',[input.email]);
  assert.deepEqual(await bootstrapInitialCeo(input,authDatabaseDeps(db)),{outcome:'conflict',reason:'email_unavailable'});
  assert.deepEqual((await db.query('SELECT user_id FROM privileged_access_events')).rows,[]);
  const output:string[]=[];
  assert.equal(await runBootstrapCeoCli({execute:async()=>{throw new Error(input.password);},error:(s)=>output.push(s)}),false);
  assert.deepEqual(output,['bootstrap:ceo: failed safely']);
 }finally{await db.close();}
});
