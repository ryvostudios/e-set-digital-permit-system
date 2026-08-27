import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * The REAL 0001 -> 0021 migration chain, executed end to end against a
 * genuine PostgreSQL engine. Nothing here hand-builds a schema subset:
 * every assertion is made against whatever the actual migration files
 * produce, so a change to any of them that breaks these invariants fails
 * this test rather than production.
 */

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);

const EMPLOYEE = '10000000-0000-4000-8000-000000000001';
const OTHER_EMPLOYEE = '10000000-0000-4000-8000-000000000002';
const PRIVILEGED = '10000000-0000-4000-8000-000000000003';
const E_SET = '18000000-0000-4000-8000-000000000001';
const ZPL = '18000000-0000-4000-8000-000000000002';
const CEO = '10000000-0000-4000-8000-0000000000c0';
const SM_TARGET = '10000000-0000-4000-8000-0000000000c1';
const IMPOSTOR = '10000000-0000-4000-8000-0000000000c2';
const NAMELESS = '10000000-0000-4000-8000-0000000000c3';

async function createSupabaseSubstrate(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${EMPLOYEE}'), ('${OTHER_EMPLOYEE}'), ('${PRIVILEGED}');
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
  return db;
}

async function applyRealMigrations(db: PGlite, lastId: number): Promise<void> {
  const names = (await readdir(migrationsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^\d{4}_.+\.sql$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((name) => Number(name.slice(0, 4)) <= lastId)
    .sort();
  assert.deepEqual(
    names.map((name) => Number(name.slice(0, 4))),
    Array.from({ length: lastId }, (_, index) => index + 1),
    'the migration chain must have no gaps',
  );
  for (const name of names) {
    await db.exec(await readFile(new URL(name, migrationsDirectory), 'utf8'));
  }
}

/** Resolves the seeded Team + Position id for one company/team/position triple. */
async function teamPositionId(db: PGlite, company: string, team: string, position: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `SELECT tp.id FROM team_positions tp
       JOIN teams t ON t.id = tp.team_id
       JOIN positions p ON p.id = tp.position_id
       JOIN companies c ON c.id = t.company_id
      WHERE c.code = $1 AND t.name = $2 AND p.name = $3`,
    [company, team, position],
  );
  const id = result.rows[0]?.id;
  assert.ok(id, `expected a seeded team position for ${company}/${team}/${position}`);
  return id;
}

async function capabilitiesOf(db: PGlite, teamPosition: string): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    `SELECT cap.name FROM team_position_capabilities tpc
       JOIN capabilities cap ON cap.id = tpc.capability_id
      WHERE tpc.team_position_id = $1 ORDER BY cap.name`,
    [teamPosition],
  );
  return result.rows.map((row) => row.name);
}

describe('0019 + 0020 + 0021 on the actual repository migration chain', { concurrency: false }, () => {
  let db: PGlite;
  before(async () => {
    db = await createSupabaseSubstrate();
    await applyRealMigrations(db, 21);
  });
  after(async () => { await db.close(); });

  // -------------------------------------------------------------------
  // Organization seed (0020)
  // -------------------------------------------------------------------

  test('the launch organization is seeded exactly as confirmed', async () => {
    const teams = await db.query<{ code: string; name: string }>(
      `SELECT c.code, t.name FROM teams t JOIN companies c ON c.id = t.company_id
        ORDER BY c.code, t.name`,
    );
    assert.deepEqual(teams.rows, [
      { code: 'E_SET', name: 'Admin' },
      { code: 'E_SET', name: 'Civil' },
      { code: 'E_SET', name: 'E-BOP' },
      { code: 'E_SET', name: 'HSE' },
      { code: 'E_SET', name: 'WTG' },
      { code: 'SGRE', name: 'SGRE' },
      { code: 'ZPL', name: 'ZPL' },
    ]);

    const combos = await db.query<{ code: string; team: string; position: string }>(
      `SELECT c.code, t.name AS team, p.name AS position
         FROM team_positions tp
         JOIN teams t ON t.id = tp.team_id
         JOIN positions p ON p.id = tp.position_id
         JOIN companies c ON c.id = t.company_id
        ORDER BY c.code, t.name, p.name`,
    );
    assert.deepEqual(combos.rows, [
      { code: 'E_SET', team: 'Admin', position: 'Admin Lead' },
      { code: 'E_SET', team: 'Admin', position: 'Assistant Admin' },
      { code: 'E_SET', team: 'Civil', position: 'Supervisor' },
      { code: 'E_SET', team: 'Civil', position: 'Team Lead' },
      { code: 'E_SET', team: 'Civil', position: 'Worker' },
      { code: 'E_SET', team: 'E-BOP', position: 'CRO' },
      { code: 'E_SET', team: 'E-BOP', position: 'Team Lead' },
      { code: 'E_SET', team: 'E-BOP', position: 'Technician' },
      { code: 'E_SET', team: 'HSE', position: 'Paramedic' },
      { code: 'E_SET', team: 'HSE', position: 'Team Lead' },
      { code: 'E_SET', team: 'WTG', position: 'Engineer' },
      { code: 'E_SET', team: 'WTG', position: 'Team Lead' },
      { code: 'E_SET', team: 'WTG', position: 'Technician' },
      { code: 'SGRE', team: 'SGRE', position: 'Team Lead' },
      { code: 'ZPL', team: 'ZPL', position: 'Asset Manager' },
      { code: 'ZPL', team: 'ZPL', position: 'Engineer' },
      { code: 'ZPL', team: 'ZPL', position: 'HSE' },
      { code: 'ZPL', team: 'ZPL', position: 'Site Manager' },
    ]);
  });

  test('every launch Team + Position is approved for employee provisioning, CRO included', async () => {
    const notAssignable = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM team_positions WHERE NOT site_manager_assignable',
    );
    assert.equal(notAssignable.rows[0]?.count, 0);
    const cro = await teamPositionId(db, 'E_SET', 'E-BOP', 'CRO');
    const croAssignable = await db.query<{ site_manager_assignable: boolean }>(
      'SELECT site_manager_assignable FROM team_positions WHERE id = $1', [cro],
    );
    assert.equal(croAssignable.rows[0]?.site_manager_assignable, true);
  });

  test('CRO workflow authority belongs to E-SET E-BOP CRO and to nobody else', async () => {
    const cro = await teamPositionId(db, 'E_SET', 'E-BOP', 'CRO');
    assert.deepEqual(await capabilitiesOf(db, cro), [
      'permit.cancel',
      'permit.close',
      'permit.cro_review',
      'permit.fallback_approve',
      'permit.forward_hse',
      'permit.hold',
      'permit.renew',
      'permit.resume',
      'permit.send_back',
    ]);

    // CRO cannot apply for a permit - the confirmed exclusion.
    assert.equal((await capabilitiesOf(db, cro)).includes('permit.create'), false);
    assert.equal((await capabilitiesOf(db, cro)).includes('permit.submit'), false);

    // The CRO-only operational actions exist on exactly one combination.
    for (const capability of ['permit.hold', 'permit.resume', 'permit.cancel', 'permit.close', 'permit.renew', 'permit.cro_review', 'permit.forward_hse', 'permit.fallback_approve', 'permit.send_back']) {
      const holders = await db.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM team_position_capabilities tpc
           JOIN capabilities cap ON cap.id = tpc.capability_id WHERE cap.name = $1`,
        [capability],
      );
      assert.equal(holders.rows[0]?.count, 1, `${capability} must be held by exactly one Team + Position`);
    }
  });

  test('HSE approval belongs only to E-SET HSE Team Lead and Paramedic - ZPL HSE has none', async () => {
    const holders = await db.query<{ code: string; team: string; position: string }>(
      `SELECT c.code, t.name AS team, p.name AS position
         FROM team_position_capabilities tpc
         JOIN capabilities cap ON cap.id = tpc.capability_id
         JOIN team_positions tp ON tp.id = tpc.team_position_id
         JOIN teams t ON t.id = tp.team_id
         JOIN positions p ON p.id = tp.position_id
         JOIN companies c ON c.id = t.company_id
        WHERE cap.name = 'permit.hse_review' ORDER BY p.name`,
    );
    assert.deepEqual(holders.rows, [
      { code: 'E_SET', team: 'HSE', position: 'Paramedic' },
      { code: 'E_SET', team: 'HSE', position: 'Team Lead' },
    ]);

    // ZPL's HSE position is a normal applicant and nothing more.
    const zplHse = await teamPositionId(db, 'ZPL', 'ZPL', 'HSE');
    assert.deepEqual(await capabilitiesOf(db, zplHse), ['permit.create', 'permit.submit']);
  });

  test('every normal launch role except CRO may apply, across all three companies', async () => {
    for (const [company, team, position] of [
      ['E_SET', 'Admin', 'Admin Lead'],
      ['E_SET', 'Civil', 'Worker'],
      ['E_SET', 'WTG', 'Technician'],
      ['E_SET', 'E-BOP', 'Team Lead'],
      ['E_SET', 'HSE', 'Paramedic'],
      ['ZPL', 'ZPL', 'Site Manager'],
      ['ZPL', 'ZPL', 'Asset Manager'],
      ['ZPL', 'ZPL', 'Engineer'],
      ['SGRE', 'SGRE', 'Team Lead'],
    ] as const) {
      const id = await teamPositionId(db, company, team, position);
      const caps = await capabilitiesOf(db, id);
      assert.ok(caps.includes('permit.create'), `${company}/${team}/${position} must be able to apply`);
      assert.ok(caps.includes('permit.submit'), `${company}/${team}/${position} must be able to submit`);
    }
  });

  test('account management is never a Team + Position capability', async () => {
    const mapped = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM team_position_capabilities tpc
         JOIN capabilities cap ON cap.id = tpc.capability_id
        WHERE cap.name IN ('employee.create', 'employee.reset_password')`,
    );
    assert.equal(mapped.rows[0]?.count, 0);
  });

  test("a ZPL organizational Site Manager holds no privileged authority and no E-SET capability", async () => {
    const zplSiteManager = await teamPositionId(db, 'ZPL', 'ZPL', 'Site Manager');
    assert.deepEqual(await capabilitiesOf(db, zplSiteManager), ['permit.create', 'permit.submit']);
    // The position name exists only as organization data; privilege lives
    // in a different table entirely and no seed writes to it.
    const grants = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM privileged_access_events',
    );
    assert.equal(grants.rows[0]?.count, 0, 'no migration may seed a privileged grant');
  });

  // -------------------------------------------------------------------
  // Privileged identity + the two-directional invariant (0019)
  // -------------------------------------------------------------------

  test('a privileged identity carries a display name with no company, team or position', async () => {
    await db.exec(`INSERT INTO privileged_identities (user_id, display_name)
      VALUES ('${PRIVILEGED}', 'Sana Iqbal')`);
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'privileged_identities' ORDER BY column_name`,
    );
    assert.deepEqual(columns.rows.map((r) => r.column_name),
      ['created_at', 'display_name', 'updated_at', 'user_id']);

    // Granting the role is a separate act in a separate table.
    await db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
      VALUES ('${PRIVILEGED}', 'CEO', 'GRANTED')`);
    const named = await db.query<{ display_name: string }>(
      `SELECT display_name FROM privileged_identities WHERE user_id = '${PRIVILEGED}'`,
    );
    assert.equal(named.rows[0]?.display_name, 'Sana Iqbal');
  });

  test('a blank privileged display name is refused', async () => {
    await assert.rejects(db.exec(`INSERT INTO privileged_identities (user_id, display_name)
      VALUES ('${OTHER_EMPLOYEE}', '   ')`));
  });

  test('privileged identity timestamps are database-authoritative', async () => {
    await db.exec(`UPDATE privileged_identities SET created_at = '1999-01-01', updated_at = '1999-01-01'
      WHERE user_id = '${PRIVILEGED}'`);
    const row = await db.query<{ created_at: Date; updated_at: Date }>(
      `SELECT created_at, updated_at FROM privileged_identities WHERE user_id = '${PRIVILEGED}'`,
    );
    assert.ok(row.rows[0]!.created_at.getUTCFullYear() > 2000, 'created_at is pinned, never client-supplied');
    assert.ok(row.rows[0]!.updated_at.getUTCFullYear() > 2000);
  });

  test('privileged_identities is RLS-enabled, policy-free and has no browser grants', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'privileged_identities'`,
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true);
    const policies = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_policies WHERE tablename = 'privileged_identities'`,
    );
    assert.equal(policies.rows[0]?.count, 0);
    const grants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_table_grants
        WHERE table_name = 'privileged_identities' AND grantee IN ('anon','authenticated','PUBLIC')`,
    );
    assert.equal(grants.rows[0]?.count, 0);
  });

  test('every function added by 0019 is SECURITY INVOKER with a pinned search_path', async () => {
    const functions = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
        WHERE proname IN (
          'privileged_identities_authoritative_timestamps',
          'reject_privileged_grant_for_employee',
          'workforce_profiles_company_matches_team',
          'user_team_positions_authoritative_period',
          'workforce_profiles_primary_assignment_current'
        ) ORDER BY proname`,
    );
    assert.equal(functions.rows.length, 5);
    for (const fn of functions.rows) {
      assert.equal(fn.prosecdef, false, `${fn.proname} must be SECURITY INVOKER`);
      assert.ok(fn.proconfig?.includes('search_path=pg_catalog'), `${fn.proname} must pin search_path`);
    }
  });

  // -------------------------------------------------------------------
  // Assignments, company/team consistency, and the invariant
  // -------------------------------------------------------------------

  test('an employee holds exactly one CURRENT assignment, with the old one preserved', async () => {
    const worker = await teamPositionId(db, 'E_SET', 'Civil', 'Worker');
    const technician = await teamPositionId(db, 'E_SET', 'WTG', 'Technician');

    await db.exec(`INSERT INTO user_team_positions (user_id, team_position_id)
      VALUES ('${EMPLOYEE}', '${worker}')`);
    await db.exec(`INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
      VALUES ('${EMPLOYEE}', 'Ayesha Khan', '${worker}', '${E_SET}')`);

    // A second CURRENT assignment is impossible.
    await assert.rejects(db.exec(`INSERT INTO user_team_positions (user_id, team_position_id)
      VALUES ('${EMPLOYEE}', '${technician}')`), /user_team_positions_one_current_per_user/);

    // Transfer: end the old one, then add the new one. Both rows survive.
    await db.exec(`UPDATE user_team_positions SET ended_at = now()
      WHERE user_id = '${EMPLOYEE}' AND team_position_id = '${worker}'`);
    await db.exec(`INSERT INTO user_team_positions (user_id, team_position_id)
      VALUES ('${EMPLOYEE}', '${technician}')`);
    await db.exec(`UPDATE workforce_profiles SET primary_team_position_id = '${technician}'
      WHERE user_id = '${EMPLOYEE}'`);

    const history = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM user_team_positions WHERE user_id = '${EMPLOYEE}'`,
    );
    assert.equal(history.rows[0]?.count, 2, 'the previous assignment is preserved, never deleted');
    const current = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM user_team_positions
        WHERE user_id = '${EMPLOYEE}' AND ended_at IS NULL`,
    );
    assert.equal(current.rows[0]?.count, 1);
  });

  test('assignment periods are database-authoritative, never client-supplied', async () => {
    const row = await db.query<{ started_at: Date; ended_at: Date | null }>(
      `SELECT started_at, ended_at FROM user_team_positions
        WHERE user_id = '${EMPLOYEE}' AND ended_at IS NOT NULL`,
    );
    assert.ok(row.rows[0]!.ended_at!.getUTCFullYear() > 2000);
    await db.exec(`UPDATE user_team_positions SET ended_at = '1999-01-01'
      WHERE user_id = '${EMPLOYEE}' AND ended_at IS NOT NULL`);
    const after = await db.query<{ ended_at: Date }>(
      `SELECT ended_at FROM user_team_positions
        WHERE user_id = '${EMPLOYEE}' AND ended_at IS NOT NULL`,
    );
    assert.ok(after.rows[0]!.ended_at.getUTCFullYear() > 2000, 'an ended period cannot be backdated');
  });

  test('a primary assignment that has been ended is refused', async () => {
    const worker = await teamPositionId(db, 'E_SET', 'Civil', 'Worker');
    await assert.rejects(
      db.exec(`UPDATE workforce_profiles SET primary_team_position_id = '${worker}'
        WHERE user_id = '${EMPLOYEE}'`),
      /CURRENT assignment/,
    );
  });

  test('an employee cannot be assigned to another company\'s team', async () => {
    const zplEngineer = await teamPositionId(db, 'ZPL', 'ZPL', 'Engineer');
    await db.exec(`INSERT INTO user_team_positions (user_id, team_position_id)
      VALUES ('${OTHER_EMPLOYEE}', '${zplEngineer}')`);
    // A ZPL assignment with an E-SET company is refused by the database.
    await assert.rejects(
      db.exec(`INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
        VALUES ('${OTHER_EMPLOYEE}', 'Imran Malik', '${zplEngineer}', '${E_SET}')`),
      /cross-company assignment/,
    );
    // The matching company is accepted.
    await db.exec(`INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
      VALUES ('${OTHER_EMPLOYEE}', 'Imran Malik', '${zplEngineer}', '${ZPL}')`);
  });

  test('a normal employee can never be granted privileged system access', async () => {
    await assert.rejects(
      db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
        VALUES ('${EMPLOYEE}', 'SITE_MANAGER', 'GRANTED')`),
      /normal workforce employee/,
    );
    await assert.rejects(
      db.exec(`INSERT INTO privileged_identities (user_id, display_name)
        VALUES ('${EMPLOYEE}', 'Sneaky Promotion')`),
      /normal workforce employee/,
    );
    // Nothing was silently converted: the employee keeps their profile.
    const profile = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM workforce_profiles WHERE user_id = '${EMPLOYEE}'`,
    );
    assert.equal(profile.rows[0]?.count, 1);
  });

  test('a REVOKE is always permitted - withdrawing authority is never blocked', async () => {
    await db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
      VALUES ('${EMPLOYEE}', 'SITE_MANAGER', 'REVOKED')`);
    const rows = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM privileged_access_events
        WHERE user_id = '${EMPLOYEE}' AND action = 'REVOKED'`,
    );
    assert.equal(rows.rows[0]?.count, 1);
  });

  test('a privileged user still cannot be given a workforce profile (0018, both directions now closed)', async () => {
    const admin = await teamPositionId(db, 'E_SET', 'Admin', 'Admin Lead');
    await db.exec(`INSERT INTO user_team_positions (user_id, team_position_id)
      VALUES ('${PRIVILEGED}', '${admin}')`);
    await assert.rejects(
      db.exec(`INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
        VALUES ('${PRIVILEGED}', 'Sana Iqbal', '${admin}', '${E_SET}')`),
      /privileged system access/,
    );
  });

  // -------------------------------------------------------------------
  // record_site_manager_grant: the only path to a privileged event
  // -------------------------------------------------------------------

  test('the ordinary runtime role can neither write nor invoke privileged authority', async () => {
    // The security boundary this whole design rests on: possession of the
    // ordinary DATABASE_URL must not be enough to grant SITE_MANAGER.
    // `app_runtime` exists in this substrate, so the privileges are real.
    await db.exec('CREATE ROLE app_runtime');
    const tableGrants = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_name = 'privileged_access_events' AND grantee = 'app_runtime'`,
    );
    assert.deepEqual(tableGrants.rows, [], 'no INSERT (or any) privilege on the grant log');

    const sequenceGrants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_usage_grants
        WHERE object_name = 'privileged_access_events_ordinal_seq' AND grantee = 'app_runtime'`,
    );
    assert.equal(sequenceGrants.rows[0]?.count, 0, 'no sequence privilege either');

    const executeGrants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_routine_grants
        WHERE routine_name = 'record_site_manager_grant' AND grantee = 'app_runtime'`,
    );
    assert.equal(executeGrants.rows[0]?.count, 0, 'no EXECUTE on the hardened function');

    // Proven by attempt, not only by catalog: acting AS app_runtime.
    await db.exec('SET ROLE app_runtime');
    try {
      await assert.rejects(
        db.exec(`INSERT INTO public.privileged_access_events (user_id, role, action)
                 VALUES ('${IMPOSTOR}', 'CEO', 'GRANTED')`),
        /permission denied/,
      );
      await assert.rejects(
        db.exec(`SELECT public.record_site_manager_grant('${CEO}', '${IMPOSTOR}', 'GRANTED')`),
        /permission denied/,
      );
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  test('0021 closes the Supabase default EXECUTE grant to service_role', async () => {
    // Supabase grants EXECUTE on every public function to `service_role`
    // by default. 0019's role-listed REVOKE could not remove a grant to a
    // role it did not name, so live verification found the function still
    // executable by service_role. 0021 removes it; only the owner remains.
    const grantees = await db.query<{ grantee: string }>(
      `SELECT grantee FROM information_schema.role_routine_grants
        WHERE routine_name = 'record_site_manager_grant' ORDER BY grantee`,
    );
    assert.equal(grantees.rows.some((r) => r.grantee === 'service_role'), false);
    for (const role of ['anon', 'authenticated', 'PUBLIC', 'app_runtime']) {
      assert.equal(grantees.rows.some((r) => r.grantee === role), false, `${role} must not execute it`);
    }
  });

  test('the grant function is SECURITY DEFINER, pinned, and closed to PUBLIC/anon/authenticated', async () => {
    const fn = await db.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'record_site_manager_grant'`,
    );
    assert.equal(fn.rows[0]?.prosecdef, true, 'DEFINER is required so app_runtime needs no direct INSERT');
    assert.ok(fn.rows[0]?.proconfig?.includes('search_path=pg_catalog'));
    const grants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.role_routine_grants
        WHERE routine_name = 'record_site_manager_grant'
          AND grantee IN ('anon','authenticated','PUBLIC')`,
    );
    assert.equal(grants.rows[0]?.count, 0);
    // It is the ONLY SECURITY DEFINER function in the whole schema.
    const definers = await db.query<{ proname: string }>(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef ORDER BY p.proname`,
    );
    assert.deepEqual(definers.rows.map((r) => r.proname), ['record_site_manager_grant']);
  });

  test('the role is hardcoded: no argument can produce a CEO grant', async () => {
    await db.exec(`INSERT INTO auth.users VALUES ('${CEO}'), ('${SM_TARGET}')`);
    await db.exec(`INSERT INTO app_user_access (user_id, state) VALUES ('${CEO}', 'ACTIVE'), ('${SM_TARGET}', 'ACTIVE')`);
    await db.exec(`INSERT INTO privileged_identities (user_id, display_name)
      VALUES ('${CEO}', 'The CEO'), ('${SM_TARGET}', 'A Manager')`);
    await db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
      VALUES ('${CEO}', 'CEO', 'GRANTED')`);

    await db.exec(`SELECT public.record_site_manager_grant('${CEO}', '${SM_TARGET}', 'GRANTED')`);
    const written = await db.query<{ role: string; action: string; actor_user_id: string }>(
      `SELECT role, action, actor_user_id FROM privileged_access_events
        WHERE user_id = '${SM_TARGET}' ORDER BY ordinal DESC LIMIT 1`,
    );
    assert.deepEqual(written.rows[0], { role: 'SITE_MANAGER', action: 'GRANTED', actor_user_id: CEO });

    // The function takes no role parameter at all, so CEO is unreachable.
    await assert.rejects(
      db.exec(`SELECT public.record_site_manager_grant('${CEO}', '${SM_TARGET}', 'CEO')`),
      /invalid privileged action/,
    );
    const ceoGrants = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM privileged_access_events
        WHERE user_id = '${SM_TARGET}' AND role = 'CEO'`,
    );
    assert.equal(ceoGrants.rows[0]?.count, 0);
  });

  test('the function re-derives CEO status and refuses a non-CEO actor, a self-change, and the CEO tier', async () => {
    await db.exec(`INSERT INTO auth.users VALUES ('${IMPOSTOR}')`);
    await db.exec(`INSERT INTO app_user_access (user_id, state) VALUES ('${IMPOSTOR}', 'ACTIVE')`);
    await db.exec(`INSERT INTO privileged_identities (user_id, display_name) VALUES ('${IMPOSTOR}', 'Impostor')`);

    // A SITE_MANAGER actor is not a CEO and is refused by the database.
    await assert.rejects(
      db.exec(`SELECT public.record_site_manager_grant('${SM_TARGET}', '${IMPOSTOR}', 'GRANTED')`),
      /only an active CEO/,
    );
    await assert.rejects(
      db.exec(`SELECT public.record_site_manager_grant('${IMPOSTOR}', '${SM_TARGET}', 'REVOKED')`),
      /only an active CEO/,
    );
    await assert.rejects(
      db.exec(`SELECT public.record_site_manager_grant('${CEO}', '${CEO}', 'REVOKED')`),
      /own privileged role/,
    );
    assert.equal((await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM privileged_access_events WHERE user_id = '${IMPOSTOR}'`,
    )).rows[0]?.count, 0);
  });

  test('the function refuses to promote a workforce employee or a name-less identity', async () => {
    await db.exec(`INSERT INTO auth.users VALUES ('${NAMELESS}')`);
    await db.exec(`INSERT INTO app_user_access (user_id, state) VALUES ('${NAMELESS}', 'ACTIVE')`);
    await assert.rejects(
      db.exec(`SELECT public.record_site_manager_grant('${CEO}', '${NAMELESS}', 'GRANTED')`),
      /no authoritative privileged identity/,
    );
    await db.exec(`INSERT INTO app_user_access (user_id, state) VALUES ('${EMPLOYEE}', 'ACTIVE')
      ON CONFLICT (user_id) DO NOTHING`);
    await assert.rejects(
      db.exec(`SELECT public.record_site_manager_grant('${CEO}', '${EMPLOYEE}', 'GRANTED')`),
      /normal workforce employee/,
    );
  });

  test('multiple concurrent SITE_MANAGER identities are allowed', async () => {
    const managerA = '10000000-0000-4000-8000-00000000000a';
    const managerB = '10000000-0000-4000-8000-00000000000b';
    await db.exec(`INSERT INTO auth.users VALUES ('${managerA}'), ('${managerB}')`);
    for (const manager of [managerA, managerB]) {
      await db.exec(`INSERT INTO privileged_identities (user_id, display_name)
        VALUES ('${manager}', 'Site Manager ${manager.slice(-1)}')`);
      await db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
        VALUES ('${manager}', 'SITE_MANAGER', 'GRANTED')`);
    }
    const active = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT DISTINCT ON (user_id, role) user_id, role, action
           FROM privileged_access_events
          WHERE role = 'SITE_MANAGER' AND user_id IN ('${managerA}', '${managerB}')
          ORDER BY user_id, role, ordinal DESC
       ) latest WHERE latest.action = 'GRANTED'`,
    );
    assert.equal(active.rows[0]?.count, 2, 'both are active at the same time');
  });
});

test('0019 refuses to run when an existing team has no authoritative company', async () => {
  const db = await createSupabaseSubstrate();
  try {
    await applyRealMigrations(db, 18);
    await db.exec(`INSERT INTO teams (name) VALUES ('Legacy Team')`);
    const sql = await readFile(new URL('0019_privileged_identity_and_assignment_history.sql', migrationsDirectory), 'utf8');
    await assert.rejects(async () => {
      await db.exec('BEGIN');
      try { await db.exec(sql); await db.exec('COMMIT'); }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
    }, /no authoritative company owner/);
    const table = await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM information_schema.tables WHERE table_name = 'privileged_identities'`,
    );
    assert.equal(table.rows[0]?.count, 0, 'nothing is created when the precondition fails');
  } finally { await db.close(); }
});

test('0020 refuses to seed into a non-empty organization', async () => {
  const db = await createSupabaseSubstrate();
  try {
    await applyRealMigrations(db, 19);
    await db.exec(`INSERT INTO teams (name, company_id) VALUES ('Pre-existing', '${E_SET}')`);
    const sql = await readFile(new URL('0020_organization_launch_seed.sql', migrationsDirectory), 'utf8');
    await assert.rejects(async () => {
      await db.exec('BEGIN');
      try { await db.exec(sql); await db.exec('COMMIT'); }
      catch (error) { await db.exec('ROLLBACK'); throw error; }
    }, /already exist/);
    const positions = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM positions');
    assert.equal(positions.rows[0]?.count, 0);
  } finally { await db.close(); }
});
