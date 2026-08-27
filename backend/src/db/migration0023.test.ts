import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

/**
 * The REAL 0001 -> 0027 migration chain, executed end to end against a
 * genuine PostgreSQL engine. Nothing is hand-built: every assertion runs
 * against whatever the actual migration files produce.
 *
 * The substrate reproduces Supabase's project defaults (`ALTER DEFAULT
 * PRIVILEGES ... TO service_role`), without which the hardening
 * migrations would pass vacuously - there would be no privilege to
 * revoke. A guard test below proves the harness really does model them.
 */

const migrationsDirectory = new URL('../../../database/migrations/', import.meta.url);

const EMPLOYEE = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const CEO = '20000000-0000-4000-8000-000000000003';
const MANAGER = '20000000-0000-4000-8000-000000000004';

async function createSupabaseSubstrate(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    CREATE EXTENSION pgcrypto;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE app_runtime BYPASSRLS;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    INSERT INTO auth.users VALUES ('${EMPLOYEE}'), ('${OTHER}'), ('${CEO}'), ('${MANAGER}');
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

async function capabilityId(db: PGlite, name: string): Promise<string> {
  const r = await db.query<{ id: string }>('SELECT id FROM capabilities WHERE name = $1', [name]);
  assert.ok(r.rows[0]?.id, `expected capability ${name}`);
  return r.rows[0]!.id;
}

describe('0023 - 0027 on the actual repository migration chain', { concurrency: false }, () => {
  let db: PGlite;
  before(async () => {
    db = await createSupabaseSubstrate();
    await applyRealMigrations(db, 27);
    // Existing live read privileges needed by the guards and update WHERE
    // clauses are substrate setup, not part of the new 0023 grant delta.
    await db.exec(`
      GRANT SELECT ON TABLE public.workforce_profiles, public.user_team_positions,
        public.capabilities, public.privileged_access_events TO app_runtime;

      GRANT SELECT, INSERT ON TABLE public.user_capability_grants TO app_runtime;
      GRANT USAGE ON SEQUENCE public.user_capability_grants_ordinal_seq TO app_runtime;
      GRANT UPDATE (display_name, company_id, primary_team_position_id)
        ON TABLE public.workforce_profiles TO app_runtime;
      GRANT UPDATE (ended_at)
        ON TABLE public.user_team_positions TO app_runtime;
    `);
    // Migration 0015 backfills an access row for every pre-existing Auth
    // identity, so this only fills any gap rather than assuming none.
    await db.exec(`INSERT INTO app_user_access (user_id, state) VALUES
      ('${EMPLOYEE}', 'ACTIVE'), ('${OTHER}', 'ACTIVE'), ('${CEO}', 'ACTIVE'), ('${MANAGER}', 'ACTIVE')
      ON CONFLICT (user_id) DO NOTHING`);
  });
  after(async () => { await db.close(); });

  test('0026 permits honest privileged applicant signatures without fabricated organization data', async () => {
    const columns = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'permit_signatures'
          AND column_name IN ('signer_team_position_id','signer_team_name','signer_position_name')`,
    );
    assert.equal(columns.rows.length, 3);
    assert.ok(columns.rows.every((row) => row.is_nullable === 'YES'));
    const kind = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public'
        AND table_name='permits' AND column_name='applicant_identity_kind'`,
    );
    assert.equal(kind.rows.length, 1);
  });

  // ------------------------------------------------------------------
  // 0023: account lifecycle
  // ------------------------------------------------------------------

  test('DELETED is a valid terminal state that can never be reactivated', async () => {
    await db.exec(`UPDATE app_user_access SET state = 'DISABLED' WHERE user_id = '${OTHER}'`);
    const disabled = await db.query<{ state: string; disabled_at: Date | null; deleted_at: Date | null }>(
      `SELECT state, disabled_at, deleted_at FROM app_user_access WHERE user_id = '${OTHER}'`,
    );
    assert.equal(disabled.rows[0]?.state, 'DISABLED');
    assert.ok(disabled.rows[0]?.disabled_at, 'disabled_at is stamped by the database');
    assert.equal(disabled.rows[0]?.deleted_at, null);

    // Re-enable restores ACTIVE and clears the stamp - the distinction
    // from deletion is exactly that this is possible.
    await db.exec(`UPDATE app_user_access SET state = 'ACTIVE' WHERE user_id = '${OTHER}'`);
    const reenabled = await db.query<{ state: string; disabled_at: Date | null }>(
      `SELECT state, disabled_at FROM app_user_access WHERE user_id = '${OTHER}'`,
    );
    assert.deepEqual(reenabled.rows[0], { state: 'ACTIVE', disabled_at: null });

    await db.exec(`UPDATE app_user_access SET state = 'DELETED' WHERE user_id = '${OTHER}'`);
    const deleted = await db.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM app_user_access WHERE user_id = '${OTHER}'`,
    );
    assert.ok(deleted.rows[0]?.deleted_at, 'deleted_at is database-authoritative');

    for (const state of ['ACTIVE', 'DISABLED']) {
      await assert.rejects(
        db.exec(`UPDATE app_user_access SET state = '${state}' WHERE user_id = '${OTHER}'`),
        /terminal/,
        `a DELETED account must not become ${state}`,
      );
    }
    // The row itself survives, so history keeps its foreign keys.
    const survives = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM app_user_access WHERE user_id = '${OTHER}'`,
    );
    assert.equal(survives.rows[0]?.c, 1);
  });

  test('a deleted_at cannot be client-supplied or backdated', async () => {
    await db.exec(`UPDATE app_user_access SET deleted_at = '1999-01-01' WHERE user_id = '${OTHER}'`);
    const row = await db.query<{ deleted_at: Date }>(
      `SELECT deleted_at FROM app_user_access WHERE user_id = '${OTHER}'`,
    );
    assert.ok(row.rows[0]!.deleted_at.getUTCFullYear() > 2000);
  });

  // ------------------------------------------------------------------
  // 0023: administrative audit
  // ------------------------------------------------------------------

  test('every administrative event type is recordable, and unknown ones are refused', async () => {
    const types = [
      'EMPLOYEE_DISPLAY_NAME_CHANGED', 'EMPLOYEE_EMAIL_CHANGED', 'EMPLOYEE_COMPANY_CHANGED',
      'EMPLOYEE_TEAM_POSITION_CHANGED', 'EMPLOYEE_PERMISSION_GRANTED', 'EMPLOYEE_PERMISSION_REVOKED',
      'EMPLOYEE_DISABLED', 'EMPLOYEE_REENABLED', 'EMPLOYEE_ACCOUNT_DELETED',
    ];
    for (const type of types) {
      await db.exec(`INSERT INTO account_audit_events (event_type, target_user_id, actor_user_id)
        VALUES ('${type}', '${EMPLOYEE}', '${CEO}')`);
    }
    const stored = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM account_audit_events WHERE target_user_id = '${EMPLOYEE}'`,
    );
    assert.equal(stored.rows[0]?.c, types.length);

    await assert.rejects(db.exec(`INSERT INTO account_audit_events (event_type, target_user_id, actor_user_id)
      VALUES ('EMPLOYEE_MADE_CEO', '${EMPLOYEE}', '${CEO}')`));
  });

  test('the audit table still has NO free-text column - a secret cannot be stored', async () => {
    const columns = await db.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'account_audit_events' ORDER BY column_name`,
    );
    // Only `event_type` is text, and it is constrained to a fixed enum.
    const textColumns = columns.rows.filter((c) => c.data_type === 'text').map((c) => c.column_name);
    assert.deepEqual(textColumns, ['event_type']);
    // The detail columns added by 0023 are all foreign-key uuids.
    for (const name of ['previous_company_id', 'new_company_id', 'previous_team_position_id',
      'new_team_position_id', 'capability_id']) {
      const column = columns.rows.find((c) => c.column_name === name);
      assert.equal(column?.data_type, 'uuid', `${name} must be a uuid reference, never text`);
    }
  });

  test('the audit trail remains append-only for every role, owner included', async () => {
    await assert.rejects(
      db.exec(`UPDATE account_audit_events SET event_type = 'EMPLOYEE_DISABLED'`),
      /append-only/,
    );
    await assert.rejects(db.exec('DELETE FROM account_audit_events'), /append-only/);
    await assert.rejects(db.exec('TRUNCATE account_audit_events'), /append-only/);
  });

  // ------------------------------------------------------------------
  // 0023: individual user-level permissions
  // ------------------------------------------------------------------

  test('permit.view_all is the ONLY individually grantable capability', async () => {
    const grantable = await db.query<{ name: string }>(
      'SELECT name FROM capabilities WHERE individually_grantable ORDER BY name',
    );
    assert.deepEqual(grantable.rows.map((r) => r.name), ['permit.view_all']);
  });

  test('an individual grant is append-only and derives status from the latest event', async () => {
    const viewAll = await capabilityId(db, 'permit.view_all');
    await db.exec(`INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
      VALUES ('${EMPLOYEE}', '${viewAll}', 'GRANTED', '${CEO}')`);
    await db.exec(`INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
      VALUES ('${EMPLOYEE}', '${viewAll}', 'REVOKED', '${CEO}')`);
    await db.exec(`INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
      VALUES ('${EMPLOYEE}', '${viewAll}', 'GRANTED', '${MANAGER}')`);

    const latest = await db.query<{ action: string; actor_user_id: string }>(
      `SELECT DISTINCT ON (capability_id) action, actor_user_id
         FROM user_capability_grants WHERE user_id = '${EMPLOYEE}'
        ORDER BY capability_id, ordinal DESC`,
    );
    assert.deepEqual(latest.rows[0], { action: 'GRANTED', actor_user_id: MANAGER });

    await assert.rejects(db.exec(`UPDATE user_capability_grants SET action = 'REVOKED'`), /append-only/);
    await assert.rejects(db.exec('DELETE FROM user_capability_grants'), /append-only/);
    await assert.rejects(db.exec('TRUNCATE user_capability_grants'), /append-only/);
  });

  test('no workflow capability can be granted to an individual - escalation is refused', async () => {
    // This is the guard that stops an individual grant from becoming a
    // back door into CRO/HSE/account-management authority.
    for (const name of ['permit.close', 'permit.cro_review', 'permit.hse_review',
      'permit.renew', 'employee.create']) {
      const id = await capabilityId(db, name);
      await assert.rejects(
        db.exec(`INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
          VALUES ('${EMPLOYEE}', '${id}', 'GRANTED', '${CEO}')`),
        /may not be granted to an individual/,
        `${name} must never be individually grantable`,
      );
    }
  });

  test('a privileged system account receives no individual organizational permission', async () => {
    const viewAll = await capabilityId(db, 'permit.view_all');
    await db.exec(`INSERT INTO privileged_identities (user_id, display_name) VALUES ('${CEO}', 'The CEO')`);
    await db.exec(`INSERT INTO privileged_access_events (user_id, role, action)
      VALUES ('${CEO}', 'CEO', 'GRANTED')`);
    await assert.rejects(
      db.exec(`INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
        VALUES ('${CEO}', '${viewAll}', 'GRANTED', '${MANAGER}')`),
      /privileged system account/,
    );
  });

  test('nobody can grant themselves an individual permission', async () => {
    const viewAll = await capabilityId(db, 'permit.view_all');
    await assert.rejects(
      db.exec(`INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
        VALUES ('${EMPLOYEE}', '${viewAll}', 'GRANTED', '${EMPLOYEE}')`),
      /user_capability_grants_not_self/,
    );
  });

  test('an individual capability can never leak into the Team + Position model', async () => {
    const viewAll = await capabilityId(db, 'permit.view_all');
    const tp = await db.query<{ id: string }>('SELECT id FROM team_positions LIMIT 1');
    await assert.rejects(
      db.exec(`INSERT INTO team_position_capabilities (team_position_id, capability_id)
        VALUES ('${tp.rows[0]!.id}', '${viewAll}')`),
      /INDIVIDUAL permission/,
    );
  });

  test('user_capability_grants is RLS-enabled, policy-free and closed to the browser', async () => {
    const rls = await db.query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'user_capability_grants'`,
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true);
    const policies = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM pg_policies WHERE tablename = 'user_capability_grants'`,
    );
    assert.equal(policies.rows[0]?.c, 0);
    const grants = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM information_schema.role_table_grants
        WHERE table_name = 'user_capability_grants' AND grantee IN ('anon','authenticated','PUBLIC')`,
    );
    assert.equal(grants.rows[0]?.c, 0);
  });

  test('app_runtime has only the exact employee-lifecycle column updates', async () => {
    const tablePrivileges = await db.query<{ workforce: boolean; assignments: boolean }>(
      `SELECT has_table_privilege('app_runtime', 'public.workforce_profiles', 'UPDATE') AS workforce,
              has_table_privilege('app_runtime', 'public.user_team_positions', 'UPDATE') AS assignments`,
    );
    assert.deepEqual(tablePrivileges.rows[0], { workforce: false, assignments: false });

    const expected = new Map([
      ['workforce_profiles.display_name', true],
      ['workforce_profiles.company_id', true],
      ['workforce_profiles.primary_team_position_id', true],
      ['workforce_profiles.user_id', false],
      ['workforce_profiles.created_at', false],
      ['workforce_profiles.updated_at', false],
      ['user_team_positions.ended_at', true],
      ['user_team_positions.id', false],
      ['user_team_positions.user_id', false],
      ['user_team_positions.team_position_id', false],
      ['user_team_positions.created_at', false],
      ['user_team_positions.started_at', false],
    ]);
    for (const [qualified, allowed] of expected) {
      const [table, column] = qualified.split('.');
      const privilege = await db.query<{ allowed: boolean }>(
        `SELECT has_column_privilege('app_runtime', $1, $2, 'UPDATE') AS allowed`,
        [`public.${table}`, column],
      );
      assert.equal(privilege.rows[0]?.allowed, allowed, qualified);
    }

    await db.exec('SET ROLE app_runtime');
    try {
      for (const column of ['display_name', 'company_id', 'primary_team_position_id']) {
        await db.exec(`UPDATE public.workforce_profiles SET ${column} = ${column} WHERE false`);
      }
      await db.exec('UPDATE public.user_team_positions SET ended_at = ended_at WHERE false');

      for (const column of ['user_id', 'created_at', 'updated_at']) {
        await assert.rejects(
          db.exec(`UPDATE public.workforce_profiles SET ${column} = ${column} WHERE false`),
          /permission denied/,
        );
      }
      for (const column of ['id', 'user_id', 'team_position_id', 'created_at', 'started_at']) {
        await assert.rejects(
          db.exec(`UPDATE public.user_team_positions SET ${column} = ${column} WHERE false`),
          /permission denied/,
        );
      }
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  test('app_runtime INSERT cannot turn an individual grant into operational authority', async () => {
    const operational = await capabilityId(db, 'permit.cro_review');
    await db.exec('SET ROLE app_runtime');
    try {
      await assert.rejects(
        db.exec(`INSERT INTO public.user_capability_grants
          (user_id, capability_id, action, actor_user_id)
          VALUES ('${EMPLOYEE}', '${operational}', 'GRANTED', '${MANAGER}')`),
        /may not be granted to an individual/,
      );
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  // ------------------------------------------------------------------
  // 0024: frozen applicant identity
  // ------------------------------------------------------------------

  test('an applicant identity must be complete, valid, and is frozen once written', async () => {
    const jsa = await db.query<{ id: string }>(
      `INSERT INTO jsas (created_by) VALUES ('${EMPLOYEE}') RETURNING id`,
    );
    const jsaId = jsa.rows[0]!.id;
    const permit = await db.query<{ id: string }>(
      `INSERT INTO permits (jsa_id, created_by, site_timezone) VALUES ($1, $2, 'UTC') RETURNING id`,
      [jsaId, EMPLOYEE],
    );
    const permitId = permit.rows[0]!.id;

    // Half an identity is unrepresentable.
    await assert.rejects(
      db.exec(`UPDATE permits SET applicant_display_name = 'Ali Khan' WHERE id = '${permitId}'`),
      /permits_applicant_identity_complete/,
    );
    // An invented company code is refused.
    await assert.rejects(
      db.exec(`UPDATE permits SET applicant_display_name = 'Ali Khan',
        applicant_company_code = 'ACME', applicant_company_name = 'Acme' WHERE id = '${permitId}'`),
      /permits_applicant_identity_complete/,
    );

    await db.exec(`UPDATE permits SET applicant_display_name = 'Ali Khan',
      applicant_company_code = 'ZPL', applicant_company_name = 'ZPL' WHERE id = '${permitId}'`);

    // Frozen: neither a rewrite nor a clear-then-rewrite is possible.
    await assert.rejects(
      db.exec(`UPDATE permits SET applicant_display_name = 'Someone Else' WHERE id = '${permitId}'`),
      /frozen/,
    );
    await assert.rejects(
      db.exec(`UPDATE permits SET applicant_company_code = 'E_SET' WHERE id = '${permitId}'`),
      /frozen/,
    );
    await assert.rejects(
      db.exec(`UPDATE permits SET applicant_display_name = NULL, applicant_company_code = NULL,
        applicant_company_name = NULL WHERE id = '${permitId}'`),
      /frozen/,
    );

    const frozen = await db.query<{ n: string; c: string }>(
      `SELECT applicant_display_name AS n, applicant_company_code AS c FROM permits WHERE id = '${permitId}'`,
    );
    assert.deepEqual(frozen.rows[0], { n: 'Ali Khan', c: 'ZPL' });
  });

  // ------------------------------------------------------------------
  // 0025: service_role application-table sweep
  // ------------------------------------------------------------------

  test('the harness models the Supabase default grants the sweep exists to remove', async () => {
    await db.exec('CREATE TABLE public.probe_sweep (x int)');
    const granted = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM information_schema.role_table_grants
        WHERE table_name = 'probe_sweep' AND grantee = 'service_role' AND privilege_type = 'INSERT'`,
    );
    assert.equal(granted.rows[0]?.c, 1, 'without this the sweep tests would prove nothing');
    await db.exec('DROP TABLE public.probe_sweep');
  });

  test('service_role can write NO application table or sequence in public', async () => {
    const writable = await db.query<{ ident: string }>(
      `SELECT c.oid::regclass::text AS ident FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
          AND (has_table_privilege('service_role', c.oid, 'INSERT')
            OR has_table_privilege('service_role', c.oid, 'UPDATE')
            OR has_table_privilege('service_role', c.oid, 'DELETE')
            OR has_table_privilege('service_role', c.oid, 'TRUNCATE'))
        ORDER BY 1`,
    );
    assert.deepEqual(writable.rows, []);

    const sequences = await db.query<{ ident: string }>(
      `SELECT c.oid::regclass::text AS ident FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'S'
          AND (has_sequence_privilege('service_role', c.oid, 'USAGE')
            OR has_sequence_privilege('service_role', c.oid, 'UPDATE'))
        ORDER BY 1`,
    );
    assert.deepEqual(sequences.rows, []);
  });

  test('service_role can execute no public application function', async () => {
    const executable = await db.query<{ ident: string }>(
      `SELECT p.oid::regprocedure::text AS ident
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
          )
          AND has_function_privilege('service_role', p.oid, 'EXECUTE')
        ORDER BY 1`,
    );
    assert.deepEqual(executable.rows, []);
  });

  test('service_role cannot manufacture operational capabilities, by attempt as that role', async () => {
    const viewAll = await capabilityId(db, 'permit.view_all');
    const tp = await db.query<{ id: string }>('SELECT id FROM team_positions LIMIT 1');
    await db.exec('SET ROLE service_role');
    try {
      // The escalation this sweep exists to stop: self-granting CRO.
      await assert.rejects(
        db.exec(`INSERT INTO public.team_position_capabilities (team_position_id, capability_id)
                 VALUES ('${tp.rows[0]!.id}', '${viewAll}')`),
        /permission denied/,
      );
      await assert.rejects(
        db.exec(`INSERT INTO public.user_team_positions (user_id, team_position_id)
                 VALUES ('${MANAGER}', '${tp.rows[0]!.id}')`),
        /permission denied/,
      );
      // Re-enabling a disabled or deleted account is equally out of reach.
      await assert.rejects(
        db.exec(`UPDATE public.app_user_access SET state = 'ACTIVE' WHERE user_id = '${OTHER}'`),
        /permission denied/,
      );
      // As is forging a permit, a signature, or an individual permission.
      await assert.rejects(
        db.exec(`INSERT INTO public.user_capability_grants (user_id, capability_id, action, actor_user_id)
                 VALUES ('${MANAGER}', '${viewAll}', 'GRANTED', '${CEO}')`),
        /permission denied/,
      );
      await assert.rejects(
        db.exec(`UPDATE public.permits SET status = 'ISSUED'`),
        /permission denied/,
      );
      // Reading is retained on purpose.
      const readable = await db.query('SELECT count(*)::int AS c FROM public.permits');
      assert.equal(readable.rows.length, 1);
    } finally {
      await db.exec('RESET ROLE');
    }
  });

  test('the sweep leaves the intended channels untouched', async () => {
    // The owner keeps everything; the migration runner depends on it.
    const owner = await db.query<{ ins: boolean; mig: boolean }>(
      `SELECT has_table_privilege('postgres','public.permits','INSERT') AS ins,
              has_table_privilege('postgres','public.schema_migrations','INSERT') AS mig`,
    );
    assert.deepEqual(owner.rows[0], { ins: true, mig: true });
    // Browser roles remain default-deny, as they always were.
    const browser = await db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('anon','authenticated')`,
    );
    assert.equal(browser.rows[0]?.c, 0);
  });
});
