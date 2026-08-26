import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPoolConfig } from './pool.js';
import { getMigrationDatabaseUrl } from './migrate.js';

const runtime = 'postgresql://api_user:runtime_secret@db.example.test:5432/app';
const migration = 'postgresql://migration_owner:migration_secret@db.example.test:5432/app';

test('normal API pool configuration uses only DATABASE_URL supplied to it', () => {
  assert.equal(buildPoolConfig(runtime).connectionString, runtime);
});

test('migration runner requires and returns the separate MIGRATION_DATABASE_URL', () => {
  assert.equal(getMigrationDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: migration }), migration);
  assert.throws(() => getMigrationDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: undefined }));
});

test('migration runner rejects the same credentials even when URL spelling/query parameters differ', () => {
  assert.throws(() => getMigrationDatabaseUrl({
    DATABASE_URL: runtime,
    MIGRATION_DATABASE_URL: `${runtime}?application_name=migrator`,
  }));
});

test('migration runner compares normalized PostgreSQL role identity, never passwords or URL spelling', () => {
  const sameRoleVariants = [
    'postgresql://api_user:different_password@db.example.test:5432/app',
    'postgresql://api_user:different_password@DB.EXAMPLE.TEST/app?sslmode=require',
    'postgresql://api%5Fuser:different_password@db.example.test/app#ignored',
  ];
  for (const candidate of sameRoleVariants) {
    assert.throws(
      () => getMigrationDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: candidate }),
      { message: 'Runtime and migration database credentials must use different PostgreSQL roles.' },
    );
  }
});

test('migration runner allows different case-sensitive PostgreSQL roles on the same database', () => {
  assert.equal(getMigrationDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: migration }), migration);
  const caseDistinctRole = 'postgresql://API_USER:migration_secret@db.example.test:5432/app';
  assert.equal(getMigrationDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: caseDistinctRole }), caseDistinctRole);
});

test('migration runner does not over-generalize role identity across different databases or hosts', () => {
  for (const candidate of [
    'postgresql://api_user:x@db.example.test:5432/other_app',
    'postgresql://api_user:x@other-db.example.test:5432/app',
    'postgresql://api_user:x@[::1]:5432/app',
  ]) assert.equal(getMigrationDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: candidate }), candidate);
});

test('database credential validation never logs either connection string', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { lines.push(values.join(' ')); };
  try {
    assert.throws(() => getMigrationDatabaseUrl({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: runtime }));
  } finally {
    console.error = original;
  }
  assert.doesNotMatch(lines.join('\n'), /runtime_secret|migration_secret|db\.example\.test/);
});
