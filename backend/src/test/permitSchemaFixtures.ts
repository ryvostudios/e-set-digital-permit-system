/**
 * Database fixtures for the shared-database (`permit` schema) tests.
 *
 * `historicalDatabase()` is the standalone Permit database as it exists
 * today: migrations 0001-0038 replayed into `public` under the same
 * Supabase platform emulation the baseline generator uses.
 *
 * `provisionedDatabase()` is a fresh database prepared the way
 * database/roles/provision-permit-roles.sql prepares the shared one:
 * the three Permit roles and an empty `permit` schema owned by
 * permit_migrator. `auth.users` is a TEST STUB for the transitional
 * Supabase Auth foreign keys only; it is not part of the target
 * architecture.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { migratePermitSchema, type MigrationDb, type MigrationOptions } from '../db/migrate.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../database/migrations/', import.meta.url));
export const BASELINE_DIR = fileURLToPath(new URL('../../../database/baseline/', import.meta.url));

export function asMigrationDb(db: PGlite): MigrationDb {
  return {
    query: (text, params) => db.query(text, params) as never,
    exec: (sql) => db.exec(sql),
  };
}

export async function historicalDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE ROLE app_runtime NOLOGIN BYPASSRLS NOINHERIT;
    CREATE ROLE privileged_runtime NOLOGIN NOBYPASSRLS NOINHERIT;
  `);
  await db.exec(await readFile(`${BASELINE_DIR}tools/supabase-platform-emulation.sql`, 'utf8'));
  await db.exec(`
    SET search_path = "$user", public, extensions;
    CREATE TABLE public.schema_migrations (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
  `);
  const names = (await readdir(MIGRATIONS_DIR)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of names.filter((n) => n <= '0038_~')) {
    await db.exec(await readFile(`${MIGRATIONS_DIR}${name}`, 'utf8'));
  }
  await db.exec('SET search_path = pg_catalog');
  return db;
}

export async function provisionedDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);

    CREATE ROLE permit_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    CREATE ROLE permit_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    CREATE ROLE permit_privileged LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    ALTER ROLE permit_migrator SET search_path = pg_catalog, permit, pg_temp;
    ALTER ROLE permit_runtime SET search_path = pg_catalog, permit, pg_temp;
    ALTER ROLE permit_privileged SET search_path = pg_catalog, permit, pg_temp;
    CREATE SCHEMA permit AUTHORIZATION permit_migrator;
    REVOKE ALL ON SCHEMA permit FROM PUBLIC;
    GRANT USAGE ON SCHEMA auth TO permit_migrator;
    GRANT REFERENCES (id) ON auth.users TO permit_migrator;
  `);
  return db;
}

/**
 * Runs the real migration runner as permit_migrator. SET ROLE (not SET
 * SESSION AUTHORIZATION, which PGlite cannot reset) so the fixture session
 * returns to the superuser afterwards; the runner only relies on current_user.
 */
export async function runAsMigrator(db: PGlite, options: MigrationOptions = {}): Promise<number> {
  await db.exec('SET ROLE permit_migrator');
  try {
    return await migratePermitSchema(asMigrationDb(db), { log: () => undefined, ...options });
  } finally {
    await db.exec('RESET ROLE; SET search_path = pg_catalog');
  }
}

export async function installedDatabase(options: MigrationOptions = {}): Promise<PGlite> {
  const db = await provisionedDatabase();
  await runAsMigrator(db, options);
  return db;
}
