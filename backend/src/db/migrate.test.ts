import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { contentSha256, migratePermitSchema } from './migrate.js';
import {
  asMigrationDb,
  BASELINE_DIR,
  MIGRATIONS_DIR,
  installedDatabase,
  provisionedDatabase,
  runAsMigrator,
} from '../test/permitSchemaFixtures.js';

/**
 * The Permit migration runner in the shared E-Set database: installs the
 * verified 0038 baseline once, continues with 0039+, keeps its own ledger
 * in `permit`, and fails closed whenever the schema boundary or the
 * recorded history cannot be trusted.
 */

async function scratchRepo(): Promise<{ migrations: string; baseline: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), 'permit-migrate-'));
  const migrations = path.join(root, 'migrations');
  const baseline = path.join(root, 'baseline');
  await cp(MIGRATIONS_DIR, migrations, { recursive: true });
  await cp(BASELINE_DIR, baseline, { recursive: true });
  return { migrations, baseline, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail('expected the runner to refuse');
}

test('first run installs the baseline, records 0001-0038 with their hashes, then applies 0039+; re-runs are no-ops', async () => {
  const db = await provisionedDatabase();
  try {
    assert.equal(await runAsMigrator(db), 44);
    const ledger = await db.query<{ name: string; applied_via: string; content_sha256: string }>(
      'SELECT name, applied_via, content_sha256 FROM permit.schema_migrations ORDER BY name');
    assert.equal(ledger.rows.length, 44);
    assert.equal(ledger.rows[0]!.name, '0001_revoke_execute_rls_auto_enable.sql');
    assert.equal(ledger.rows[37]!.name, '0038_organization_deactivation_runtime_privilege.sql');
    assert.equal(ledger.rows[38]!.name, '0039_permit_owned_authentication.sql');
    assert.equal(ledger.rows[39]!.name, '0040_permit_storage.sql');
    assert.equal(ledger.rows[40]!.name, '0041_permit_cms.sql');
    assert.equal(ledger.rows[41]!.name, '0042_permit_renderer_v4.sql');
    assert.equal(ledger.rows[42]!.name, '0043_storage_connection_lifecycle_guards.sql');
    assert.equal(ledger.rows[43]!.name, '0044_managed_upload_requests.sql');
    for (const [index, row] of ledger.rows.entries()) {
      assert.equal(row.applied_via, index < 38 ? 'baseline:permit_0038_v2' : 'migration');
      assert.equal(row.content_sha256, contentSha256(await readFile(path.join(MIGRATIONS_DIR, row.name), 'utf8')));
    }
    assert.equal(await runAsMigrator(db), 0);
    const public_ = await db.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace`);
    assert.deepEqual(public_.rows, [], 'the ledger and every object stay out of public');
  } finally {
    await db.close();
  }
});

test('the runner refuses a superuser, a missing schema, or a schema it does not own', async () => {
  const db = await provisionedDatabase();
  try {
    // PGlite's session user is a superuser.
    assert.match(await refusal(migratePermitSchema(asMigrationDb(db), { log: () => undefined })), /must not be superuser/);
    await db.exec('ALTER SCHEMA permit OWNER TO permit_runtime');
    assert.match(await refusal(runAsMigrator(db)), /must exist and be owned by the migration role/);
    await db.exec('DROP SCHEMA permit');
    assert.match(await refusal(runAsMigrator(db)), /must exist and be owned by the migration role/);
  } finally {
    await db.close();
  }
});

test('the runner refuses to adopt a permit schema that has objects but no ledger', async () => {
  const db = await provisionedDatabase();
  try {
    await db.exec('SET ROLE permit_migrator; CREATE TABLE permit.stray (id int); ALTER TABLE permit.stray ENABLE ROW LEVEL SECURITY; RESET ROLE;');
    assert.match(await refusal(runAsMigrator(db)), /has objects but no migration ledger/);
  } finally {
    await db.close();
  }
});

test('the runner refuses when a historical migration or a baseline file no longer matches the manifest', async () => {
  const repo = await scratchRepo();
  const db = await provisionedDatabase();
  try {
    const historical = path.join(repo.migrations, '0017_employee_account_password_management.sql');
    await writeFile(historical, `${await readFile(historical, 'utf8')}\n-- edited\n`);
    assert.match(await refusal(runAsMigrator(db, { migrationsDir: repo.migrations, baselineDir: repo.baseline })),
      /0017_employee_account_password_management\.sql differs from the baseline manifest/);

    await cp(MIGRATIONS_DIR, repo.migrations, { recursive: true, force: true });
    const privileges = path.join(repo.baseline, '0038_permit_privileges.sql');
    await writeFile(privileges, (await readFile(privileges, 'utf8')).replace(
      'GRANT SELECT ON permit.capabilities TO permit_runtime;',
      'GRANT SELECT, INSERT ON permit.capabilities TO permit_runtime;'));
    assert.match(await refusal(runAsMigrator(db, { migrationsDir: repo.migrations, baselineDir: repo.baseline })),
      /0038_permit_privileges\.sql differs from the baseline manifest/);

    const ledger = await db.query(`SELECT to_regclass('permit.schema_migrations') AS ledger`);
    assert.deepEqual(ledger.rows, [{ ledger: null }], 'nothing was installed');
  } finally {
    await db.close();
    await repo.cleanup();
  }
});

test('CRLF checkouts verify identically (hashes normalize line endings)', () => {
  assert.equal(contentSha256('a\r\nb\r\n'), contentSha256('a\nb\n'));
});

test('later migrations apply in their own transaction and are recorded with their hash', async () => {
  const repo = await scratchRepo();
  const db = await installedDatabase({ baselineDir: BASELINE_DIR });
  try {
    await writeFile(path.join(repo.migrations, '0042_example.sql'), `
      CREATE TABLE permit.example (id int PRIMARY KEY);
      ALTER TABLE permit.example ENABLE ROW LEVEL SECURITY;
    `);
    assert.equal(await runAsMigrator(db, { migrationsDir: repo.migrations, baselineDir: repo.baseline }), 1);
    const row = await db.query<{ applied_via: string }>(
      `SELECT applied_via FROM permit.schema_migrations WHERE name = '0042_example.sql'`);
    assert.deepEqual(row.rows, [{ applied_via: 'migration' }]);

    // An applied migration may not be edited afterwards.
    await writeFile(path.join(repo.migrations, '0042_example.sql'), '-- rewritten history');
    assert.match(await refusal(runAsMigrator(db, { migrationsDir: repo.migrations, baselineDir: repo.baseline })),
      /0042_example\.sql was modified after it was applied/);
  } finally {
    await db.close();
    await repo.cleanup();
  }
});

test('a migration that breaks the schema boundary is rolled back and not recorded', async () => {
  const cases: [string, string, RegExp][] = [
    ['0042_public_table.sql', 'CREATE TABLE public.leak (id int);', /permission denied/],
    ['0042_unprotected.sql', 'CREATE TABLE permit.unprotected (id int);', /RLS is disabled on permit tables: unprotected/],
    ['0042_public_grant.sql', 'GRANT SELECT ON permit.permits TO PUBLIC;', /PUBLIC or a Supabase browser role/],
    ['0042_browser_grant.sql', 'GRANT SELECT ON permit.permits TO anon;', /PUBLIC or a Supabase browser role/],
    ['0042_unpolicied.sql', `CREATE TABLE permit.extra (id int); ALTER TABLE permit.extra ENABLE ROW LEVEL SECURITY;
                             GRANT SELECT ON permit.extra TO permit_runtime;`, /no RLS policy on: extra/],
    ['0042_other_schema.sql', 'CREATE SCHEMA sideways;', /permission denied/],
  ];
  for (const [file, sql, expected] of cases) {
    const repo = await scratchRepo();
    const db = await installedDatabase();
    try {
      await writeFile(path.join(repo.migrations, file), sql);
      const message = await refusal(runAsMigrator(db, { migrationsDir: repo.migrations, baselineDir: repo.baseline }));
      assert.match(message, expected, file);
      const recorded = await db.query(`SELECT 1 FROM permit.schema_migrations WHERE name = $1`, [file]);
      assert.equal(recorded.rows.length, 0, `${file} must not be recorded`);
      const leaked = await db.query(`SELECT relname FROM pg_class WHERE relname IN ('leak', 'unprotected', 'extra')`);
      assert.deepEqual(leaked.rows, [], `${file} must be rolled back`);
    } finally {
      await db.close();
      await repo.cleanup();
    }
  }
});

test('a migration file numbered inside the baseline but missing from the ledger is refused', async () => {
  const repo = await scratchRepo();
  const db = await installedDatabase();
  try {
    await writeFile(path.join(repo.migrations, '0020_backdated.sql'), 'SELECT 1;');
    const message = await refusal(runAsMigrator(db, { migrationsDir: repo.migrations, baselineDir: repo.baseline }));
    assert.ok(/do not match the baseline manifest|inside the baseline/.test(message), message);
  } finally {
    await db.close();
    await repo.cleanup();
  }
});
