import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration0035Url = new URL(
  '../../../database/migrations/0035_dynamic_organization_management.sql',
  import.meta.url,
);
const migration0036Url = new URL(
  '../../../database/migrations/0036_permit_applicant_company_contract.sql',
  import.meta.url,
);

/**
 * THE APPLICANT-COMPANY IDENTITY CONTRACT.
 *
 * 0035 was the EXPAND step: it added `applicant_company_id` but did not
 * require it, so the then-deployed backend could keep writing the three
 * legacy snapshot columns while the migration went out ahead of the
 * deploy. 0036 closes that window.
 *
 * These specs run the REAL 0035 and 0036 SQL, in order, against the
 * shape those migrations actually see - so the contract is proved by the
 * database rather than asserted about it. What matters most:
 *
 *   * an overlap row written by the OLD backend is backfilled, not
 *     guessed at and not skipped;
 *   * an unresolvable company code ABORTS the migration rather than
 *     leaving a silent gap;
 *   * afterwards a completed identity without its authoritative company
 *     is impossible, while a permit with NO identity is still perfectly
 *     valid - an ordinary DRAFT must not be forced to have an applicant;
 *   * nothing organizational, and no frozen snapshot, is disturbed.
 */

const ESET = '18000000-0000-4000-8000-000000000001';
const ZPL = '18000000-0000-4000-8000-000000000002';
const SGRE = '18000000-0000-4000-8000-000000000003';

/** The schema as migrations 0001-0034 leave it, reduced to what 0035/0036 read or alter. */
async function createPre0035Db(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id UUID PRIMARY KEY);

    CREATE FUNCTION forbid_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $fm$
    BEGIN
      RAISE EXCEPTION '% on %.% is not permitted - this table is append-only',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME;
    END;
    $fm$;

    CREATE TABLE public.companies (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT companies_code_not_blank CHECK (btrim(code) <> ''),
      CONSTRAINT companies_name_not_blank CHECK (btrim(name) <> '')
    );

    CREATE TABLE public.teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      company_id UUID NOT NULL REFERENCES public.companies (id) ON DELETE RESTRICT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT teams_company_name_unique UNIQUE (company_id, name)
    );

    CREATE TABLE public.positions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT positions_name_unique UNIQUE (name)
    );

    CREATE TABLE public.team_positions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id UUID NOT NULL REFERENCES public.teams (id) ON DELETE RESTRICT,
      position_id UUID NOT NULL REFERENCES public.positions (id) ON DELETE RESTRICT,
      site_manager_assignable BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT team_positions_unique UNIQUE (team_id, position_id)
    );

    CREATE TABLE public.capabilities (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      individually_grantable BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE public.team_position_capabilities (
      team_position_id UUID NOT NULL REFERENCES public.team_positions (id) ON DELETE CASCADE,
      capability_id UUID NOT NULL REFERENCES public.capabilities (id) ON DELETE CASCADE,
      PRIMARY KEY (team_position_id, capability_id)
    );

    CREATE TABLE public.app_user_access (
      user_id UUID PRIMARY KEY REFERENCES auth.users (id),
      state TEXT NOT NULL DEFAULT 'ACTIVE'
    );

    CREATE TABLE public.workforce_profiles (
      user_id UUID PRIMARY KEY REFERENCES auth.users (id),
      display_name TEXT NOT NULL,
      company_id UUID NOT NULL REFERENCES public.companies (id),
      primary_team_position_id UUID NOT NULL REFERENCES public.team_positions (id)
    );

    CREATE TABLE public.user_team_positions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES auth.users (id),
      team_position_id UUID NOT NULL REFERENCES public.team_positions (id),
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    );

    CREATE TABLE public.permits (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT NOT NULL DEFAULT 'DRAFT',
      company TEXT,
      company_other TEXT,
      applicant_identity_kind TEXT,
      applicant_display_name TEXT,
      applicant_company_code TEXT,
      applicant_company_name TEXT,
      CONSTRAINT permits_company_valid CHECK (company IS NULL OR company IN ('ESET','SGRE','ZPL','OTHER')),
      CONSTRAINT permits_company_other_exclusive CHECK (
        (company = 'OTHER' AND company_other IS NOT NULL AND btrim(company_other) <> '')
        OR (company IS DISTINCT FROM 'OTHER' AND company_other IS NULL)
      ),
      CONSTRAINT permits_applicant_identity_complete CHECK (
        (applicant_display_name IS NULL AND applicant_company_code IS NULL AND applicant_company_name IS NULL)
        OR (
          applicant_display_name IS NOT NULL AND btrim(applicant_display_name) <> ''
          AND applicant_company_code IS NOT NULL AND applicant_company_code IN ('E_SET','ZPL','SGRE')
          AND applicant_company_name IS NOT NULL AND btrim(applicant_company_name) <> ''
        )
      )
    );

    CREATE FUNCTION public.permits_freeze_applicant_identity() RETURNS TRIGGER
    LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $fz$
    BEGIN
      IF OLD.applicant_display_name IS NOT NULL
         AND NEW.applicant_display_name IS DISTINCT FROM OLD.applicant_display_name THEN
        RAISE EXCEPTION 'the applicant identity of permit % is frozen and cannot be changed', OLD.id;
      END IF;
      RETURN NEW;
    END;
    $fz$;
    CREATE TRIGGER permits_freeze_applicant_identity_trigger
      BEFORE UPDATE ON public.permits
      FOR EACH ROW EXECUTE FUNCTION public.permits_freeze_applicant_identity();

    INSERT INTO public.companies (id, code, name) VALUES
      ('${ESET}', 'E_SET', 'E-SET'),
      ('${ZPL}', 'ZPL', 'ZPL'),
      ('${SGRE}', 'SGRE', 'SGRE');

    INSERT INTO public.teams (name, company_id) VALUES
      ('Admin', '${ESET}'), ('Civil', '${ESET}'), ('WTG', '${ESET}'),
      ('E-BOP', '${ESET}'), ('HSE', '${ESET}'),
      ('ZPL', '${ZPL}'), ('SGRE', '${SGRE}');

    INSERT INTO public.positions (name) VALUES
      ('Admin Lead'), ('Assistant Admin'), ('Team Lead'), ('Supervisor'), ('Worker'),
      ('Engineer'), ('Technician'), ('CRO'), ('Paramedic'), ('Site Manager'),
      ('Asset Manager'), ('HSE');

    INSERT INTO public.capabilities (name) VALUES
      ('permit.create'), ('permit.submit'), ('permit.cro_review'), ('permit.hse_review');

    INSERT INTO public.team_positions (team_id, position_id, site_manager_assignable)
    SELECT t.id, p.id, TRUE
      FROM (VALUES
        ('E_SET', 'Admin',  'Admin Lead'),
        ('E_SET', 'Admin',  'Assistant Admin'),
        ('E_SET', 'Civil',  'Team Lead'),
        ('E_SET', 'Civil',  'Supervisor'),
        ('E_SET', 'Civil',  'Worker'),
        ('E_SET', 'WTG',    'Team Lead'),
        ('E_SET', 'WTG',    'Engineer'),
        ('E_SET', 'WTG',    'Technician'),
        ('E_SET', 'E-BOP',  'Team Lead'),
        ('E_SET', 'E-BOP',  'CRO'),
        ('E_SET', 'E-BOP',  'Technician'),
        ('E_SET', 'HSE',    'Team Lead'),
        ('E_SET', 'HSE',    'Paramedic'),
        ('ZPL',   'ZPL',    'Site Manager'),
        ('ZPL',   'ZPL',    'Asset Manager'),
        ('ZPL',   'ZPL',    'Engineer'),
        ('ZPL',   'ZPL',    'HSE'),
        ('SGRE',  'SGRE',   'Team Lead')
      ) AS spec (company_code, team_name, position_name)
      JOIN public.companies c ON c.code = spec.company_code
      JOIN public.teams t ON t.company_id = c.id AND t.name = spec.team_name
      JOIN public.positions p ON p.name = spec.position_name;

    INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
    SELECT tp.id, c.id FROM public.team_positions tp
      JOIN public.teams t ON t.id = tp.team_id
      JOIN public.positions p ON p.id = tp.position_id
      CROSS JOIN public.capabilities c
     WHERE c.name IN ('permit.create','permit.submit')
       AND NOT (t.name = 'E-BOP' AND p.name = 'CRO');

    INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
    SELECT tp.id, c.id FROM public.team_positions tp
      JOIN public.teams t ON t.id = tp.team_id
      JOIN public.positions p ON p.id = tp.position_id
      CROSS JOIN public.capabilities c
     WHERE c.name = 'permit.cro_review' AND t.name = 'E-BOP' AND p.name = 'CRO';

    INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
    SELECT tp.id, c.id FROM public.team_positions tp
      JOIN public.teams t ON t.id = tp.team_id
      JOIN public.positions p ON p.id = tp.position_id
      CROSS JOIN public.capabilities c
     WHERE c.name = 'permit.hse_review' AND t.name = 'HSE' AND p.name IN ('Team Lead','Paramedic');

    -- A historical permit, frozen under the pre-0024 closed-vocabulary rules.
    INSERT INTO public.permits (status, company, applicant_identity_kind, applicant_display_name,
                                applicant_company_code, applicant_company_name)
    VALUES ('ISSUED', 'ZPL', 'NORMAL', 'Historical Applicant', 'ZPL', 'ZPL');
  `);
  return db;
}

/** The live production shape: 0035 applied, 0036 not yet. */
async function expanded(): Promise<PGlite> {
  const db = await createPre0035Db();
  await db.exec(await readFile(migration0035Url, 'utf8'));
  return db;
}

/**
 * The live shape PLUS the one overlap row the operator reported: written
 * by the pre-dba7922 backend after 0035 was applied, so it carries a
 * complete legacy identity with no authoritative company.
 */
async function expandedWithOverlapRow(): Promise<PGlite> {
  const db = await expanded();
  await db.exec(
    `INSERT INTO public.permits (status, company, applicant_identity_kind, applicant_display_name,
                                 applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO', 'ESET', 'NORMAL', 'Overlap Applicant', 'E_SET', 'E-SET')`,
  );
  const gap = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM permits
      WHERE applicant_display_name = 'Overlap Applicant' AND applicant_company_id IS NULL`,
  );
  assert.equal(gap.rows[0]?.count, '1', 'setup failed: the overlap row already had a company id');
  return db;
}

async function contracted(): Promise<PGlite> {
  const db = await expandedWithOverlapRow();
  await db.exec(await readFile(migration0036Url, 'utf8'));
  return db;
}

async function rejects(db: PGlite, sql: string, expected: RegExp): Promise<void> {
  await assert.rejects(() => db.exec(sql), expected);
}

// =====================================================================
// Backfill
// =====================================================================

test('the overlap row written by the OLD backend is backfilled', async () => {
  const db = await contracted();
  const row = await db.query<{ id: string; code: string; name: string }>(
    `SELECT applicant_company_id AS id, applicant_company_code AS code, applicant_company_name AS name
       FROM permits WHERE applicant_display_name = 'Overlap Applicant'`,
  );
  assert.equal(row.rows[0]?.id, ESET, 'E_SET did not resolve to the existing E_SET company UUID');
  // The frozen snapshot is untouched - only the missing id was filled.
  assert.equal(row.rows[0]?.code, 'E_SET');
  assert.equal(row.rows[0]?.name, 'E-SET');
});

test('every seeded company code resolves to its own existing UUID', async () => {
  const db = await expanded();
  // Written AFTER 0035 by a backend that does not know the column - the
  // genuine overlap shape. They cannot be produced by clearing an id
  // instead: 0035's freeze trigger refuses to unset one, which is itself
  // the guarantee that makes this backfill a one-way fill.
  await db.exec(
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','Overlap E-SET','E_SET','E-SET'),
            ('PENDING_CRO','NORMAL','Overlap ZPL','ZPL','ZPL'),
            ('PENDING_CRO','NORMAL','Overlap SGRE','SGRE','SGRE')`,
  );
  await db.exec(await readFile(migration0036Url, 'utf8'));

  const rows = await db.query<{ name: string; code: string; id: string }>(
    `SELECT applicant_display_name AS name, applicant_company_code AS code, applicant_company_id AS id
       FROM permits WHERE applicant_display_name LIKE 'Overlap %' ORDER BY applicant_display_name`,
  );
  assert.deepEqual(rows.rows, [
    { name: 'Overlap E-SET', code: 'E_SET', id: ESET },
    { name: 'Overlap SGRE', code: 'SGRE', id: SGRE },
    { name: 'Overlap ZPL', code: 'ZPL', id: ZPL },
  ]);
});

test('the freeze trigger makes the backfill one-way: an id can be filled, never unset', async () => {
  const db = await contracted();
  // This is why the backfill is safe to run twice and why no migration
  // can quietly re-point a permit at a different company.
  await rejects(
    db,
    `UPDATE permits SET applicant_company_id = NULL WHERE applicant_display_name = 'Overlap Applicant'`,
    /frozen and cannot be changed/,
  );
});

test('a row already carrying its authoritative company is left exactly as it is', async () => {
  const db = await expanded();
  const before = await db.query<{ id: string }>(
    `SELECT applicant_company_id AS id FROM permits WHERE applicant_display_name = 'Historical Applicant'`,
  );
  await db.exec(await readFile(migration0036Url, 'utf8'));
  const after = await db.query<{ id: string }>(
    `SELECT applicant_company_id AS id FROM permits WHERE applicant_display_name = 'Historical Applicant'`,
  );
  assert.equal(after.rows[0]?.id, before.rows[0]?.id);
  assert.equal(after.rows[0]?.id, ZPL);
});

// =====================================================================
// Fail closed
// =====================================================================

test('an UNRESOLVABLE applicant company code aborts the migration', async () => {
  const db = await expanded();
  // Plant a code with no company row. The expand-state constraint permits
  // any non-blank code, which is exactly the hole 0036 must close safely.
  await db.exec(
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','Ghost','NO_SUCH_COMPANY','Ghost Co')`,
  );

  const sql = await readFile(migration0036Url, 'utf8');
  await rejects(db, sql, /does not resolve to exactly one company/);
});

test('the abort happens BEFORE anything is changed', async () => {
  const db = await expanded();
  await db.exec(
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','Ghost','NO_SUCH_COMPANY','Ghost Co')`,
  );
  const sql = await readFile(migration0036Url, 'utf8');
  await rejects(db, sql, /does not resolve to exactly one company/);

  // The constraint is still the permissive EXPAND one, so a legacy write
  // would still succeed - the database was not left half-contracted.
  await db.exec(
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','Still Legacy','ZPL','ZPL')`,
  );
});

test('the failure names how many rows are unresolvable, not just that some are', async () => {
  const db = await expanded();
  await db.exec(
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','G1','NO_SUCH_COMPANY','X'),
            ('PENDING_CRO','NORMAL','G2','ALSO_MISSING','Y')`,
  );
  const sql = await readFile(migration0036Url, 'utf8');
  await rejects(db, sql, /0036 refused: 2 permit\(s\)/);
});

// =====================================================================
// The contracted rule
// =====================================================================

test('after 0036 a completed identity WITHOUT applicant_company_id is rejected', async () => {
  const db = await contracted();
  await rejects(
    db,
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','No Company Id','ZPL','ZPL')`,
    /permits_applicant_identity_complete/,
  );
});

test('a complete identity WITH applicant_company_id succeeds', async () => {
  const db = await contracted();
  await db.exec(
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_id, applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','Valid Applicant','${ZPL}','ZPL','ZPL')`,
  );
  const row = await db.query<{ id: string }>(
    `SELECT applicant_company_id AS id FROM permits WHERE applicant_display_name = 'Valid Applicant'`,
  );
  assert.equal(row.rows[0]?.id, ZPL);
});

test('a permit with NO applicant identity is still perfectly valid - drafts are not forced to have one', async () => {
  const db = await contracted();
  await db.exec(`INSERT INTO permits (status) VALUES ('DRAFT')`);
  await db.exec(`INSERT INTO permits (status, company) VALUES ('DRAFT', 'ESET')`);
  const drafts = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM permits
      WHERE status = 'DRAFT' AND applicant_display_name IS NULL AND applicant_company_id IS NULL`,
  );
  assert.equal(drafts.rows[0]?.count, '2');
});

test('partial applicant identities remain rejected in every direction', async () => {
  const db = await contracted();
  const partials = [
    `(status, applicant_display_name) VALUES ('PENDING_CRO','Only A Name')`,
    `(status, applicant_display_name, applicant_company_code)
       VALUES ('PENDING_CRO','Name And Code','ZPL')`,
    `(status, applicant_display_name, applicant_company_code, applicant_company_name)
       VALUES ('PENDING_CRO','   ','ZPL','ZPL')`,
    `(status, applicant_display_name, applicant_company_id, applicant_company_code, applicant_company_name)
       VALUES ('PENDING_CRO','Blank Code','${ZPL}','   ','ZPL')`,
    // A company id with no identity around it is equally unrepresentable.
    `(status, applicant_company_id) VALUES ('PENDING_CRO','${ZPL}')`,
  ];
  for (const partial of partials) {
    await rejects(db, `INSERT INTO permits ${partial}`, /permits_applicant_identity_complete/);
  }
});

test('applicant_company_id pointing at a company that does not exist is refused by the FK', async () => {
  const db = await contracted();
  await rejects(
    db,
    `INSERT INTO permits (status, applicant_identity_kind, applicant_display_name,
                          applicant_company_id, applicant_company_code, applicant_company_name)
     VALUES ('PENDING_CRO','NORMAL','Ghost','18000000-0000-4000-8000-0000000000ff','GHOST','Ghost')`,
    /foreign key|violates/i,
  );
});

test('0035 freeze semantics survive: a written applicant company cannot be changed', async () => {
  const db = await contracted();
  await rejects(
    db,
    `UPDATE permits SET applicant_company_id = '${SGRE}' WHERE applicant_display_name = 'Overlap Applicant'`,
    /frozen and cannot be changed/,
  );
  await rejects(
    db,
    `UPDATE permits SET applicant_company_code = 'SGRE' WHERE applicant_display_name = 'Overlap Applicant'`,
    /frozen and cannot be changed/,
  );
});

test('a referenced company still cannot be deleted', async () => {
  const db = await contracted();
  await rejects(db, `DELETE FROM companies WHERE id = '${ESET}'`, /foreign key|violates/i);
});

// =====================================================================
// Nothing else moved
// =====================================================================

test('historical applicant company code and name are not rewritten', async () => {
  const db = await expandedWithOverlapRow();
  const before = await db.query<{ name: string; code: string; company: string }>(
    `SELECT applicant_display_name AS name, applicant_company_code AS code, applicant_company_name AS company
       FROM permits ORDER BY applicant_display_name`,
  );
  await db.exec(await readFile(migration0036Url, 'utf8'));
  const after = await db.query<{ name: string; code: string; company: string }>(
    `SELECT applicant_display_name AS name, applicant_company_code AS code, applicant_company_name AS company
       FROM permits ORDER BY applicant_display_name`,
  );
  assert.deepEqual(after.rows, before.rows, 'a frozen snapshot was rewritten');
});

test('the organization structure is completely untouched', async () => {
  const db = await expandedWithOverlapRow();
  const shape = async (): Promise<Record<string, string>> => {
    const counts: Record<string, string> = {};
    for (const table of ['companies', 'teams', 'positions', 'team_positions', 'team_position_capabilities']) {
      const row = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      counts[table] = row.rows[0]!.count;
    }
    return counts;
  };
  const before = await shape();
  await db.exec(await readFile(migration0036Url, 'utf8'));
  const after = await shape();
  assert.deepEqual(after, before);
  assert.deepEqual(before, {
    companies: '3', teams: '7', positions: '12',
    team_positions: '18', team_position_capabilities: '37',
  });
});

test('CRO and HSE capability assignments are unchanged', async () => {
  const db = await contracted();
  const rows = await db.query<{ name: string; count: string }>(
    `SELECT c.name, count(*)::text AS count
       FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE c.name IN ('permit.cro_review','permit.hse_review')
      GROUP BY c.name ORDER BY c.name`,
  );
  assert.deepEqual(rows.rows, [
    { name: 'permit.cro_review', count: '1' },
    { name: 'permit.hse_review', count: '2' },
  ]);

  // And still held by the right combinations, not merely the right count.
  const holders = await db.query<{ team: string; position: string }>(
    `SELECT t.name AS team, p.name AS position
       FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
       JOIN team_positions tp ON tp.id = tpc.team_position_id
       JOIN teams t ON t.id = tp.team_id
       JOIN positions p ON p.id = tp.position_id
      WHERE c.name = 'permit.cro_review'`,
  );
  assert.deepEqual(holders.rows, [{ team: 'E-BOP', position: 'CRO' }]);
});

test('organization audit protections remain intact', async () => {
  const db = await contracted();
  await db.exec(`INSERT INTO auth.users (id) VALUES ('${ESET}') ON CONFLICT DO NOTHING`);
  await db.exec(
    `INSERT INTO organization_audit_events (event_type, actor_user_id, company_id)
     VALUES ('COMPANY_CREATED', '${ESET}', '${ZPL}')`,
  );
  await rejects(db, `UPDATE organization_audit_events SET event_type = 'COMPANY_RENAMED'`, /append-only/);
  await rejects(db, `DELETE FROM organization_audit_events`, /append-only/);
  await rejects(db, `TRUNCATE organization_audit_events`, /append-only/);

  const rls = await db.query<{ relrowsecurity: boolean }>(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'organization_audit_events'`,
  );
  assert.equal(rls.rows[0]?.relrowsecurity, true);
});

test('the organization lifecycle guards from 0035 still fire', async () => {
  const db = await contracted();
  const cro = await db.query<{ id: string }>(
    `SELECT tp.id FROM team_positions tp
       JOIN teams t ON t.id = tp.team_id JOIN positions p ON p.id = tp.position_id
      WHERE t.name = 'E-BOP' AND p.name = 'CRO'`,
  );
  await rejects(
    db,
    `UPDATE team_positions SET deactivated_at = now() WHERE id = '${cro.rows[0]?.id}'`,
    /permit\.cro_review below its required coverage/,
  );
});

// =====================================================================
// Scope
// =====================================================================

test('0036 introduces no table, function, trigger, sequence or grant', async () => {
  const sql = await readFile(migration0036Url, 'utf8');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  for (const forbidden of [/CREATE\s+TABLE/i, /CREATE\s+(OR REPLACE\s+)?FUNCTION/i,
    /CREATE\s+TRIGGER/i, /CREATE\s+SEQUENCE/i, /CREATE\s+POLICY/i, /^\s*GRANT\s/im]) {
    assert.ok(!forbidden.test(statements), `0036 contains a forbidden statement: ${forbidden}`);
  }
  // It touches no organization table either.
  for (const table of ['companies', 'teams', 'positions', 'team_positions',
    'team_position_capabilities', 'organization_audit_events']) {
    assert.ok(
      !new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+(public\\.)?${table}\\b`, 'i').test(statements),
      `0036 writes to ${table}`,
    );
  }
});

test('0036 documents that rollback past dba7922 is closed', async () => {
  const sql = await readFile(migration0036Url, 'utf8');
  assert.ok(sql.includes('ROLLBACK IS CLOSED AFTER THIS MIGRATION'));
  assert.ok(sql.includes('dba7922'));
  assert.ok(sql.includes('23514'));
});

test('0035 is unchanged: it is still the EXPAND migration', async () => {
  // 0035 is live. This guards against a future edit that would make the
  // applied history and the repository disagree.
  const sql = await readFile(migration0035Url, 'utf8');
  assert.ok(sql.includes('THIS IS THE **EXPAND** MIGRATION'));
  assert.ok(sql.includes('TRANSITIONAL AND IS NOT THE FINAL INVARIANT'));
  // The expand constraint must NOT require the column - that is 0036's job.
  const expandClause = sql.slice(
    sql.indexOf('ADD CONSTRAINT permits_applicant_identity_complete'),
  );
  assert.ok(
    !expandClause.slice(0, 600).includes('AND applicant_company_id IS NOT NULL'),
    '0035 was edited to contract the identity; it must stay the expand step',
  );
});
