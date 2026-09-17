import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration0035Url = new URL(
  '../../../database/migrations/0035_dynamic_organization_management.sql',
  import.meta.url,
);

/**
 * RUNTIME ORGANIZATION MANAGEMENT.
 *
 * These specs run the REAL migration SQL against the shape it actually
 * sees, so the guarantees below are proved by the database rather than
 * asserted about it. That matters most for the two that protect the
 * permit workflow:
 *
 *   * an organization action can never newly break, or further worsen,
 *     the coverage of a REQUIRED capability - `permit.cro_review` and
 *     `permit.hse_review`, the two the workflow fails closed on. It is
 *     deliberately NOT a rule that every capability must always have a
 *     holder: an optional one may reach zero, and a requirement that is
 *     already degraded must not freeze unrelated lifecycle work.
 *   * the baseline grant reaches exactly `permit.create` and
 *     `permit.submit`, and no argument can widen it.
 */

const ESET = '18000000-0000-4000-8000-000000000001';
const ZPL = '18000000-0000-4000-8000-000000000002';
const SGRE = '18000000-0000-4000-8000-000000000003';

/** The schema as migrations 0001-0034 leave it, reduced to what 0035 reads or alters. */
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

    -- The EXACT launch shape migration 0020 seeds and 0035's own
    -- self-verification asserts: 7 teams, 12 positions, 18 associations.
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

    -- Permit application goes to all 17 combinations except E-SET E-BOP CRO.
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

    -- One historical permit, frozen under the OLD closed-vocabulary rules.
    INSERT INTO public.permits (status, company, applicant_display_name, applicant_company_code, applicant_company_name)
    VALUES ('ISSUED', 'ZPL', 'Ali Khan', 'ZPL', 'ZPL');
  `);
  return db;
}

async function applied(): Promise<PGlite> {
  const db = await createPre0035Db();
  await db.exec(await readFile(migration0035Url, 'utf8'));
  return db;
}

async function actor(db: PGlite, id = '10000000-0000-4000-8000-00000000000a'): Promise<string> {
  await db.exec(`INSERT INTO auth.users (id) VALUES ('${id}') ON CONFLICT DO NOTHING`);
  return id;
}

/** Adds an ACTIVE employee sitting on the named association. */
async function employ(db: PGlite, userId: string, companyId: string, teamPositionId: string): Promise<void> {
  await db.exec(`
    INSERT INTO auth.users (id) VALUES ('${userId}') ON CONFLICT DO NOTHING;
    INSERT INTO public.app_user_access (user_id, state) VALUES ('${userId}', 'ACTIVE');
    INSERT INTO public.workforce_profiles (user_id, display_name, company_id, primary_team_position_id)
    VALUES ('${userId}', 'Employee', '${companyId}', '${teamPositionId}');
  `);
}

async function idOf(db: PGlite, sql: string): Promise<string> {
  const result = await db.query<{ id: string }>(sql);
  const row = result.rows[0];
  assert.ok(row, `expected a row from: ${sql}`);
  return row.id;
}

async function rejects(db: PGlite, sql: string, expected: RegExp): Promise<void> {
  await assert.rejects(() => db.exec(sql), expected);
}

// =====================================================================
// The migration applies, and changes nothing it should not
// =====================================================================

test('the migration applies cleanly and its self-verification passes', async () => {
  const db = await applied();
  const companies = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM companies');
  assert.equal(companies.rows[0]?.count, '3');
});

test('the seeded company codes, names and ids are unchanged', async () => {
  const db = await applied();
  const rows = await db.query<{ id: string; code: string; name: string }>(
    'SELECT id, code, name FROM companies ORDER BY code',
  );
  assert.deepEqual(rows.rows, [
    { id: ESET, code: 'E_SET', name: 'E-SET' },
    { id: SGRE, code: 'SGRE', name: 'SGRE' },
    { id: ZPL, code: 'ZPL', name: 'ZPL' },
  ]);
});

test('nothing is deactivated by the migration itself', async () => {
  const db = await applied();
  for (const table of ['companies', 'teams', 'team_positions']) {
    const row = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${table} WHERE deactivated_at IS NOT NULL`,
    );
    assert.equal(row.rows[0]?.count, '0', `${table} had a deactivated row`);
  }
});

test('positions gains NO lifecycle column - it is a shared global vocabulary', async () => {
  const db = await applied();
  const columns = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'positions' AND column_name = 'deactivated_at'`,
  );
  assert.equal(columns.rows.length, 0);
});

test('the existing historical permit survives with its frozen snapshot intact', async () => {
  const db = await applied();
  const rows = await db.query<{
    applicant_company_code: string;
    applicant_company_name: string;
    applicant_company_id: string;
    company: string;
  }>('SELECT applicant_company_code, applicant_company_name, applicant_company_id, company FROM permits');
  const permit = rows.rows[0];
  // The snapshot is untouched; only the authoritative id was added.
  assert.equal(permit?.applicant_company_code, 'ZPL');
  assert.equal(permit?.applicant_company_name, 'ZPL');
  assert.equal(permit?.company, 'ZPL');
  assert.equal(permit?.applicant_company_id, ZPL, 'the backfill did not resolve the frozen code');
});

// =====================================================================
// Hierarchy
// =====================================================================

test('a company can exist with zero teams', async () => {
  const db = await applied();
  await db.exec(`INSERT INTO companies (id, code, name)
                 VALUES (gen_random_uuid(), 'ABC_CONTRACTORS', 'ABC Contractors')`);
  const teams = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM teams t
      JOIN companies c ON c.id = t.company_id WHERE c.code = 'ABC_CONTRACTORS'`,
  );
  assert.equal(teams.rows[0]?.count, '0');
});

test('a team cannot exist without a company', async () => {
  const db = await applied();
  await rejects(db, `INSERT INTO teams (name, company_id) VALUES ('Orphan', NULL)`, /null value|not-null/i);
});

test('many teams can be added to one company, seeded companies included', async () => {
  const db = await applied();
  await db.exec(`
    INSERT INTO teams (name, company_id) VALUES
      ('Electrical', '${ESET}'), ('Mechanical', '${ESET}'), ('Logistics', '${ESET}'),
      ('Electrical', '${ZPL}'), ('Commissioning', '${SGRE}');
  `);
  const eset = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM teams WHERE company_id = '${ESET}'`,
  );
  // The 5 seeded E-SET teams plus the 3 just added.
  assert.equal(eset.rows[0]?.count, '8');
});

test('the same shared position row is associated with teams in different companies', async () => {
  const db = await applied();
  const supervisor = await idOf(db, `SELECT id FROM positions WHERE name = 'Supervisor'`);
  await db.exec(`
    INSERT INTO teams (name, company_id) VALUES ('Electrical', '${ESET}'), ('Electrical', '${ZPL}');
    INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
    SELECT id, '${supervisor}', TRUE FROM teams WHERE name = 'Electrical';
  `);
  const uses = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM team_positions WHERE position_id = '${supervisor}'`,
  );
  // E-SET Civil already used Supervisor at launch; the two new Electrical
  // teams - one in a DIFFERENT company - now share that same row.
  assert.equal(uses.rows[0]?.count, '3');
  // Still exactly ONE position row: reused, not duplicated.
  const rows = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM positions WHERE name = 'Supervisor'`,
  );
  assert.equal(rows.rows[0]?.count, '1');
});

test('deactivating one association leaves the shared position usable everywhere else', async () => {
  const db = await applied();
  const supervisor = await idOf(db, `SELECT id FROM positions WHERE name = 'Supervisor'`);
  await db.exec(`
    INSERT INTO teams (name, company_id) VALUES ('Electrical', '${ESET}'), ('Electrical', '${ZPL}');
    INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
    SELECT id, '${supervisor}', TRUE FROM teams WHERE name = 'Electrical';
  `);
  const retired = await idOf(
    db,
    `SELECT tp.id FROM team_positions tp JOIN teams t ON t.id = tp.team_id
      WHERE tp.position_id = '${supervisor}' AND t.company_id = '${ESET}'`,
  );
  await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${retired}'`);

  const active = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM team_positions
      WHERE position_id = '${supervisor}' AND deactivated_at IS NULL`,
  );
  // ZPL Electrical and E-SET Civil both keep theirs: retiring one
  // association never touches the shared vocabulary row.
  assert.equal(active.rows[0]?.count, '2', 'another team lost its Supervisor');
});

// =====================================================================
// Company code
// =====================================================================

test('a company code must satisfy the generated format', async () => {
  const db = await applied();
  for (const bad of ['abc_contractors', 'ABC-CONTRACTORS', '2ABC', 'ABC CONTRACTORS', 'ABC!']) {
    await rejects(
      db,
      `INSERT INTO companies (id, code, name) VALUES (gen_random_uuid(), '${bad}', 'X ${bad}')`,
      /companies_code_format/,
    );
  }
});

test('a duplicate company name is refused however it is cased or spaced', async () => {
  const db = await applied();
  await db.exec(`INSERT INTO companies (id, code, name) VALUES (gen_random_uuid(), 'ABC_CONTRACTORS', 'ABC Contractors')`);
  for (const duplicate of ['ABC Contractors', 'abc contractors', '  ABC CONTRACTORS  ']) {
    await rejects(
      db,
      `INSERT INTO companies (id, code, name) VALUES (gen_random_uuid(), 'ABC_CONTRACTORS_2', '${duplicate}')`,
      /companies_name_normalized_unique/,
    );
  }
});

test('a duplicate generated code is refused by the database, not by a pre-check', async () => {
  const db = await applied();
  await db.exec(`INSERT INTO companies (id, code, name) VALUES (gen_random_uuid(), 'ABC_CONTRACTORS', 'ABC Contractors')`);
  await rejects(
    db,
    `INSERT INTO companies (id, code, name) VALUES (gen_random_uuid(), 'ABC_CONTRACTORS', 'Different Name')`,
    /companies_code_key|unique/i,
  );
});

test('a company code and id are immutable; the display name is not', async () => {
  const db = await applied();
  await rejects(db, `UPDATE companies SET code = 'HACKED' WHERE id = '${ZPL}'`, /code is immutable/);
  await rejects(db, `UPDATE companies SET id = gen_random_uuid() WHERE id = '${ZPL}'`, /id is immutable/);
  await db.exec(`UPDATE companies SET name = 'ZPL Energy' WHERE id = '${ZPL}'`);
  const renamed = await db.query<{ name: string }>(`SELECT name FROM companies WHERE id = '${ZPL}'`);
  assert.equal(renamed.rows[0]?.name, 'ZPL Energy');
});

// =====================================================================
// Deactivation guards
// =====================================================================

test('a company cannot be deactivated while an active employee sits underneath it', async () => {
  const db = await applied();
  const tp = await idOf(db, `SELECT tp.id FROM team_positions tp JOIN teams t ON t.id = tp.team_id WHERE t.name = 'ZPL' LIMIT 1`);
  await employ(db, '10000000-0000-4000-8000-000000000101', ZPL, tp);

  await rejects(db, `UPDATE companies SET deactivated_at = now() WHERE id = '${ZPL}'`, /active employee/);
});

test('a team cannot be deactivated while an active employee sits underneath it', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'ZPL'`);
  const tp = await idOf(db, `SELECT id FROM team_positions WHERE team_id = '${teamId}' LIMIT 1`);
  await employ(db, '10000000-0000-4000-8000-000000000102', ZPL, tp);

  await rejects(db, `UPDATE teams SET deactivated_at = now() WHERE id = '${teamId}'`, /active employee/);
});

test('an association cannot be deactivated while an active employee uses it', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'ZPL'`);
  const tp = await idOf(db, `SELECT id FROM team_positions WHERE team_id = '${teamId}' LIMIT 1`);
  await employ(db, '10000000-0000-4000-8000-000000000103', ZPL, tp);

  await rejects(db, `UPDATE team_positions SET deactivated_at = now() WHERE id = '${tp}'`, /active employee/);
});

test('a DISABLED employee does not block deactivation - only an ACTIVE one does', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const tp = await idOf(db, `SELECT id FROM team_positions WHERE team_id = '${teamId}' LIMIT 1`);
  await employ(db, '10000000-0000-4000-8000-000000000104', SGRE, tp);
  await db.exec(`UPDATE app_user_access SET state = 'DISABLED' WHERE user_id = '10000000-0000-4000-8000-000000000104'`);

  await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${tp}'`);
  const row = await db.query<{ deactivated_at: string | null }>(
    `SELECT deactivated_at FROM team_positions WHERE id = '${tp}'`,
  );
  assert.notEqual(row.rows[0]?.deactivated_at, null);
});

// =====================================================================
// The privileged-coverage guard
// =====================================================================

test('the ONLY CRO association cannot be deactivated', async () => {
  const db = await applied();
  const cro = await idOf(
    db,
    `SELECT tp.id FROM team_positions tp
       JOIN teams t ON t.id = tp.team_id JOIN positions p ON p.id = tp.position_id
      WHERE t.name = 'E-BOP' AND p.name = 'CRO'`,
  );
  await rejects(
    db,
    `UPDATE team_positions SET deactivated_at = now() WHERE id = '${cro}'`,
    /permit\.cro_review below its required coverage/,
  );
});

test('the E-SET HSE team cannot be deactivated - it carries all HSE approval authority', async () => {
  const db = await applied();
  const hse = await idOf(db, `SELECT id FROM teams WHERE name = 'HSE' AND company_id = '${ESET}'`);
  await rejects(
    db,
    `UPDATE teams SET deactivated_at = now() WHERE id = '${hse}'`,
    /permit\.hse_review below its required coverage/,
  );
});

test('E-SET itself cannot be deactivated - it holds the only CRO and HSE authority', async () => {
  const db = await applied();
  await rejects(
    db,
    `UPDATE companies SET deactivated_at = now() WHERE id = '${ESET}'`,
    /below its required coverage/,
  );
});

test('ONE of two HSE holders may be retired; the second may not', async () => {
  const db = await applied();
  const holders = await db.query<{ id: string }>(
    `SELECT tp.id FROM team_positions tp
       JOIN teams t ON t.id = tp.team_id JOIN positions p ON p.id = tp.position_id
       JOIN team_position_capabilities tpc ON tpc.team_position_id = tp.id
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE c.name = 'permit.hse_review' ORDER BY p.name`,
  );
  assert.equal(holders.rows.length, 2);

  // Retiring the first is safe - the second still covers HSE approval.
  await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${holders.rows[0]?.id}'`);
  // Retiring the last is refused.
  await rejects(
    db,
    `UPDATE team_positions SET deactivated_at = now() WHERE id = '${holders.rows[1]?.id}'`,
    /permit\.hse_review below its required coverage/,
  );
});

// ---------------------------------------------------------------------
// The guard is NARROW: only capabilities with a required minimum
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// A degraded requirement must not freeze the organization
// ---------------------------------------------------------------------

/**
 * Drives required CRO coverage to zero the only way the schema allows -
 * by retiring the E-BOP TEAM, which the association-level guard would
 * refuse but which is itself refused... so instead the capability row is
 * detached directly, simulating an organization that is already short of
 * CRO coverage however it got there (a migration, an operator fix, a
 * requirement raised later).
 */
async function withDegradedCroCoverage(): Promise<PGlite> {
  const db = await applied();
  await db.exec(`
    DELETE FROM team_position_capabilities
     WHERE capability_id = (SELECT id FROM capabilities WHERE name = 'permit.cro_review');
  `);
  const holders = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE c.name = 'permit.cro_review'`,
  );
  assert.equal(holders.rows[0]?.count, '0', 'setup failed: CRO coverage is not degraded');
  return db;
}

test('degraded required coverage does NOT block an unrelated deactivation', async () => {
  const db = await withDegradedCroCoverage();

  // CRO coverage is already 0, below its minimum of 1. An unrelated
  // retirement leaves that count untouched and must still be allowed -
  // otherwise the organization would be frozen, including the very
  // reassignments needed to restore coverage.
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const tp = await idOf(db, `SELECT id FROM team_positions WHERE team_id = '${teamId}' LIMIT 1`);
  await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${tp}'`);

  const row = await db.query<{ deactivated_at: string | null }>(
    `SELECT deactivated_at FROM team_positions WHERE id = '${tp}'`,
  );
  assert.notEqual(row.rows[0]?.deactivated_at, null, 'a degraded requirement froze an unrelated deactivation');
});

test('degraded coverage of ONE requirement still protects the OTHER requirement', async () => {
  const db = await withDegradedCroCoverage();

  // CRO is degraded; HSE is not. Retiring the last HSE holder must still
  // be refused - a deficit in one requirement never relaxes another.
  const holders = await db.query<{ id: string }>(
    `SELECT tp.id FROM team_positions tp
       JOIN team_position_capabilities tpc ON tpc.team_position_id = tp.id
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE c.name = 'permit.hse_review' ORDER BY tp.id`,
  );
  assert.equal(holders.rows.length, 2);
  await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${holders.rows[0]?.id}'`);
  await rejects(
    db,
    `UPDATE team_positions SET deactivated_at = now() WHERE id = '${holders.rows[1]?.id}'`,
    /permit\.hse_review below its required coverage/,
  );
});

test('the coverage rule itself refuses to worsen a deficit, for any minimum', async () => {
  // Both CONFIGURED minimums are 1, so "already short but still above
  // zero" is unreachable today - a count cannot sit between 0 and 1. The
  // rule must nevertheless be correct for a minimum raised later, so the
  // predicate is evaluated directly over the cases that matter,
  // including the minimum-2 ones.
  const db = await applied();
  const cases = await db.query<{ minimum: number; current: number; post: number; refused: boolean }>(`
    SELECT minimum, current, post, (post < LEAST(minimum, current)) AS refused
      FROM (VALUES
        (1, 1, 0),   -- newly breaks the minimum
        (1, 0, 0),   -- already short, action unrelated
        (1, 2, 1),   -- still covered afterwards
        (2, 1, 0),   -- already short, action worsens it
        (2, 1, 1),   -- already short, action unrelated
        (2, 3, 1),   -- newly breaks the minimum
        (2, 3, 2),   -- still covered afterwards
        (2, 0, 0)    -- already at zero, action unrelated
      ) AS t (minimum, current, post)
     ORDER BY minimum, current, post
  `);

  const outcome = (minimum: number, current: number, post: number): boolean => {
    const row = cases.rows.find((c) => c.minimum === minimum && c.current === current && c.post === post);
    assert.ok(row, `missing case ${minimum}/${current}/${post}`);
    return row.refused;
  };

  // Newly breaking the minimum is refused.
  assert.equal(outcome(1, 1, 0), true);
  assert.equal(outcome(2, 3, 1), true);
  // Worsening an existing deficit is refused.
  assert.equal(outcome(2, 1, 0), true);
  // Leaving the count untouched is allowed, however degraded it is.
  assert.equal(outcome(1, 0, 0), false);
  assert.equal(outcome(2, 1, 1), false);
  assert.equal(outcome(2, 0, 0), false);
  // Reducing coverage that stays at or above the minimum is allowed.
  assert.equal(outcome(1, 2, 1), false);
  assert.equal(outcome(2, 3, 2), false);
});

test('the guard function uses the worsen-aware bar, not a bare minimum comparison', async () => {
  const db = await applied();
  const source = await db.query<{ definition: string }>(
    `SELECT pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'organization_required_coverage_gap'`,
  );
  const definition = source.rows[0]?.definition ?? '';
  // The bar is LEAST(minimum, current): comparing against the minimum
  // alone is what would freeze an already-degraded organization.
  assert.ok(
    definition.includes('LEAST(required.minimum, count(*))'),
    'the guard no longer bounds the bar by current coverage',
  );
});

test('an OPTIONAL capability may fall to zero active holders without blocking anything', async () => {
  const db = await applied();
  // An optional capability held by exactly ONE association. Under a
  // global "every capability needs a holder" rule this association could
  // never be retired; under the required-coverage rule it can, because
  // nothing in the workflow fails closed on this capability's absence.
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const position = await idOf(db, `SELECT id FROM positions WHERE name = 'Worker'`);
  const tp = await idOf(
    db,
    `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
     VALUES ('${teamId}', '${position}', TRUE) RETURNING id`,
  );
  await db.exec(`
    INSERT INTO capabilities (name) VALUES ('permit.optional_example');
    INSERT INTO team_position_capabilities (team_position_id, capability_id)
    SELECT '${tp}', id FROM capabilities WHERE name = 'permit.optional_example';
  `);

  await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${tp}'`);

  const retired = await db.query<{ deactivated_at: string | null }>(
    `SELECT deactivated_at FROM team_positions WHERE id = '${tp}'`,
  );
  assert.notEqual(retired.rows[0]?.deactivated_at, null, 'an optional capability blocked a legitimate deactivation');

  // And it genuinely reached zero active holders - the rule permits that.
  const holders = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
       JOIN team_positions tp ON tp.id = tpc.team_position_id
      WHERE c.name = 'permit.optional_example' AND tp.deactivated_at IS NULL`,
  );
  assert.equal(holders.rows[0]?.count, '0');
});

test('the baseline capabilities are NOT treated as requiring global coverage', async () => {
  const db = await applied();
  // Retire every association holding the applicant baseline except the
  // ones that also carry required CRO/HSE coverage. permit.create and
  // permit.submit dropping toward zero must never be the thing that
  // blocks a deactivation.
  const baseline = await db.query<{ id: string }>(
    `SELECT DISTINCT tp.id
       FROM team_positions tp
       JOIN team_position_capabilities tpc ON tpc.team_position_id = tp.id
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE c.name IN ('permit.create','permit.submit')
        AND NOT EXISTS (
          SELECT 1 FROM team_position_capabilities req
            JOIN capabilities rc ON rc.id = req.capability_id
           WHERE req.team_position_id = tp.id
             AND rc.name IN ('permit.cro_review','permit.hse_review'))`,
  );
  assert.ok(baseline.rows.length > 0);

  for (const row of baseline.rows) {
    await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${row.id}'`);
  }

  const remaining = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
       JOIN team_positions tp ON tp.id = tpc.team_position_id
      WHERE c.name = 'permit.create' AND tp.deactivated_at IS NULL`,
  );
  // Every one of those deactivations was permitted - the loop above would
  // have thrown otherwise - and the applicant baseline is now down to the
  // two E-SET HSE associations, which survive only because they ALSO
  // carry required HSE coverage. Under a global rule, the very first
  // deactivation would have been refused.
  assert.equal(remaining.rows[0]?.count, '2');
});

test('the required-coverage list is exactly CRO review and HSE review', async () => {
  const db = await applied();
  const source = await db.query<{ definition: string }>(
    `SELECT pg_get_functiondef(p.oid) AS definition
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'organization_required_coverage_gap'`,
  );
  const definition = source.rows[0]?.definition ?? '';
  // The list is a short explicit VALUES table, not a naming heuristic and
  // not every capability row.
  assert.ok(definition.includes("'permit.cro_review', 1"));
  assert.ok(definition.includes("'permit.hse_review', 1"));
  assert.ok(!definition.includes('permit.create'), 'the applicant baseline must not be required coverage');
  assert.ok(!definition.includes('permit.submit'), 'the applicant baseline must not be required coverage');
  assert.ok(!definition.includes('LIKE'), 'coverage must not be derived from a naming heuristic');
});

test('creating companies, teams and positions leaves the CRO/HSE counts untouched', async () => {
  const db = await applied();
  const abc = await idOf(
    db,
    `INSERT INTO companies (id, code, name)
     VALUES (gen_random_uuid(), 'ABC_CONTRACTORS', 'ABC Contractors') RETURNING id`,
  );
  const team = await idOf(
    db,
    `INSERT INTO teams (name, company_id) VALUES ('Electrical', '${abc}') RETURNING id`,
  );
  for (const name of ['CRO', 'HSE', 'Supervisor']) {
    const position = await idOf(db, `SELECT id FROM positions WHERE name = '${name}'`);
    const tp = await idOf(
      db,
      `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
       VALUES ('${team}', '${position}', TRUE) RETURNING id`,
    );
    await db.exec(`SELECT grant_baseline_applicant_capabilities('${tp}')`);
  }

  const counts = await db.query<{ name: string; count: string }>(
    `SELECT c.name, count(*)::text AS count
       FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE c.name IN ('permit.cro_review','permit.hse_review')
      GROUP BY c.name ORDER BY c.name`,
  );
  assert.deepEqual(counts.rows, [
    { name: 'permit.cro_review', count: '1' },
    { name: 'permit.hse_review', count: '2' },
  ]);
});

test('a company with no privileged coverage CAN be retired once its people have moved', async () => {
  const db = await applied();
  // SGRE holds only the applicant baseline, which E-SET and ZPL also
  // hold, so retiring it removes nobody's last authority.
  await db.exec(`UPDATE companies SET deactivated_at = now() WHERE id = '${SGRE}'`);
  const row = await db.query<{ deactivated_at: string | null }>(
    `SELECT deactivated_at FROM companies WHERE id = '${SGRE}'`,
  );
  assert.notEqual(row.rows[0]?.deactivated_at, null);
});

// =====================================================================
// Inactive records accept no new work
// =====================================================================

test('an inactive company receives no new teams', async () => {
  const db = await applied();
  await db.exec(`UPDATE companies SET deactivated_at = now() WHERE id = '${SGRE}'`);
  await rejects(db, `INSERT INTO teams (name, company_id) VALUES ('New', '${SGRE}')`, /cannot receive new teams/);
});

test('an inactive team receives no new positions', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const position = await idOf(db, `SELECT id FROM positions WHERE name = 'Worker'`);
  await db.exec(`UPDATE teams SET deactivated_at = now() WHERE id = '${teamId}'`);
  await rejects(
    db,
    `INSERT INTO team_positions (team_id, position_id) VALUES ('${teamId}', '${position}')`,
    /cannot receive new positions/,
  );
});

test('an inactive association receives no new employee assignments', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const tp = await idOf(db, `SELECT id FROM team_positions WHERE team_id = '${teamId}' LIMIT 1`);
  await db.exec(`UPDATE team_positions SET deactivated_at = now() WHERE id = '${tp}'`);
  await actor(db, '10000000-0000-4000-8000-000000000201');

  await rejects(
    db,
    `INSERT INTO workforce_profiles (user_id, display_name, company_id, primary_team_position_id)
     VALUES ('10000000-0000-4000-8000-000000000201', 'New Hire', '${SGRE}', '${tp}')`,
    /cannot receive new employee assignments/,
  );
  await rejects(
    db,
    `INSERT INTO user_team_positions (user_id, team_position_id)
     VALUES ('10000000-0000-4000-8000-000000000201', '${tp}')`,
    /cannot receive new assignments/,
  );
});

test('an EXISTING employee under a later-retired company is never broken by an unrelated edit', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const tp = await idOf(db, `SELECT id FROM team_positions WHERE team_id = '${teamId}' LIMIT 1`);
  await employ(db, '10000000-0000-4000-8000-000000000202', SGRE, tp);
  await db.exec(`UPDATE app_user_access SET state = 'DISABLED' WHERE user_id = '10000000-0000-4000-8000-000000000202'`);
  await db.exec(`UPDATE companies SET deactivated_at = now() WHERE id = '${SGRE}'`);

  // Correcting a display name must still work: the placement is unchanged.
  await db.exec(
    `UPDATE workforce_profiles SET display_name = 'Corrected Name'
      WHERE user_id = '10000000-0000-4000-8000-000000000202'`,
  );
  const row = await db.query<{ display_name: string }>(
    `SELECT display_name FROM workforce_profiles WHERE user_id = '10000000-0000-4000-8000-000000000202'`,
  );
  assert.equal(row.rows[0]?.display_name, 'Corrected Name');
});

// =====================================================================
// The bounded baseline capability grant
// =====================================================================

test('the baseline function grants exactly permit.create and permit.submit', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const position = await idOf(db, `SELECT id FROM positions WHERE name = 'Worker'`);
  const tp = await idOf(
    db,
    `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
     VALUES ('${teamId}', '${position}', TRUE) RETURNING id`,
  );

  await db.exec(`SELECT grant_baseline_applicant_capabilities('${tp}')`);

  const granted = await db.query<{ name: string }>(
    `SELECT c.name FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE tpc.team_position_id = '${tp}' ORDER BY c.name`,
  );
  assert.deepEqual(granted.rows.map((row) => row.name), ['permit.create', 'permit.submit']);
});

test('a position NAMED CRO or HSE receives the baseline and no workflow authority', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);

  for (const name of ['CRO', 'HSE', 'Site Manager']) {
    const position = await idOf(db, `SELECT id FROM positions WHERE name = '${name}'`);
    const tp = await idOf(
      db,
      `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
       VALUES ('${teamId}', '${position}', TRUE) RETURNING id`,
    );
    await db.exec(`SELECT grant_baseline_applicant_capabilities('${tp}')`);

    const granted = await db.query<{ name: string }>(
      `SELECT c.name FROM team_position_capabilities tpc
         JOIN capabilities c ON c.id = tpc.capability_id
        WHERE tpc.team_position_id = '${tp}' ORDER BY c.name`,
    );
    assert.deepEqual(
      granted.rows.map((row) => row.name),
      ['permit.create', 'permit.submit'],
      `a position named "${name}" received more than the baseline`,
    );
  }

  // And the launch invariants are untouched by all of that.
  const cro = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id WHERE c.name = 'permit.cro_review'`,
  );
  const hse = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id WHERE c.name = 'permit.hse_review'`,
  );
  assert.equal(cro.rows[0]?.count, '1');
  assert.equal(hse.rows[0]?.count, '2');
});

test('the baseline function takes no capability argument, so none can be requested', async () => {
  const db = await applied();
  const signature = await db.query<{ args: string }>(
    `SELECT pg_get_function_identity_arguments(p.oid) AS args
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'grant_baseline_applicant_capabilities'`,
  );
  // One parameter, of type uuid - there is no capability parameter.
  const args = signature.rows[0]?.args ?? '';
  assert.equal(args.split(',').length, 1, `expected a single parameter, got "${args}"`);
  assert.ok(args.endsWith('uuid'), `expected the single parameter to be a uuid, got "${args}"`);

  // A second argument does not exist to be passed.
  await rejects(
    db,
    `SELECT grant_baseline_applicant_capabilities('${ESET}', 'permit.cro_review')`,
    /does not exist|function/i,
  );
});

test('the baseline function fails atomically when a baseline capability is missing', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const position = await idOf(db, `SELECT id FROM positions WHERE name = 'Worker'`);
  const tp = await idOf(
    db,
    `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
     VALUES ('${teamId}', '${position}', TRUE) RETURNING id`,
  );

  // Simulate a corrupt/half-seeded environment.
  await db.exec(`
    DELETE FROM team_position_capabilities
     WHERE capability_id = (SELECT id FROM capabilities WHERE name = 'permit.submit');
    DELETE FROM capabilities WHERE name = 'permit.submit';
  `);

  await rejects(
    db,
    `SELECT grant_baseline_applicant_capabilities('${tp}')`,
    /baseline applicant capabilities are not both defined/,
  );

  // Nothing partial was left behind: not one capability, not zero-plus-one.
  const granted = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM team_position_capabilities WHERE team_position_id = '${tp}'`,
  );
  assert.equal(granted.rows[0]?.count, '0');
});

test('the baseline function refuses an association that does not exist', async () => {
  const db = await applied();
  await rejects(
    db,
    `SELECT grant_baseline_applicant_capabilities('40000000-0000-4000-8000-0000000000ff')`,
    /does not exist/,
  );
  await rejects(db, `SELECT grant_baseline_applicant_capabilities(NULL)`, /team position is required/);
});

test('granting the baseline twice is idempotent, never a duplicate-key failure', async () => {
  const db = await applied();
  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const position = await idOf(db, `SELECT id FROM positions WHERE name = 'Worker'`);
  const tp = await idOf(
    db,
    `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
     VALUES ('${teamId}', '${position}', TRUE) RETURNING id`,
  );
  await db.exec(`SELECT grant_baseline_applicant_capabilities('${tp}')`);
  await db.exec(`SELECT grant_baseline_applicant_capabilities('${tp}')`);

  const granted = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM team_position_capabilities WHERE team_position_id = '${tp}'`,
  );
  assert.equal(granted.rows[0]?.count, '2');
});

test('creating a new association never changes another association capability set', async () => {
  const db = await applied();
  const before = await db.query<{ team_position_id: string; name: string }>(
    `SELECT tpc.team_position_id, c.name FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id ORDER BY tpc.team_position_id, c.name`,
  );

  const teamId = await idOf(db, `SELECT id FROM teams WHERE name = 'SGRE'`);
  const position = await idOf(db, `SELECT id FROM positions WHERE name = 'CRO'`);
  const tp = await idOf(
    db,
    `INSERT INTO team_positions (team_id, position_id, site_manager_assignable)
     VALUES ('${teamId}', '${position}', TRUE) RETURNING id`,
  );
  await db.exec(`SELECT grant_baseline_applicant_capabilities('${tp}')`);

  const after = await db.query<{ team_position_id: string; name: string }>(
    `SELECT tpc.team_position_id, c.name FROM team_position_capabilities tpc
       JOIN capabilities c ON c.id = tpc.capability_id
      WHERE tpc.team_position_id <> '${tp}' ORDER BY tpc.team_position_id, c.name`,
  );
  assert.deepEqual(after.rows, before.rows, 'an existing association capability set changed');
});

// =====================================================================
// Dynamic permit applicant identity
// =====================================================================

test('a permit can name a runtime-created company as its authoritative applicant', async () => {
  const db = await applied();
  const abc = await idOf(
    db,
    `INSERT INTO companies (id, code, name)
     VALUES (gen_random_uuid(), 'ABC_CONTRACTORS', 'ABC Contractors') RETURNING id`,
  );

  // The form field takes the OTHER branch; the AUTHORITATIVE company is
  // the foreign key.
  await db.exec(`
    INSERT INTO permits (status, company, company_other,
                         applicant_display_name, applicant_company_id,
                         applicant_company_code, applicant_company_name)
    VALUES ('ISSUED', 'OTHER', 'ABC Contractors', 'Sara Ahmed', '${abc}',
            'ABC_CONTRACTORS', 'ABC Contractors')
  `);

  const row = await db.query<{ applicant_company_id: string; company_other: string }>(
    `SELECT applicant_company_id, company_other FROM permits WHERE applicant_display_name = 'Sara Ahmed'`,
  );
  assert.equal(row.rows[0]?.applicant_company_id, abc);
  assert.equal(row.rows[0]?.company_other, 'ABC Contractors');
});

test('a half-written applicant identity is still unrepresentable', async () => {
  const db = await applied();
  // The legacy snapshot must still be all-or-nothing.
  await rejects(
    db,
    `INSERT INTO permits (status, applicant_display_name) VALUES ('ISSUED', 'Sara Ahmed')`,
    /permits_applicant_identity_complete/,
  );
  await rejects(
    db,
    `INSERT INTO permits (status, applicant_display_name, applicant_company_code)
     VALUES ('ISSUED', 'Sara Ahmed', 'ZPL')`,
    /permits_applicant_identity_complete/,
  );
  await rejects(
    db,
    `INSERT INTO permits (status, applicant_display_name, applicant_company_code, applicant_company_name)
     VALUES ('ISSUED', 'Sara Ahmed', '   ', 'ABC Contractors')`,
    /permits_applicant_identity_complete/,
  );
});

test('EXPAND, TRANSITIONAL: a legacy identity without applicant_company_id is accepted', async () => {
  const db = await applied();
  // THIS IS NOT THE FINAL INVARIANT. 0035 is the EXPAND migration: it
  // must accept what the CURRENTLY DEPLOYED backend writes, which is the
  // three legacy snapshot columns and no authoritative company id.
  // Requiring the id here would break every submit and renew for as long
  // as that backend is live. The CONTRACT migration backfills these rows
  // and only then makes the column mandatory.
  await db.exec(
    `INSERT INTO permits (status, applicant_display_name, applicant_company_code, applicant_company_name)
     VALUES ('ISSUED', 'Sara Ahmed', 'ZPL', 'ZPL')`,
  );
  const row = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM permits
      WHERE applicant_display_name = 'Sara Ahmed' AND applicant_company_id IS NULL`,
  );
  assert.equal(row.rows[0]?.count, '1');
});

// ---------------------------------------------------------------------
// EXPAND -> DEPLOY -> CONTRACT: deployment compatibility
//
// 0035 is applied BEFORE the backend that writes applicant_company_id,
// so both backends must work against it simultaneously. These run the
// EXACT statements each backend version issues.
// ---------------------------------------------------------------------

/** The submit UPDATE as backend 2a498d5 issues it - six params, no company id. */
const OLD_SUBMIT = `
  UPDATE permits
     SET status = 'PENDING_CRO',
         company = $2, company_other = NULL,
         applicant_identity_kind = $3, applicant_display_name = $4,
         applicant_company_code = $5, applicant_company_name = $6
   WHERE id = $1 RETURNING *`;

/** The submit UPDATE as backend a7a1629 issues it - eight params, company id included. */
const NEW_SUBMIT = `
  UPDATE permits
     SET status = 'PENDING_CRO',
         company = $2, company_other = $3,
         applicant_identity_kind = $4, applicant_display_name = $5,
         applicant_company_id = $6, applicant_company_code = $7, applicant_company_name = $8
   WHERE id = $1 RETURNING *`;

async function newDraft(db: PGlite): Promise<string> {
  return idOf(db, `INSERT INTO permits (status) VALUES ('DRAFT') RETURNING id`);
}

test('A. OLD backend: submit without applicant_company_id succeeds against 0035', async () => {
  const db = await applied();
  const permit = await newDraft(db);
  await db.query(OLD_SUBMIT, [permit, 'ESET', 'NORMAL', 'Ali Khan', 'E_SET', 'E-SET']);

  const row = await db.query<{ code: string; id: string | null }>(
    `SELECT applicant_company_code AS code, applicant_company_id AS id FROM permits WHERE id = '${permit}'`,
  );
  assert.equal(row.rows[0]?.code, 'E_SET');
  assert.equal(row.rows[0]?.id, null, 'the old backend cannot write the new column');
});

test('A. OLD backend: renewal without applicant_company_id succeeds against 0035', async () => {
  const db = await applied();
  // The renewal INSERT column list as backend 2a498d5 issues it.
  await db.exec(
    `INSERT INTO permits (status, company, applicant_identity_kind, applicant_display_name,
                          applicant_company_code, applicant_company_name)
     VALUES ('ISSUED', 'ZPL', 'NORMAL', 'Renewed Applicant', 'ZPL', 'ZPL')`,
  );
  const row = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM permits
      WHERE applicant_display_name = 'Renewed Applicant' AND applicant_company_id IS NULL`,
  );
  assert.equal(row.rows[0]?.count, '1');
});

test('A. OLD backend: permit reads remain valid against 0035', async () => {
  const db = await applied();
  // The old PERMIT_SUMMARY_COLUMNS list - it never names the new column.
  const rows = await db.query(
    `SELECT id, status, company, company_other, applicant_identity_kind,
            applicant_display_name, applicant_company_code, applicant_company_name
       FROM permits`,
  );
  assert.ok(rows.rows.length >= 1);
});

test('B. NEW backend: submit writes applicant_company_id against 0035', async () => {
  const db = await applied();
  const permit = await newDraft(db);
  await db.query(NEW_SUBMIT, [permit, 'ESET', null, 'NORMAL', 'Ali Khan', ESET, 'E_SET', 'E-SET']);

  const row = await db.query<{ id: string }>(
    `SELECT applicant_company_id AS id FROM permits WHERE id = '${permit}'`,
  );
  assert.equal(row.rows[0]?.id, ESET);
});

test('B. NEW backend: renewal carries applicant_company_id forward', async () => {
  const db = await applied();
  const original = await newDraft(db);
  await db.query(NEW_SUBMIT, [original, 'ZPL', null, 'NORMAL', 'Renewal Applicant', ZPL, 'ZPL', 'ZPL']);
  // The renewal INSERT copies the frozen identity, company id included.
  await db.exec(
    `INSERT INTO permits (status, company, applicant_identity_kind, applicant_display_name,
                          applicant_company_id, applicant_company_code, applicant_company_name)
     SELECT 'ISSUED', company, applicant_identity_kind, applicant_display_name,
            applicant_company_id, applicant_company_code, applicant_company_name
       FROM permits WHERE id = '${original}'`,
  );
  // Scoped to this applicant: the fixture already holds one backfilled
  // historical ZPL permit, which is not what this test is about.
  const rows = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM permits
      WHERE applicant_display_name = 'Renewal Applicant' AND applicant_company_id = '${ZPL}'`,
  );
  assert.equal(rows.rows[0]?.count, '2', 'the renewal did not carry the company id forward');
});

test('B. NEW backend: list/detail/search column list works against 0035', async () => {
  const db = await applied();
  // permitSummaryColumns() now renders applicant_company_id into every
  // list read - the query that fails outright on a 0034 database.
  const rows = await db.query(
    `SELECT id, status, company, company_other, applicant_identity_kind,
            applicant_display_name, applicant_company_id, applicant_company_code,
            applicant_company_name FROM permits`,
  );
  assert.ok(rows.rows.length >= 1);
});

test('B. NEW backend: organization directory query works against 0035', async () => {
  const db = await applied();
  const rows = await db.query(
    `SELECT c.code, t.name AS team_name, p.name AS position_name, tp.id
       FROM team_positions tp
       JOIN teams t ON t.id = tp.team_id
       JOIN companies c ON c.id = t.company_id
       JOIN positions p ON p.id = tp.position_id
      WHERE tp.site_manager_assignable = TRUE
        AND tp.deactivated_at IS NULL AND t.deactivated_at IS NULL
        AND c.deactivated_at IS NULL`,
  );
  assert.equal(rows.rows.length, 18);
});

test('C. existing rows are backfilled for E_SET, ZPL and SGRE alike', async () => {
  const db = await createPre0035Db();
  // The fixture already holds one ZPL permit; add one per other company.
  await db.exec(
    `INSERT INTO permits (status, company, applicant_display_name, applicant_company_code, applicant_company_name)
     VALUES ('ISSUED','ESET','A','E_SET','E-SET'),
            ('ISSUED','SGRE','C','SGRE','SGRE')`,
  );
  await db.exec(await readFile(migration0035Url, 'utf8'));

  const rows = await db.query<{ code: string; id: string }>(
    `SELECT applicant_company_code AS code, applicant_company_id AS id
       FROM permits WHERE applicant_company_code IS NOT NULL ORDER BY applicant_company_code`,
  );
  assert.deepEqual(rows.rows, [
    { code: 'E_SET', id: ESET },
    { code: 'SGRE', id: SGRE },
    { code: 'ZPL', id: ZPL },
  ]);
});

test('D. the migration REFUSES rather than silently dropping an unresolvable company code', async () => {
  const db = await createPre0035Db();
  // Drop the old CHECK so an unresolvable code can be planted at all -
  // simulating data that predates, or sidesteps, the closed list.
  await db.exec(
    `ALTER TABLE permits DROP CONSTRAINT permits_applicant_identity_complete;
     UPDATE permits SET applicant_company_code = 'NO_SUCH_COMPANY'
      WHERE applicant_company_code IS NOT NULL`,
  );

  const sql = await readFile(migration0035Url, 'utf8');
  await rejects(db, sql, /frozen applicant company code with no companies row/);

  // And it refused BEFORE changing anything: the column was never added.
  const columns = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.columns
      WHERE table_name = 'permits' AND column_name = 'applicant_company_id'`,
  );
  assert.equal(columns.rows[0]?.count, '0');
});

test('E. the transitional state is documented IN the migration as not final', async () => {
  const sql = await readFile(migration0035Url, 'utf8');
  // The compatibility window is a deliberate, documented posture - not an
  // oversight for a later reader to guess at.
  assert.ok(sql.includes('EXPAND -> DEPLOY -> CONTRACT'));
  assert.ok(sql.includes('TRANSITIONAL AND IS NOT THE FINAL INVARIANT'));
  assert.ok(sql.includes('THE CONTRACT MIGRATION IS NOT IN THE REPOSITORY YET'));
});

test('the applicant company is frozen once written', async () => {
  const db = await applied();
  await rejects(
    db,
    `UPDATE permits SET applicant_company_id = '${ESET}' WHERE applicant_company_code = 'ZPL'`,
    /frozen and cannot be changed/,
  );
});

test('a permit still cannot name a company that does not exist', async () => {
  const db = await applied();
  await rejects(
    db,
    `INSERT INTO permits (status, applicant_display_name, applicant_company_id,
                          applicant_company_code, applicant_company_name)
     VALUES ('ISSUED', 'Sara Ahmed', '18000000-0000-4000-8000-0000000000ff', 'GHOST', 'Ghost')`,
    /foreign key|violates/i,
  );
});

test('a referenced company can never be deleted', async () => {
  const db = await applied();
  await rejects(db, `DELETE FROM companies WHERE id = '${ZPL}'`, /foreign key|violates/i);
});

// =====================================================================
// Audit
// =====================================================================

test('the organization audit is append-only for every role, including the owner', async () => {
  const db = await applied();
  const actorId = await actor(db);
  await db.exec(
    `INSERT INTO organization_audit_events (event_type, actor_user_id, company_id)
     VALUES ('COMPANY_CREATED', '${actorId}', '${ZPL}')`,
  );

  await rejects(db, `UPDATE organization_audit_events SET event_type = 'COMPANY_RENAMED'`, /append-only/);
  await rejects(db, `DELETE FROM organization_audit_events`, /append-only/);
  await rejects(db, `TRUNCATE organization_audit_events`, /append-only/);
});

test('an audit row must name the entity it happened to', async () => {
  const db = await applied();
  const actorId = await actor(db);
  await rejects(
    db,
    `INSERT INTO organization_audit_events (event_type, actor_user_id)
     VALUES ('COMPANY_CREATED', '${actorId}')`,
    /organization_audit_events_subject_present/,
  );
});

test('only a rename may carry names, and a rename must carry both', async () => {
  const db = await applied();
  const actorId = await actor(db);
  await rejects(
    db,
    `INSERT INTO organization_audit_events (event_type, actor_user_id, company_id, new_name)
     VALUES ('COMPANY_CREATED', '${actorId}', '${ZPL}', 'Sneaky')`,
    /organization_audit_events_names_for_renames/,
  );
  await rejects(
    db,
    `INSERT INTO organization_audit_events (event_type, actor_user_id, company_id, new_name)
     VALUES ('COMPANY_RENAMED', '${actorId}', '${ZPL}', 'ZPL Energy')`,
    /organization_audit_events_names_for_renames/,
  );
  await db.exec(
    `INSERT INTO organization_audit_events (event_type, actor_user_id, company_id, previous_name, new_name)
     VALUES ('COMPANY_RENAMED', '${actorId}', '${ZPL}', 'ZPL', 'ZPL Energy')`,
  );
});

test('an unknown organization event type is refused', async () => {
  const db = await applied();
  const actorId = await actor(db);
  await rejects(
    db,
    `INSERT INTO organization_audit_events (event_type, actor_user_id, company_id)
     VALUES ('CAPABILITY_GRANTED_CRO', '${actorId}', '${ZPL}')`,
    /organization_audit_events_type_valid/,
  );
});

test('the audit timestamp is the database clock, not whatever was supplied', async () => {
  const db = await applied();
  const actorId = await actor(db);
  await db.exec(
    `INSERT INTO organization_audit_events (event_type, actor_user_id, company_id, created_at)
     VALUES ('COMPANY_CREATED', '${actorId}', '${ZPL}', '1999-01-01T00:00:00Z')`,
  );
  const row = await db.query<{ year: number }>(
    `SELECT EXTRACT(YEAR FROM created_at)::int AS year FROM organization_audit_events`,
  );
  assert.notEqual(row.rows[0]?.year, 1999);
});

test('the organization audit table is RLS-enabled with no policy and no browser grant', async () => {
  const db = await applied();
  const rls = await db.query<{ relrowsecurity: boolean }>(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'organization_audit_events'`,
  );
  assert.equal(rls.rows[0]?.relrowsecurity, true);

  const policies = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_policies WHERE tablename = 'organization_audit_events'`,
  );
  assert.equal(policies.rows[0]?.count, '0');

  for (const role of ['anon', 'authenticated']) {
    const granted = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege('${role}', 'public.organization_audit_events', 'SELECT') AS ok`,
    );
    assert.equal(granted.rows[0]?.ok, false, `${role} can read the organization audit`);
  }
});

test('the baseline function is not executable by the browser roles', async () => {
  const db = await applied();
  for (const role of ['anon', 'authenticated']) {
    const granted = await db.query<{ ok: boolean }>(
      `SELECT has_function_privilege('${role}',
         'public.grant_baseline_applicant_capabilities(uuid)', 'EXECUTE') AS ok`,
    );
    assert.equal(granted.rows[0]?.ok, false, `${role} can execute the baseline grant`);
  }
});

test('every new function pins a search path, and only the baseline grant is SECURITY DEFINER', async () => {
  const db = await applied();
  const functions = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
    `SELECT p.proname, p.prosecdef, p.proconfig
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'companies_freeze_identity', 'companies_guard_deactivation', 'teams_guard_deactivation',
          'team_positions_guard_deactivation', 'teams_require_active_company',
          'team_positions_require_active_team', 'workforce_profiles_require_active_organization',
          'user_team_positions_require_active_organization', 'organization_required_coverage_gap',
          'grant_baseline_applicant_capabilities', 'organization_audit_events_authoritative_timestamp')`,
  );
  assert.equal(functions.rows.length, 11, 'a function is missing');

  for (const fn of functions.rows) {
    assert.ok(
      (fn.proconfig ?? []).some((entry) => entry.startsWith('search_path=')),
      `${fn.proname} does not pin search_path`,
    );
    const shouldBeDefiner = fn.proname === 'grant_baseline_applicant_capabilities';
    assert.equal(fn.prosecdef, shouldBeDefiner, `${fn.proname} has the wrong security mode`);
  }
});
