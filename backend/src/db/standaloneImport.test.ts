import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { login } from '../domain/auth/login.js';
import { historicalDatabase, installedDatabase } from '../test/permitSchemaFixtures.js';
import { FAKE_PASSWORD, PEOPLE, produceStandaloneHistory } from '../test/standaloneHistory.js';
import type { QueryFn } from './pool.js';
import { importStandalone } from './standaloneImport.js';

/**
 * The standalone -> shared import tool (auth identities + all Permit data)
 * on a real 0001-0038 replay produced by the real services, into a fully
 * migrated `permit` schema installed without reference data.
 */

let source: PGlite;
let target: PGlite;
const q = (db: PGlite): QueryFn => ((text: string, params?: unknown[]) => db.query(text, params)) as unknown as QueryFn;

async function run(mode: 'dry-run' | 'execute' | 'verify') {
  await target.exec('SET ROLE permit_migrator; SET search_path = pg_catalog, permit, pg_temp');
  try {
    return await importStandalone({ source: q(source), target: q(target) }, { mode });
  } finally {
    await target.exec('RESET ROLE; SET search_path = pg_catalog');
  }
}

before(async () => {
  source = await historicalDatabase();
  await produceStandaloneHistory({ query: (t, p) => source.query(t, p), exec: (s) => source.exec(s) });
  target = await installedDatabase({ baselineReferenceData: false });
});

after(async () => {
  await source?.close();
  await target?.close();
});

test('refusals: unsupported hash, duplicate normalized email, unresolved identity reference - nothing written', async () => {
  const hse = PEOPLE.hse.id;
  const saved = (await source.query<{ email: string; encrypted_password: string }>(
    'SELECT email, encrypted_password FROM auth.users WHERE id = $1', [hse])).rows[0]!;

  await source.query(`UPDATE auth.users SET encrypted_password = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA' WHERE id = $1`, [hse]);
  let result = await run('execute');
  assert.equal(result.ok, false);
  assert.deepEqual(result.report.identityProblems, [{ kind: 'unsupported_hash', userId: hse }]);
  assert.ok(result.report.hashPrefixCounts['$argon2id$'] === 1);
  assert.ok(!JSON.stringify(result.report).includes('aGFzaA'), 'no hash material in the report');

  await source.query('UPDATE auth.users SET encrypted_password = $2, email = $3 WHERE id = $1',
    [hse, saved.encrypted_password, ' APPLICANT@example.TEST']);
  result = await run('execute');
  assert.deepEqual(result.report.identityProblems, [{ kind: 'duplicate_email', userId: hse }]);
  assert.ok(!JSON.stringify(result.report).includes('example'), 'no email in the report');
  await source.query('UPDATE auth.users SET email = $2 WHERE id = $1', [hse, saved.email]);

  // A history row whose user has no identity (the standalone foreign key
  // is dropped only for this fixture step, then restored).
  const ghost = '52000000-0000-4000-8000-0000000000ff';
  await source.exec(`ALTER TABLE public.notifications DROP CONSTRAINT notifications_recipient_user_id_fkey;
    ALTER TABLE public.notifications DISABLE TRIGGER USER`);
  const [row] = (await source.query<{ id: string; recipient_user_id: string }>(
    'SELECT id, recipient_user_id FROM public.notifications ORDER BY id LIMIT 1')).rows;
  await source.query('UPDATE public.notifications SET recipient_user_id = $2 WHERE id = $1', [row!.id, ghost]);
  result = await run('execute');
  assert.deepEqual(result.report.identityProblems, [{ kind: 'missing_identity', userId: ghost }]);
  await source.query('UPDATE public.notifications SET recipient_user_id = $2 WHERE id = $1', [row!.id, row!.recipient_user_id]);
  await source.exec(`ALTER TABLE public.notifications ENABLE TRIGGER USER;
    ALTER TABLE public.notifications ADD CONSTRAINT notifications_recipient_user_id_fkey
    FOREIGN KEY (recipient_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT`);

  assert.equal((await target.query<{ n: number }>('SELECT count(*)::int AS n FROM permit.users')).rows[0]!.n, 0);
  assert.equal((await target.query<{ n: number }>('SELECT count(*)::int AS n FROM permit.permits')).rows[0]!.n, 0);
});

test('dry run performs and verifies the whole import, then rolls back', async () => {
  const { ok, report } = await run('dry-run');
  assert.equal(ok, true, JSON.stringify(report.problems));
  assert.equal(report.committed, false);
  assert.equal(report.users.source, 5);
  assert.equal((await target.query<{ n: number }>('SELECT count(*)::int AS n FROM permit.users')).rows[0]!.n, 0);
});

test('execute: identities, every table and every sequence reconcile; all 20 relationships resolve', async () => {
  const { ok, report } = await run('execute');
  assert.equal(ok, true, JSON.stringify(report.problems));
  assert.equal(report.committed, true);
  assert.deepEqual(report.users, { source: 5, target: 5, match: true });
  assert.ok(Object.values(report.tables).every((t) => t.match));
  assert.ok(report.tables.permits!.source >= 4 && report.tables.permit_signatures!.source >= 2);
  assert.equal(report.sequences.match, true);
  assert.deepEqual(report.preexisting, { capabilities: 1 }, 'only 0041 adds a row the standalone never had');

  const references = Object.entries(report.identityReferences);
  assert.equal(references.length, 20, 'the 20 former auth.users foreign keys');
  for (const [column, count] of references) assert.ok(count > 0, `${column} is exercised by the fixture`);

  const users = (await target.query<{ id: string; email: string; password_scheme: string }>(
    'SELECT id::text, email, password_scheme FROM permit.users ORDER BY id')).rows;
  assert.deepEqual(users.map((u) => u.id), Object.values(PEOPLE).map((p) => p.id).sort(), 'UUIDs preserved');
  assert.deepEqual(users.map((u) => u.email).sort(),
    ['applicant@example.test', 'ceo.person@example.test', 'cro@example.test', 'hse@example.test', 'site.manager@example.test']);
  assert.ok(users.every((u) => u.password_scheme === 'bcrypt_legacy'));
});

test('first sign-in with an imported bcrypt password works and upgrades it to Argon2id', async () => {
  await target.exec('SET ROLE permit_runtime; SET search_path = pg_catalog, permit, pg_temp');
  try {
    const deps = {
      query: q(target),
      withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) =>
        target.transaction(async (tx) => fn({ query: tx.query.bind(tx) } as unknown as PoolClient)),
    };
    for (const person of [PEOPLE.cro, PEOPLE.ceo]) {
      assert.equal((await login({ email: person.email.trim().toUpperCase(), password: FAKE_PASSWORD, remember: false }, deps)).outcome, 'ok');
      assert.equal((await login({ email: person.email, password: 'wrong', remember: false }, deps)).outcome, 'invalid_credentials');
    }
  } finally {
    await target.exec('RESET ROLE; SET search_path = pg_catalog');
  }
  const schemes = (await target.query<{ id: string; password_scheme: string; password_hash: string }>(
    'SELECT id::text, password_scheme, password_hash FROM permit.users WHERE id = ANY($1::uuid[])', [[PEOPLE.cro.id, PEOPLE.ceo.id]])).rows;
  assert.ok(schemes.every((s) => s.password_scheme === 'argon2id' && s.password_hash.startsWith('$argon2id$')));
});

test('verify mode re-reconciles read-only (upgraded hashes aside); a second execute is refused', async () => {
  const verified = await run('verify');
  assert.equal(verified.ok, true, JSON.stringify(verified.report.problems));
  const again = await run('execute');
  assert.equal(again.ok, false);
  assert.match(again.report.problems.join('\n'), /already holds/);
  const triggers = await target.query(`SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE c.relnamespace = 'permit'::regnamespace AND NOT t.tgisinternal AND t.tgenabled <> 'O'`);
  assert.equal(triggers.rows.length, 0, 'every user trigger enabled again');
});
