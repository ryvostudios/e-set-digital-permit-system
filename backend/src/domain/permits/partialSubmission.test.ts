import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile, readdir } from 'node:fs/promises';
import { hasMeaningfulSubmissionContent } from './formCompleteness.js';
import {
  answeredJsaV2,
  blankJsaFormV2,
  blankPermitV2,
  partialPermitV2,
} from '../../test/v2Forms.js';
import { parseJsaFormV2, parsePermitFormV2 } from './formsV2.js';
import type { PermitType } from './forms.js';

/**
 * A PERMIT MAY BE SUBMITTED PARTIALLY COMPLETED.
 *
 * The authoritative forms are printed to cover every job the company
 * does, so most of their questions do not apply to any particular one.
 * Requiring an answer to all of them before submission produced pressure
 * to tick something to get past the gate, which is the opposite of what a
 * safety document is for. Blank now means what it says, the CRO reviews
 * what was supplied, and the send-back path handles the rest.
 *
 * The one thing still refused is a document with nothing in it at all -
 * an empty permit submitted by mis-click.
 */

const TYPES: PermitType[] = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'];

// ---------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------

test('a blank document of ANY permit type carries no content', () => {
  for (const type of TYPES) {
    assert.equal(
      hasMeaningfulSubmissionContent(blankPermitV2(type), blankJsaFormV2()),
      false,
      `${type}: an untouched draft must not count as content`,
    );
  }
});

test('one entered value is enough, for every permit type', () => {
  for (const type of TYPES) {
    assert.equal(
      hasMeaningfulSubmissionContent(partialPermitV2(type), blankJsaFormV2()),
      true,
      `${type}: a partially completed permit must be submittable`,
    );
  }
});

test('an N/A answer is content, because choosing it is a judgement', () => {
  const blank = blankPermitV2('COLD_WORK') as { sections: Record<string, Record<string, unknown>> };
  const sectionId = Object.keys(blank.sections)[0]!;
  const itemId = Object.keys(blank.sections[sectionId]!)[0]!;
  assert.equal(hasMeaningfulSubmissionContent(blank, blankJsaFormV2()), false);

  blank.sections[sectionId]![itemId] = { response: 'NA' };
  assert.equal(hasMeaningfulSubmissionContent(blank, blankJsaFormV2()), true);
});

test('an unticked box is NOT content - it is what every blank draft starts as', () => {
  const blank = blankPermitV2('HOT_WORK') as { natureOfWork: Record<string, boolean> };
  const optionId = Object.keys(blank.natureOfWork)[0]!;

  blank.natureOfWork[optionId] = false;
  assert.equal(hasMeaningfulSubmissionContent(blank, blankJsaFormV2()), false, 'false must not count');

  blank.natureOfWork[optionId] = true;
  assert.equal(hasMeaningfulSubmissionContent(blank, blankJsaFormV2()), true, 'a ticked box is a person acting');
});

test('whitespace is not content', () => {
  const blank = blankPermitV2('COLD_WORK');
  assert.equal(hasMeaningfulSubmissionContent({ ...blank, workWindow: { area: '   ' } }, blankJsaFormV2()), false);
  assert.equal(hasMeaningfulSubmissionContent({ ...blank, workWindow: { area: 'Bay 3' } }, blankJsaFormV2()), true);
});

test('a JSA describing the job makes the submission meaningful on its own', () => {
  // Permit and JSA are one document to the person filling them, so a
  // permit whose JSA is filled in is plainly not an accidental blank.
  assert.equal(hasMeaningfulSubmissionContent(blankPermitV2('WTG_WORK'), answeredJsaV2()), true);
});

test('many blank fields alongside one answer still submit', () => {
  // The business case exactly: most of a long printed form does not apply.
  const partial = partialPermitV2('WTG_WORK') as { sections: Record<string, Record<string, { response: string | null }>> };
  const blankCount = Object.values(partial.sections)
    .flatMap((section) => Object.values(section))
    .filter((answer) => answer.response === null).length;
  assert.ok(blankCount > 10, 'this fixture is genuinely mostly blank');
  assert.equal(hasMeaningfulSubmissionContent(partial, blankJsaFormV2()), true);
});

// ---------------------------------------------------------------------
// Nothing is fabricated, and the payloads stay valid
// ---------------------------------------------------------------------

test('blank and partial payloads are still VALID V2 documents - the schema never required answers', () => {
  for (const type of TYPES) {
    for (const [label, form] of [['blank', blankPermitV2(type)], ['partial', partialPermitV2(type)]] as const) {
      const parsed = parsePermitFormV2(type, form);
      assert.equal(parsed.ok, true, `${type} ${label} must parse: ${JSON.stringify((parsed as { issues?: unknown }).issues)}`);
    }
  }
  assert.equal(parseJsaFormV2(blankJsaFormV2()).ok, true);
});

test('a blank answer stays null after validation - no default is substituted', () => {
  const parsed = parsePermitFormV2('WTG_WORK', partialPermitV2('WTG_WORK'));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const sections = (parsed.data as { sections: Record<string, Record<string, { response: string | null }>> }).sections;
  const answers = Object.values(sections).flatMap((section) => Object.values(section));
  assert.ok(answers.some((answer) => answer.response === null), 'blanks survive as null');
  // Not YES, not NO, not NA - nothing was invented on the applicant's behalf.
  assert.ok(!answers.some((answer) => answer.response === 'YES'), 'no fabricated YES');
});

// ---------------------------------------------------------------------
// End to end against the real database and the real service
// ---------------------------------------------------------------------

const migrationsDirectory = new URL('../../../../database/migrations/', import.meta.url);
const APPLICANT = '50000000-0000-4000-8000-0000000000a1';

async function migratedDatabase(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${APPLICANT}');
    CREATE TABLE public.schema_migrations (id integer PRIMARY KEY, name text NOT NULL);
    CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog
    AS $$
    DECLARE command record;
    BEGIN
      IF TG_TAG <> 'CREATE TABLE' THEN RETURN; END IF;
      FOR command IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
        IF command.object_type = 'table' AND command.schema_name = 'public' THEN
          EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', command.object_identity);
        END IF;
      END LOOP;
    END;
    $$;
    CREATE EVENT TRIGGER rls_auto_enable_trigger ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.rls_auto_enable();
  `);
  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const name of names) await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
  return db;
}

test('the DATABASE stores a partial permit exactly as entered, blanks included', async () => {
  const db = await migratedDatabase();
  try {
    for (const type of TYPES) {
      const form = partialPermitV2(type);
      const version = `${type}_V2`;
      await db.query(
        `WITH new_jsa AS (
           INSERT INTO jsas (created_by, form_version, form_payload)
           VALUES ($1, 'JSA_V2', $2::jsonb) RETURNING id
         )
         INSERT INTO permits (jsa_id, created_by, site_timezone, status, permit_type, form_version, form_payload)
         SELECT id, $1, 'Asia/Karachi', 'DRAFT', $3, $4, $5::jsonb FROM new_jsa`,
        [APPLICANT, JSON.stringify(blankJsaFormV2()), type, version, JSON.stringify(form)],
      );

      const stored = await db.query<{ form_payload: unknown }>(
        `SELECT form_payload FROM permits WHERE form_version = $1`, [version],
      );
      // Byte-for-byte what the applicant supplied: no defaults added, no
      // blanks filled, no answers invented.
      assert.deepEqual(stored.rows[0]?.form_payload, form, `${type} must round-trip unchanged`);
    }
  } finally {
    await db.close();
  }
});
