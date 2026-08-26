import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { env } from '../config/env.js';
import { buildSslConfig, toSafeDbErrorMessage } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../database/migrations');

// Arbitrary, stable per-project key. Serializes migration runs via a
// PostgreSQL session-level advisory lock (held on this dedicated client).
const MIGRATION_LOCK_KEY = 7_298_183_340;

// Every statement here is idempotent (safe to re-run on every migration
// invocation, whether schema_migrations already existed or was just
// created): CREATE TABLE IF NOT EXISTS, ENABLE ROW LEVEL SECURITY, and
// REVOKE all no-op cleanly when already applied. This table is never
// readable/writable by anon/authenticated (or PUBLIC) - only the
// backend's own database role (table owner) uses it.
async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query('ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY');
  await client.query('REVOKE ALL ON TABLE schema_migrations FROM PUBLIC, anon, authenticated');
}

async function getAppliedMigrations(client: Client): Promise<Set<string>> {
  const result = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(result.rows.map((row) => row.name));
}

class MigrationDirectoryError extends Error {}

async function getMigrationFiles(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (err) {
    throw new MigrationDirectoryError(
      `Unable to read migrations directory (${MIGRATIONS_DIR}): ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  return entries.filter((file) => file.endsWith('.sql')).sort();
}

async function applyMigration(client: Client, file: string): Promise<void> {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  console.log(`Applying migration: ${file}`);
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error(`Rollback failed for migration ${file}:`, toSafeDbErrorMessage(rollbackErr));
    }
    throw err;
  }
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

export async function runMigrations(): Promise<void> {
  const client = new Client({
    connectionString: getMigrationDatabaseUrl(),
    ssl: buildSslConfig(),
  });

  await client.connect();

  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    lockAcquired = true;

    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);
    const files = await getMigrationFiles();
    const pending = files.filter((file) => !applied.has(file));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    for (const file of pending) {
      await applyMigration(client, file);
    }

    console.log(`Applied ${pending.length} migration(s).`);
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
  runMigrations().catch((err: unknown) => {
    if (err instanceof MigrationDirectoryError || (err instanceof Error && err.message.startsWith('MIGRATION_DATABASE_URL'))) {
      console.error('Migration run failed:', err.message);
    } else {
      console.error('Migration run failed:', toSafeDbErrorMessage(err));
    }
    process.exit(1);
  });
}
