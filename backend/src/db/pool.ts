import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../config/env.js';

let pool: Pool | undefined;

/** Thrown when TLS is enabled but the configured CA certificate can't be loaded. */
export class DbTlsConfigError extends Error {}

/**
 * Builds the `ssl` option for a pg Pool/Client. Certificate verification is
 * always kept enabled — never sets rejectUnauthorized: false. When DB_SSL
 * is enabled and DB_CA_CERT_PATH is configured, that CA is loaded and
 * pinned; if it can't be read, this fails closed (throws) rather than
 * silently falling back to unpinned trust.
 */
export function buildSslConfig(): PoolConfig['ssl'] {
  if (!env.DB_SSL) return undefined;
  if (!env.DB_CA_CERT_PATH) return true;

  try {
    return { ca: readFileSync(env.DB_CA_CERT_PATH, 'utf8') };
  } catch {
    throw new DbTlsConfigError('Unable to read the configured database CA certificate');
  }
}

function buildPoolConfig(): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    ssl: buildSslConfig(),
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
  };
}

/** Formats a database error for logging without leaking query text, connection details, or credentials. */
export function toSafeDbErrorMessage(err: unknown): string {
  if (err instanceof DbTlsConfigError) {
    return err.message;
  }
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return `database error (code ${(err as { code: string }).code})`;
  }
  return 'unknown database error';
}

/** Lazily creates (or returns) the process-wide connection pool. */
export function getPool(): Pool {
  if (!pool) {
    const newPool = new Pool(buildPoolConfig());
    newPool.on('error', (err) => {
      console.error('Unexpected error on idle database client:', toSafeDbErrorMessage(err));
    });
    pool = newPool;
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Runs `fn` inside a single transaction, committing on success and rolling back on error. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Transaction rollback failed:', toSafeDbErrorMessage(rollbackErr));
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Closes the pool. Safe to call even if the pool was never created. */
export async function closePool(): Promise<void> {
  if (pool) {
    const closing = pool;
    pool = undefined;
    await closing.end();
  }
}
