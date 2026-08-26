import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationUrl = new URL('../../../database/migrations/0016_permit_jsa_business_forms.sql', import.meta.url);

const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';
const TEAM_POSITION_A = '40000000-0000-4000-8000-000000000001';
const TEAM_POSITION_B = '40000000-0000-4000-8000-000000000002';
const PERMIT_ID = '20000000-0000-4000-8000-000000000001';
const JSA_ID = '90000000-0000-4000-8000-000000000001';

/**
 * The pre-0016 shape of every table this migration touches, reduced to
 * the columns/constraints the migration itself depends on - the same
 * approach `migration0015.test.ts` already uses, so these tests exercise
 * the REAL migration SQL rather than a paraphrase of it.
 */
async function createBaseDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${USER_A}'), ('${USER_B}');

    CREATE TABLE teams (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE positions (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE team_positions (
      id uuid PRIMARY KEY,
      team_id uuid NOT NULL REFERENCES teams (id),
      position_id uuid NOT NULL REFERENCES positions (id)
    );
    CREATE TABLE user_team_positions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
      team_position_id uuid NOT NULL REFERENCES team_positions (id) ON DELETE RESTRICT,
      CONSTRAINT user_team_positions_unique UNIQUE (user_id, team_position_id)
    );

    INSERT INTO teams VALUES ('70000000-0000-4000-8000-000000000001', 'Operations');
    INSERT INTO positions VALUES ('80000000-0000-4000-8000-000000000001', 'Control Room Operator');
    INSERT INTO team_positions VALUES
      ('${TEAM_POSITION_A}', '70000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001'),
      ('${TEAM_POSITION_B}', '70000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001');
    INSERT INTO user_team_positions (user_id, team_position_id) VALUES ('${USER_A}', '${TEAM_POSITION_A}');

    CREATE TABLE jsas (
      id uuid PRIMARY KEY,
      jsa_sequence bigint NOT NULL,
      created_by uuid NOT NULL REFERENCES auth.users (id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE permits (
      id uuid PRIMARY KEY,
      permit_sequence bigint NOT NULL,
      jsa_id uuid NOT NULL REFERENCES jsas (id),
      status text NOT NULL,
      created_by uuid NOT NULL REFERENCES auth.users (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE permit_lifecycle_events (
      id uuid PRIMARY KEY,
      ordinal bigserial NOT NULL,
      permit_id uuid NOT NULL REFERENCES permits (id),
      event_type text NOT NULL,
      actor_user_id uuid NOT NULL REFERENCES auth.users (id)
    );
    CREATE TABLE issued_document_snapshots (id uuid PRIMARY KEY, permit_id uuid NOT NULL REFERENCES permits (id));
    CREATE TABLE permit_document_jobs (
      id uuid PRIMARY KEY,
      snapshot_id uuid NOT NULL REFERENCES issued_document_snapshots (id),
      status text NOT NULL,
      renderer_version text,
      expected_file_hash text,
      CONSTRAINT permit_document_jobs_render_identity_consistent CHECK (
        (renderer_version IS NULL AND expected_file_hash IS NULL)
        OR (renderer_version = 'PDFKIT_V1' AND expected_file_hash IS NOT NULL AND btrim(expected_file_hash) <> '')
      )
    );

    CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog
      AS $$ BEGIN RAISE EXCEPTION '% on %.% is not permitted - this table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME; END; $$;

    INSERT INTO jsas (id, jsa_sequence, created_by) VALUES ('${JSA_ID}', 1, '${USER_A}');
    INSERT INTO permits (id, permit_sequence, jsa_id, status, created_by)
      VALUES ('${PERMIT_ID}', 1, '${JSA_ID}', 'DRAFT', '${USER_A}');
  `);
  return db;
}

async function applyMigration(db: PGlite): Promise<void> {
  await db.exec(await readFile(migrationUrl, 'utf8'));
}

async function migratedDb(): Promise<PGlite> {
  const db = await createBaseDb();
  await applyMigration(db);
  return db;
}

/** Completes the permit + JSA forms so the permit may legally leave DRAFT. */
async function completeForms(db: PGlite): Promise<void> {
  await db.exec(`
    UPDATE jsas SET form_version = 'JSA_V1', form_payload = '{"page1":{},"page2":{}}'::jsonb WHERE id = '${JSA_ID}';
    UPDATE permits SET permit_type = 'WTG_WORK', form_version = 'WTG_WORK_V1', form_payload = '{"windFarm":"Jhimpir"}'::jsonb
      WHERE id = '${PERMIT_ID}';
  `);
}

async function recordEvent(db: PGlite, id: string, eventType: string, actor: string): Promise<void> {
  await db.exec(
    `INSERT INTO permit_lifecycle_events (id, permit_id, event_type, actor_user_id)
     VALUES ('${id}', '${PERMIT_ID}', '${eventType}', '${actor}')`,
  );
}

test('0016 applies cleanly on the 0015 schema and adds only the intended objects', async () => {
  const db = await migratedDb();
  try {
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name IN ('workforce_profiles', 'permit_signatures')
        ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows.map((r) => r.table_name), ['permit_signatures', 'workforce_profiles']);

    const permitColumns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'permits'
          AND column_name IN ('permit_type', 'form_version', 'form_payload', 'wind_farm', 'wtg_number', 'work_description', 'loto_number')
        ORDER BY column_name`,
    );
    assert.equal(permitColumns.rows.length, 7);

    const jsaColumns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'jsas' AND column_name IN ('form_version', 'form_payload', 'site_or_wtg', 'job_description', 'updated_at')`,
    );
    assert.equal(jsaColumns.rows.length, 5);
  } finally {
    await db.close();
  }
});

test('workforce_profiles and permit_signatures are RLS-enabled, default-deny, with no browser grants and no policies', async () => {
  const db = await migratedDb();
  try {
    const rls = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `SELECT relname, relrowsecurity FROM pg_class
        WHERE relname IN ('workforce_profiles', 'permit_signatures') ORDER BY relname`,
    );
    assert.deepEqual(rls.rows, [
      { relname: 'permit_signatures', relrowsecurity: true },
      { relname: 'workforce_profiles', relrowsecurity: true },
    ]);

    const policies = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_policies
        WHERE tablename IN ('workforce_profiles', 'permit_signatures')`,
    );
    assert.equal(policies.rows[0]?.count, 0);

    const grants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_table_grants
        WHERE table_name IN ('workforce_profiles', 'permit_signatures')
          AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
    );
    assert.equal(grants.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});

test('a workforce profile must name a primary Team + Position THAT SAME USER actually holds', async () => {
  const db = await migratedDb();
  try {
    // USER_A holds TEAM_POSITION_A - accepted.
    await db.exec(
      `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
       VALUES ('${USER_A}', 'Bilal Ahmed', '${TEAM_POSITION_A}')`,
    );

    // USER_B holds nothing - a profile naming someone else's assignment
    // is refused by the composite foreign key, not merely by app code.
    await assert.rejects(
      db.exec(
        `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
         VALUES ('${USER_B}', 'Impostor', '${TEAM_POSITION_A}')`,
      ),
    );

    // A designation nobody holds is refused too.
    await assert.rejects(
      db.exec(
        `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
         VALUES ('${USER_B}', 'Impostor', '${TEAM_POSITION_B}')`,
      ),
    );

    // A blank display name can never be stored.
    await db.exec(`INSERT INTO user_team_positions (user_id, team_position_id) VALUES ('${USER_B}', '${TEAM_POSITION_B}')`);
    await assert.rejects(
      db.exec(
        `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
         VALUES ('${USER_B}', '   ', '${TEAM_POSITION_B}')`,
      ),
    );
  } finally {
    await db.close();
  }
});

test("a profile's underlying assignment cannot be deleted out from under it (ON DELETE RESTRICT)", async () => {
  const db = await migratedDb();
  try {
    await db.exec(
      `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
       VALUES ('${USER_A}', 'Bilal Ahmed', '${TEAM_POSITION_A}')`,
    );
    await assert.rejects(
      db.exec(`DELETE FROM user_team_positions WHERE user_id = '${USER_A}' AND team_position_id = '${TEAM_POSITION_A}'`),
    );
  } finally {
    await db.close();
  }
});

test('workforce profile timestamps are database-authoritative and created_at is preserved across updates', async () => {
  const db = await migratedDb();
  try {
    await db.exec(
      `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, created_at, updated_at)
       VALUES ('${USER_A}', 'Bilal Ahmed', '${TEAM_POSITION_A}', '1999-01-01', '1999-01-01')`,
    );
    const inserted = await db.query<{ created_at: Date; updated_at: Date }>(
      `SELECT created_at, updated_at FROM workforce_profiles WHERE user_id = '${USER_A}'`,
    );
    // The supplied 1999 timestamps were overwritten by the trigger.
    assert.ok(inserted.rows[0]!.created_at.getUTCFullYear() > 2000);

    const originalCreatedAt = inserted.rows[0]!.created_at.toISOString();
    await db.exec(
      `UPDATE workforce_profiles SET display_name = 'Bilal A.', created_at = '1999-01-01' WHERE user_id = '${USER_A}'`,
    );
    const updated = await db.query<{ created_at: Date; display_name: string }>(
      `SELECT created_at, display_name FROM workforce_profiles WHERE user_id = '${USER_A}'`,
    );
    assert.equal(updated.rows[0]!.created_at.toISOString(), originalCreatedAt);
    assert.equal(updated.rows[0]!.display_name, 'Bilal A.');
  } finally {
    await db.close();
  }
});

test('a permit may only be incomplete while it is a DRAFT', async () => {
  const db = await migratedDb();
  try {
    // Still DRAFT with no form at all - allowed.
    await db.exec(`UPDATE permits SET updated_at = now() WHERE id = '${PERMIT_ID}'`);

    // Leaving DRAFT without a form is refused by the database.
    await assert.rejects(db.exec(`UPDATE permits SET status = 'PENDING_CRO' WHERE id = '${PERMIT_ID}'`));

    // With the permit form but no JSA form, the cross-table constraint
    // trigger still refuses it.
    await db.exec(
      `UPDATE permits SET permit_type = 'WTG_WORK', form_version = 'WTG_WORK_V1', form_payload = '{"windFarm":"Jhimpir"}'::jsonb
        WHERE id = '${PERMIT_ID}'`,
    );
    await assert.rejects(db.exec(`UPDATE permits SET status = 'PENDING_CRO' WHERE id = '${PERMIT_ID}'`));

    await completeForms(db);
    await db.exec(`UPDATE permits SET status = 'PENDING_CRO' WHERE id = '${PERMIT_ID}'`);
    const row = await db.query<{ status: string }>(`SELECT status FROM permits WHERE id = '${PERMIT_ID}'`);
    assert.equal(row.rows[0]?.status, 'PENDING_CRO');
  } finally {
    await db.close();
  }
});

test('a permit type can never disagree with its form version, and only the four V1 templates exist', async () => {
  const db = await migratedDb();
  try {
    await assert.rejects(
      db.exec(`UPDATE permits SET permit_type = 'WTG_WORK', form_version = 'COLD_WORK_V1' WHERE id = '${PERMIT_ID}'`),
    );
    await assert.rejects(
      db.exec(`UPDATE permits SET permit_type = 'ELECTRICAL_WORK', form_version = 'ELECTRICAL_WORK_V1' WHERE id = '${PERMIT_ID}'`),
    );
    await assert.rejects(
      db.exec(`UPDATE permits SET permit_type = NULL, form_version = 'WTG_WORK_V1' WHERE id = '${PERMIT_ID}'`),
    );
    await assert.rejects(
      db.exec(`UPDATE permits SET form_payload = '"a string"'::jsonb WHERE id = '${PERMIT_ID}'`),
    );
    await assert.rejects(
      db.exec(`UPDATE jsas SET form_version = 'JSA_V2', form_payload = '{}'::jsonb WHERE id = '${JSA_ID}'`),
    );
  } finally {
    await db.close();
  }
});

test('a signature can only ever name the AUTHENTICATED ACTOR of its own lifecycle event', async () => {
  const db = await migratedDb();
  try {
    await completeForms(db);
    await recordEvent(db, '50000000-0000-4000-8000-000000000001', 'SUBMITTED', USER_A);

    // The genuine applicant signature is accepted.
    await db.exec(
      `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
         signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
       VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000001', 'APPLICANT', '${USER_A}',
         'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
    );

    // Someone else's identity against the same authenticated act is refused.
    await recordEvent(db, '50000000-0000-4000-8000-000000000002', 'APPLICANT_RESUBMITTED', USER_A);
    await assert.rejects(
      db.exec(
        `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
           signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
         VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000002', 'APPLICANT', '${USER_B}',
           'Impostor', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
      ),
    );
  } finally {
    await db.close();
  }
});

test('CRO fallback approval can never produce an HSE signature at the database level', async () => {
  const db = await migratedDb();
  try {
    await completeForms(db);
    await recordEvent(db, '50000000-0000-4000-8000-000000000003', 'CRO_FALLBACK_APPROVED', USER_A);

    // Attempting to record the fallback act as an HSE approval is refused.
    await assert.rejects(
      db.exec(
        `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
           signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
         VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000003', 'HSE', '${USER_A}',
           'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
      ),
    );

    // The same act recorded honestly, as CRO FALLBACK, is accepted.
    await db.exec(
      `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
         signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
       VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000003', 'CRO_FALLBACK', '${USER_A}',
         'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
    );
    const rows = await db.query<{ signature_role: string }>(
      `SELECT signature_role FROM permit_signatures WHERE permit_id = '${PERMIT_ID}'`,
    );
    assert.deepEqual(rows.rows.map((r) => r.signature_role), ['CRO_FALLBACK']);
  } finally {
    await db.close();
  }
});

test('every signature role is pinned to the exact lifecycle event that can produce it', async () => {
  const db = await migratedDb();
  try {
    await completeForms(db);
    await recordEvent(db, '50000000-0000-4000-8000-000000000004', 'CLOSED', USER_A);
    for (const role of ['APPLICANT', 'CRO', 'HSE', 'CRO_FALLBACK', 'RENEWAL']) {
      await assert.rejects(
        db.exec(
          `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
             signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
           VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000004', '${role}', '${USER_A}',
             'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
        ),
        `a CLOSED event must not be able to produce a ${role} signature`,
      );
    }
    await assert.rejects(
      db.exec(
        `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
           signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
         VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000004', 'WITNESS', '${USER_A}',
           'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
      ),
    );
  } finally {
    await db.close();
  }
});

test('recorded signatures are append-only for every role, including the backend itself', async () => {
  const db = await migratedDb();
  try {
    await completeForms(db);
    await recordEvent(db, '50000000-0000-4000-8000-000000000005', 'HSE_APPROVED', USER_A);
    await db.exec(
      `INSERT INTO permit_signatures (id, permit_id, source_event_id, signature_role, signer_user_id,
         signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
       VALUES ('60000000-0000-4000-8000-000000000001', '${PERMIT_ID}', '50000000-0000-4000-8000-000000000005',
         'HSE', '${USER_A}', 'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
    );

    await assert.rejects(
      db.exec(`UPDATE permit_signatures SET signer_display_name = 'Someone Else' WHERE id = '60000000-0000-4000-8000-000000000001'`),
    );
    await assert.rejects(db.exec(`DELETE FROM permit_signatures WHERE id = '60000000-0000-4000-8000-000000000001'`));
    await assert.rejects(db.exec('TRUNCATE permit_signatures'));

    // One signature per authenticated act, even under a retry.
    await assert.rejects(
      db.exec(
        `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
           signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
         VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000005', 'HSE', '${USER_A}',
           'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
      ),
    );
  } finally {
    await db.close();
  }
});

test('changing a profile after a signature was recorded cannot alter that signature', async () => {
  const db = await migratedDb();
  try {
    await completeForms(db);
    await db.exec(
      `INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id)
       VALUES ('${USER_A}', 'Bilal Ahmed', '${TEAM_POSITION_A}')`,
    );
    await recordEvent(db, '50000000-0000-4000-8000-000000000006', 'HSE_APPROVED', USER_A);
    await db.exec(
      `INSERT INTO permit_signatures (permit_id, source_event_id, signature_role, signer_user_id,
         signer_display_name, signer_team_position_id, signer_team_name, signer_position_name)
       VALUES ('${PERMIT_ID}', '50000000-0000-4000-8000-000000000006', 'HSE', '${USER_A}',
         'Bilal Ahmed', '${TEAM_POSITION_A}', 'Operations', 'Control Room Operator')`,
    );

    // The person is renamed and re-designated afterwards.
    await db.exec(`UPDATE teams SET name = 'Operations (Renamed)' WHERE id = '70000000-0000-4000-8000-000000000001'`);
    await db.exec(`UPDATE positions SET name = 'Senior Control Room Operator' WHERE id = '80000000-0000-4000-8000-000000000001'`);
    await db.exec(`UPDATE workforce_profiles SET display_name = 'B. Ahmed' WHERE user_id = '${USER_A}'`);

    const signature = await db.query<{ signer_display_name: string; signer_team_name: string; signer_position_name: string }>(
      `SELECT signer_display_name, signer_team_name, signer_position_name FROM permit_signatures WHERE permit_id = '${PERMIT_ID}'`,
    );
    assert.deepEqual(signature.rows[0], {
      signer_display_name: 'Bilal Ahmed',
      signer_team_name: 'Operations',
      signer_position_name: 'Control Room Operator',
    });
  } finally {
    await db.close();
  }
});

test('the renderer allowlist is widened, never replaced, and an established identity stays frozen', async () => {
  const db = await migratedDb();
  try {
    await db.exec(`INSERT INTO issued_document_snapshots VALUES ('a0000000-0000-4000-8000-000000000001', '${PERMIT_ID}')`);
    await db.exec(
      `INSERT INTO permit_document_jobs (id, snapshot_id, status, renderer_version, expected_file_hash)
       VALUES ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'PENDING', 'PDFKIT_V2', 'expected')`,
    );
    // The historical renderer identity remains valid.
    await db.exec(`INSERT INTO issued_document_snapshots VALUES ('a0000000-0000-4000-8000-000000000002', '${PERMIT_ID}')`);
    await db.exec(
      `INSERT INTO permit_document_jobs (id, snapshot_id, status, renderer_version, expected_file_hash)
       VALUES ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000002', 'PENDING', 'PDFKIT_V1', 'expected')`,
    );
    // Anything outside the allowlist is still refused.
    await db.exec(`INSERT INTO issued_document_snapshots VALUES ('a0000000-0000-4000-8000-000000000003', '${PERMIT_ID}')`);
    await assert.rejects(
      db.exec(
        `INSERT INTO permit_document_jobs (id, snapshot_id, status, renderer_version, expected_file_hash)
         VALUES ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000003', 'PENDING', 'HAND_ROLLED_V1', 'expected')`,
      ),
    );
  } finally {
    await db.close();
  }
});

test('0016 refuses to apply against pre-form permits that are already beyond DRAFT', async () => {
  const db = await createBaseDb();
  try {
    await db.exec(`UPDATE permits SET status = 'ISSUED' WHERE id = '${PERMIT_ID}'`);
    await assert.rejects(applyMigration(db), (error: unknown) => {
      assert.match(String(error), /0016 refused/);
      return true;
    });
  } finally {
    await db.close();
  }
});

test('every function 0016 adds is SECURITY INVOKER with a pinned search_path, and none is granted to browser roles', async () => {
  const db = await migratedDb();
  try {
    const functions = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
        WHERE proname IN (
          'workforce_profiles_authoritative_timestamps',
          'jsas_authoritative_timestamps',
          'permit_requires_completed_jsa',
          'permit_signature_authenticity_guard'
        )
        ORDER BY proname`,
    );
    assert.equal(functions.rows.length, 4);
    for (const row of functions.rows) {
      assert.equal(row.prosecdef, false, `${row.proname} must be SECURITY INVOKER`);
      assert.ok(
        row.proconfig?.some((entry) => entry === 'search_path=pg_catalog'),
        `${row.proname} must pin search_path`,
      );
    }

    const grants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.routine_privileges
        WHERE routine_name IN (
          'workforce_profiles_authoritative_timestamps', 'jsas_authoritative_timestamps',
          'permit_requires_completed_jsa', 'permit_signature_authenticity_guard'
        ) AND grantee IN ('anon', 'authenticated', 'PUBLIC')`,
    );
    assert.equal(grants.rows[0]?.count, 0);
  } finally {
    await db.close();
  }
});
