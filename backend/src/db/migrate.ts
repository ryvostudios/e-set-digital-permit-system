import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { env } from '../config/env.js';
import { buildSslConfig, toSafeDbErrorMessage } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../database/migrations');
const BASELINE_DIR = path.resolve(__dirname, '../../../database/baseline');

/**
 * Permit lives in its own schema of the shared E-Set database. Every
 * Permit object, and the Permit migration ledger, is in `permit`; nothing
 * here reads or writes `public` (ESDMS) or its ledger (`public.pgmigrations`).
 * See docs/SHARED_DATABASE.md.
 */
export const PERMIT_SCHEMA = 'permit';
const LEDGER = 'permit.schema_migrations';
const SESSION_SEARCH_PATH = 'SET search_path = pg_catalog, permit, pg_temp';
// Session settings a pg_dump preamble (or a migration) may change. Reset
// individually: RESET ALL would also reset ROLE.
const RESET_SESSION = [
  'check_function_bodies', 'row_security', 'client_min_messages', 'xmloption',
  'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout',
].map((name) => `RESET ${name};`).join(' ') + ` ${SESSION_SEARCH_PATH};`;

// Arbitrary, stable Permit-only key (unchanged from the standalone runner).
// Serializes Permit migration runs via a session-level advisory lock held
// on this dedicated client. It does not collide with node-pg-migrate's
// fixed key used by ESDMS.
const MIGRATION_LOCK_KEY = 7_298_183_340;

const BASELINE_FILES = ['0038_permit_schema.sql', '0038_permit_reference_data.sql', '0038_permit_privileges.sql'] as const;

/** The subset of a PostgreSQL connection the runner needs (pg Client or PGlite). */
export interface MigrationDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Executes a multi-statement SQL script. */
  exec(sql: string): Promise<unknown>;
}

export interface BaselineManifest {
  baseline: string;
  representsThrough: string;
  historicalMigrations: { name: string; sha256: string }[];
  files: Record<string, string>;
}

export interface MigrationOptions {
  migrationsDir?: string;
  baselineDir?: string;
  /**
   * `false` installs the baseline without its seeded reference rows. Used
   * only when the installation is the target of a data migration that
   * brings the real rows (with their original identifiers).
   */
  baselineReferenceData?: boolean;
  log?: (line: string) => void;
}

export class MigrationSafetyError extends Error {}
class MigrationDirectoryError extends Error {}

/** SHA-256 over content with CRLF normalized, so Windows checkouts verify identically. */
export function contentSha256(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

async function readDirSql(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
  } catch (err) {
    throw new MigrationDirectoryError(
      `Unable to read migrations directory (${dir}): ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

/**
 * Loads the 0038 baseline and proves it still corresponds to the audited
 * history: every historical migration file and every baseline file must
 * match manifest.json byte-for-byte (modulo line endings).
 */
export async function loadBaseline(migrationsDir = MIGRATIONS_DIR, baselineDir = BASELINE_DIR) {
  const manifest = JSON.parse(await readFile(path.join(baselineDir, 'manifest.json'), 'utf8')) as BaselineManifest;
  const historical = (await readDirSql(migrationsDir)).filter((file) => file <= manifest.representsThrough);
  const expected = manifest.historicalMigrations.map((entry) => entry.name);
  if (JSON.stringify(historical) !== JSON.stringify(expected)) {
    throw new MigrationSafetyError('Historical migration files do not match the baseline manifest.');
  }
  for (const entry of manifest.historicalMigrations) {
    if (contentSha256(await readFile(path.join(migrationsDir, entry.name), 'utf8')) !== entry.sha256) {
      throw new MigrationSafetyError(`Historical migration ${entry.name} differs from the baseline manifest.`);
    }
  }
  const files: Record<string, string> = {};
  for (const name of BASELINE_FILES) {
    const sql = await readFile(path.join(baselineDir, name), 'utf8');
    if (contentSha256(sql) !== manifest.files[name]) {
      throw new MigrationSafetyError(`Baseline file ${name} differs from the baseline manifest.`);
    }
    files[name] = sql;
  }
  return { manifest, files };
}

async function one<T>(db: MigrationDb, text: string, params?: unknown[]): Promise<T> {
  const { rows } = await db.query<T>(text, params);
  return rows[0]!;
}

/**
 * Refuses to run unless the connection is a dedicated, unprivileged
 * Permit migration identity that owns schema `permit` and cannot create
 * anything in `public`.
 */
export async function assertSafeMigrationIdentity(db: MigrationDb): Promise<void> {
  const role = await one<{ unsafe: boolean }>(db,
    `SELECT (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AS unsafe
       FROM pg_catalog.pg_roles WHERE rolname = current_user`);
  if (role.unsafe) {
    throw new MigrationSafetyError('The migration role must not be superuser, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION.');
  }
  const schema = await one<{ owned: boolean | null }>(db,
    `SELECT pg_catalog.pg_get_userbyid(nspowner) = current_user AS owned
       FROM pg_catalog.pg_namespace WHERE nspname = $1`, [PERMIT_SCHEMA]);
  if (!schema?.owned) {
    throw new MigrationSafetyError('Schema permit must exist and be owned by the migration role (see database/roles).');
  }
  const publicCreate = await one<{ allowed: boolean }>(db,
    `SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'public')
            AND pg_catalog.has_schema_privilege('public', 'CREATE') AS allowed`);
  if (publicCreate.allowed) {
    throw new MigrationSafetyError('The migration role can CREATE in schema public; refusing to run.');
  }
  const roles = await one<{ missing: number }>(db,
    `SELECT 2 - count(*)::int AS missing FROM pg_catalog.pg_roles
      WHERE rolname IN ('permit_runtime', 'permit_privileged')`);
  if (roles.missing !== 0) {
    throw new MigrationSafetyError('Roles permit_runtime and permit_privileged must be provisioned first.');
  }
  await assertSchemaBoundary(db);
}

/**
 * The shared-database boundary, checked before any work and again inside
 * every migration transaction before it commits: the migration role owns
 * nothing outside `permit`, every Permit table keeps RLS, and neither
 * PUBLIC nor a Supabase browser role nor a BYPASSRLS runtime has crept in.
 */
export async function assertSchemaBoundary(db: MigrationDb): Promise<void> {
  const outside = await db.query<{ object: string }>(`
    WITH me AS (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user),
    foreign_ns AS (
      SELECT oid, nspname FROM pg_catalog.pg_namespace
       WHERE nspname <> $1 AND nspname <> 'pg_toast'
         AND nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%')
    SELECT 'relation ' || n.nspname || '.' || c.relname AS object
      FROM pg_catalog.pg_class c JOIN foreign_ns n ON n.oid = c.relnamespace
     WHERE c.relowner = (SELECT oid FROM me)
    UNION ALL
    SELECT 'function ' || n.nspname || '.' || p.proname
      FROM pg_catalog.pg_proc p JOIN foreign_ns n ON n.oid = p.pronamespace
     WHERE p.proowner = (SELECT oid FROM me)
    UNION ALL
    SELECT 'type ' || n.nspname || '.' || t.typname
      FROM pg_catalog.pg_type t JOIN foreign_ns n ON n.oid = t.typnamespace
     WHERE t.typowner = (SELECT oid FROM me)
    UNION ALL
    SELECT 'schema ' || nspname FROM foreign_ns
     WHERE oid IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspowner = (SELECT oid FROM me))`,
  [PERMIT_SCHEMA]);
  if (outside.rows.length > 0) {
    throw new MigrationSafetyError(
      `The Permit migration role owns objects outside schema permit: ${outside.rows.map((r) => r.object).join(', ')}`);
  }
  const noRls = await db.query<{ relname: string }>(
    `SELECT relname FROM pg_catalog.pg_class
      WHERE relnamespace = $1::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity`, [PERMIT_SCHEMA]);
  if (noRls.rows.length > 0) {
    throw new MigrationSafetyError(`RLS is disabled on permit tables: ${noRls.rows.map((r) => r.relname).join(', ')}`);
  }
  const exposed = await db.query<{ name: string }>(`
    SELECT DISTINCT c.relname AS name
      FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
     WHERE c.relnamespace = $1::regnamespace
       AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles
                                            WHERE rolname IN ('anon', 'authenticated', 'service_role')))
    UNION
    SELECT DISTINCT p.proname
      FROM pg_catalog.pg_proc p,
           pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
     WHERE p.pronamespace = $1::regnamespace
       AND (a.grantee = 0 OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles
                                            WHERE rolname IN ('anon', 'authenticated', 'service_role')))`,
  [PERMIT_SCHEMA]);
  if (exposed.rows.length > 0) {
    throw new MigrationSafetyError(
      `PUBLIC or a Supabase browser role holds a privilege on: ${exposed.rows.map((r) => r.name).join(', ')}`);
  }
  const unpolicied = await db.query<{ relname: string }>(`
    SELECT c.relname FROM pg_catalog.pg_class c
     WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r'
       AND (pg_catalog.has_table_privilege('permit_runtime', c.oid, 'SELECT, INSERT, UPDATE, DELETE')
            OR pg_catalog.has_any_column_privilege('permit_runtime', c.oid, 'SELECT, INSERT, UPDATE'))
       AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies p
                        WHERE p.schemaname = c.relnamespace::regnamespace::text AND p.tablename = c.relname
                          AND p.roles = ARRAY['permit_runtime']::name[])`, [PERMIT_SCHEMA]);
  if (unpolicied.rows.length > 0) {
    throw new MigrationSafetyError(
      `permit_runtime has privileges but no RLS policy on: ${unpolicied.rows.map((r) => r.relname).join(', ')}`);
  }
  const bypass = await one<{ count: number }>(db,
    `SELECT count(*)::int AS count FROM pg_catalog.pg_roles
      WHERE rolname IN ('permit_runtime', 'permit_privileged', current_user) AND rolbypassrls`);
  if (bypass.count !== 0) {
    throw new MigrationSafetyError('A Permit role has BYPASSRLS.');
  }
}

async function ledgerExists(db: MigrationDb): Promise<boolean> {
  const row = await one<{ exists: boolean }>(db, `SELECT pg_catalog.to_regclass($1) IS NOT NULL AS exists`, [LEDGER]);
  return row.exists;
}

async function inTransaction(db: MigrationDb, work: () => Promise<void>): Promise<void> {
  await db.query('BEGIN');
  try {
    await work();
    await assertSchemaBoundary(db);
    await db.query('COMMIT');
  } catch (err) {
    try {
      await db.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', toSafeDbErrorMessage(rollbackErr));
    }
    throw err;
  }
}

/**
 * Installs the verified 0038 baseline into an EMPTY `permit` schema and
 * records historical migrations 0001-0038 as applied by that baseline,
 * with their content hashes, in one transaction.
 */
async function installBaseline(
  db: MigrationDb,
  baseline: Awaited<ReturnType<typeof loadBaseline>>,
  referenceData: boolean,
  log: (line: string) => void,
): Promise<void> {
  const occupied = await one<{ count: number }>(db, `
    SELECT (SELECT count(*) FROM pg_catalog.pg_class WHERE relnamespace = $1::regnamespace)
         + (SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace = $1::regnamespace)
         + (SELECT count(*) FROM pg_catalog.pg_type WHERE typnamespace = $1::regnamespace) AS count`,
  [PERMIT_SCHEMA]);
  if (Number(occupied.count) !== 0) {
    throw new MigrationSafetyError('Schema permit has objects but no migration ledger; refusing to guess its state.');
  }
  const appliedVia = `baseline:${baseline.manifest.baseline}${referenceData ? '' : ':without-reference-data'}`;
  log(`Installing baseline ${baseline.manifest.baseline} (through ${baseline.manifest.representsThrough})`);
  await inTransaction(db, async () => {
    await db.exec(`
      CREATE TABLE permit.schema_migrations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        applied_via TEXT NOT NULL CHECK (applied_via = 'migration' OR applied_via LIKE 'baseline:%'),
        content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$')
      );
      ALTER TABLE permit.schema_migrations ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON TABLE permit.schema_migrations FROM PUBLIC;
      REVOKE ALL ON SEQUENCE permit.schema_migrations_id_seq FROM PUBLIC;`);
    await db.exec(baseline.files['0038_permit_schema.sql']!);
    if (referenceData) await db.exec(baseline.files['0038_permit_reference_data.sql']!);
    // The dump preamble changes session settings; restore them before the
    // hand-written privileges run.
    await db.exec(RESET_SESSION);
    await db.exec(baseline.files['0038_permit_privileges.sql']!);
    for (const entry of baseline.manifest.historicalMigrations) {
      await db.query(
        'INSERT INTO permit.schema_migrations (name, applied_via, content_sha256) VALUES ($1, $2, $3)',
        [entry.name, appliedVia, entry.sha256]);
    }
  });
}

/**
 * The recorded history must still be the history on disk: the baseline
 * rows equal the manifest, and no applied migration file has been edited
 * or removed.
 */
async function assertLedgerMatchesDisk(
  db: MigrationDb,
  baseline: Awaited<ReturnType<typeof loadBaseline>>,
  files: string[],
  migrationsDir: string,
): Promise<Set<string>> {
  const { rows } = await db.query<{ name: string; applied_via: string; content_sha256: string }>(
    'SELECT name, applied_via, content_sha256 FROM permit.schema_migrations ORDER BY name');
  const baselineRows = rows.filter((row) => row.applied_via.startsWith('baseline:'));
  const expected = baseline.manifest.historicalMigrations;
  if (baselineRows.length !== expected.length ||
      baselineRows.some((row, i) => row.name !== expected[i]!.name || row.content_sha256 !== expected[i]!.sha256)) {
    throw new MigrationSafetyError('The permit migration ledger does not match the baseline manifest.');
  }
  for (const row of rows.filter((r) => r.applied_via === 'migration')) {
    if (!files.includes(row.name)) {
      throw new MigrationSafetyError(`Applied migration ${row.name} is missing from the migrations directory.`);
    }
    if (contentSha256(await readFile(path.join(migrationsDir, row.name), 'utf8')) !== row.content_sha256) {
      throw new MigrationSafetyError(`Applied migration ${row.name} was modified after it was applied.`);
    }
  }
  return new Set(rows.map((row) => row.name));
}

/**
 * Brings schema `permit` to the latest migration: installs the 0038
 * baseline on first run, then applies 0039+ one per transaction.
 * Every step is bounded by the schema checks above and fails closed.
 */
export async function migratePermitSchema(db: MigrationDb, options: MigrationOptions = {}): Promise<number> {
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR;
  const log = options.log ?? console.log;
  await db.exec(SESSION_SEARCH_PATH);
  await assertSafeMigrationIdentity(db);

  const baseline = await loadBaseline(migrationsDir, options.baselineDir ?? BASELINE_DIR);
  let applied = 0;
  if (!(await ledgerExists(db))) {
    await installBaseline(db, baseline, options.baselineReferenceData ?? true, log);
    applied += baseline.manifest.historicalMigrations.length;
  }

  const files = await readDirSql(migrationsDir);
  const recorded = await assertLedgerMatchesDisk(db, baseline, files, migrationsDir);
  const pending = files.filter((file) => !recorded.has(file));
  const beforeBaseline = pending.filter((file) => file <= baseline.manifest.representsThrough);
  if (beforeBaseline.length > 0) {
    throw new MigrationSafetyError(`Migrations numbered inside the baseline are not recorded: ${beforeBaseline.join(', ')}`);
  }

  for (const file of pending) {
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    log(`Applying migration: ${file}`);
    await inTransaction(db, async () => {
      await db.exec(sql);
      await db.exec(RESET_SESSION);
      await db.query(
        `INSERT INTO permit.schema_migrations (name, applied_via, content_sha256) VALUES ($1, 'migration', $2)`,
        [file, contentSha256(sql)]);
    });
    applied += 1;
  }
  return applied;
}

export function getMigrationDatabaseUrl(config: Pick<typeof env, 'DATABASE_URL' | 'MIGRATION_DATABASE_URL'> = env): string {
  if (!config.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required to run migrations');
  const runtime = new URL(config.DATABASE_URL);
  const migration = new URL(config.MIGRATION_DATABASE_URL);

  const databaseIdentity = (url: URL) => ({
    hostname: url.hostname.toLowerCase(),
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname),
    role: decodeURIComponent(url.username),
  });
  const runtimeIdentity = databaseIdentity(runtime);
  const migrationIdentity = databaseIdentity(migration);
  const sameDatabaseRole = runtimeIdentity.hostname === migrationIdentity.hostname &&
    runtimeIdentity.port === migrationIdentity.port &&
    runtimeIdentity.database === migrationIdentity.database &&
    runtimeIdentity.role === migrationIdentity.role;
  if (sameDatabaseRole) {
    throw new Error('Runtime and migration database credentials must use different PostgreSQL roles.');
  }
  return config.MIGRATION_DATABASE_URL;
}

export async function runMigrations(options: MigrationOptions = {}): Promise<void> {
  const client = new Client({
    connectionString: getMigrationDatabaseUrl(),
    ssl: buildSslConfig(),
  });

  await client.connect();
  const db: MigrationDb = {
    query: async (text, params) => client.query(text, params) as never,
    exec: (sql) => client.query(sql),
  };

  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    const applied = await migratePermitSchema(db, options);
    console.log(applied === 0 ? 'No pending migrations.' : `Applied ${applied} migration(s).`);
  } finally {
    if (lockAcquired) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch (unlockErr) {
        console.error('Failed to release migration advisory lock:', toSafeDbErrorMessage(unlockErr));
      }
    }
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const baselineReferenceData = !process.argv.includes('--baseline-without-reference-data');
  runMigrations({ baselineReferenceData }).catch((err: unknown) => {
    if (err instanceof MigrationDirectoryError || err instanceof MigrationSafetyError ||
        (err instanceof Error && err.message.startsWith('MIGRATION_DATABASE_URL'))) {
      console.error('Migration run failed:', err.message);
    } else {
      console.error('Migration run failed:', toSafeDbErrorMessage(err));
    }
    process.exit(1);
  });
}
