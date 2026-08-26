import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL(
  '../../../database/migrations/0014_fix_trigger_function_search_paths.sql',
  import.meta.url,
);

test('0014 pins both trigger-function search paths without changing invoker mode', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE FUNCTION public.notifications_restrict_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      CREATE FUNCTION public.permit_document_jobs_restrict_update() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
    `);

    await db.exec(await readFile(migrationUrl, 'utf8'));

    const result = await db.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(`
      SELECT proname, prosecdef, proconfig
      FROM pg_catalog.pg_proc
      WHERE oid IN (
        'public.notifications_restrict_update()'::regprocedure,
        'public.permit_document_jobs_restrict_update()'::regprocedure
      )
      ORDER BY proname
    `);

    assert.deepEqual(result.rows, [
      {
        proname: 'notifications_restrict_update',
        prosecdef: false,
        proconfig: ['search_path=pg_catalog'],
      },
      {
        proname: 'permit_document_jobs_restrict_update',
        prosecdef: false,
        proconfig: ['search_path=pg_catalog'],
      },
    ]);
  } finally {
    await db.close();
  }
});
