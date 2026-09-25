import type { PoolClient } from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import type { QueryFn } from '../db/pool.js';
import type { AccountsServiceDeps } from '../domain/accounts/service.js';

/** Real disposable SQL transactions for auth service tests. */
export function authDatabaseDeps(db: PGlite): AccountsServiceDeps {
  return {
    query: db.query.bind(db) as QueryFn,
    withTransaction: (fn) => db.transaction(async (tx) =>
      fn({ query: tx.query.bind(tx) } as unknown as PoolClient)),
  };
}
