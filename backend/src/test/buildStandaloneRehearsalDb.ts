import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';
import { markLegacyDocumentsGenerated, produceStandaloneHistory } from './standaloneHistory.js';

/**
 * REHEARSAL ONLY. Fills a disposable local database that already holds the
 * 0001-0038 replay (the standalone schema, see database/baseline/tools/
 * generate-baseline.sh for the replay) with the synthetic standalone
 * history, and writes the legacy document objects to a local directory
 * standing in for the old Supabase Storage bucket.
 *
 *   STANDALONE_REHEARSAL_URL=postgresql://…@localhost:…/permit_standalone \
 *   LEGACY_OBJECTS_DIR=<empty dir> npx tsx src/test/buildStandaloneRehearsalDb.ts
 */
async function main(): Promise<void> {
  const url = new URL(process.env.STANDALONE_REHEARSAL_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('local disposable databases only');
  const objectsDir = process.env.LEGACY_OBJECTS_DIR;
  if (!objectsDir) throw new Error('LEGACY_OBJECTS_DIR is required');
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const db = { query: (text: string, params?: unknown[]) => client.query(text, params), exec: (sql: string) => client.query(sql) };
    await produceStandaloneHistory(db);
    const objects = await markLegacyDocumentsGenerated(db);
    for (const [key, bytes] of objects) {
      await mkdir(path.join(objectsDir, path.dirname(key)), { recursive: true });
      await writeFile(path.join(objectsDir, key), bytes, { flag: 'wx' });
    }
    console.log(JSON.stringify({ legacyObjects: objects.size }));
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(`standalone rehearsal build failed: ${error instanceof Error ? error.message : 'error'}`);
    process.exitCode = 1;
  });
}
