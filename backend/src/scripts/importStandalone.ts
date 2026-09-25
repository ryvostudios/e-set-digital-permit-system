import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { env } from '../config/env.js';
import { getMigrationDatabaseUrl } from '../db/migrate.js';
import { buildSslConfig, type QueryFn } from '../db/pool.js';
import { importStandalone, type ImportMode } from '../db/standaloneImport.js';

/**
 * Standalone -> shared Permit import (src/db/standaloneImport.ts).
 *
 *   STANDALONE_DATABASE_URL=<standalone, ideally a read-only login> \
 *   MIGRATION_DATABASE_URL=<shared, permit_migrator> \
 *     npm run data:import-standalone                 # dry run (default)
 *     npm run data:import-standalone -- --execute    # import, verify, commit
 *     npm run data:import-standalone -- --verify     # re-reconcile read-only
 *   [-- --allow-accounts-without-password]           # only with an approved controlled reset
 *
 * Prints the JSON report (counts, digests, ids of problem rows, hash-format
 * prefixes - never emails, hashes or content). Exit 2 when not clean.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode: ImportMode = args.includes('--execute') ? 'execute' : args.includes('--verify') ? 'verify' : 'dry-run';
  const sourceUrl = process.env.STANDALONE_DATABASE_URL;
  if (!sourceUrl) throw new Error('STANDALONE_DATABASE_URL is required');
  const source = new Client({ connectionString: sourceUrl, ssl: buildSslConfig() });
  const target = new Client({ connectionString: getMigrationDatabaseUrl(env), ssl: buildSslConfig() });
  await source.connect();
  await target.connect();
  try {
    const { ok, report } = await importStandalone(
      { source: source.query.bind(source) as QueryFn, target: target.query.bind(target) as QueryFn },
      { mode, allowAccountsWithoutPassword: args.includes('--allow-accounts-without-password') });
    console.log(JSON.stringify(report, null, 2));
    if (!ok) process.exitCode = 2;
  } finally {
    await source.end();
    await target.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    // Driver errors can carry row values: print only the class and code.
    const code = (error as { code?: string }).code;
    console.error(`data:import-standalone failed safely${code ? ` (${code})` : ''}: ${error instanceof Error && !code ? error.message : 'database error'}`);
    process.exitCode = 1;
  });
}
