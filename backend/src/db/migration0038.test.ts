import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';

const migration0038Url = new URL(
  '../../../database/migrations/0038_organization_deactivation_runtime_privilege.sql',
  import.meta.url,
);

const COMPANY_ID = '10000000-0000-4000-8000-000000000001';
const TEAM_ID = '20000000-0000-4000-8000-000000000001';
const TEAM_POSITION_ID = '30000000-0000-4000-8000-000000000001';

async function withProductionLikeRuntimeSurface(): Promise<PGlite> {
  const db = new PGlite();

  await db.exec(`
    CREATE ROLE app_runtime;

    CREATE TABLE public.capabilities (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE public.companies (
      id UUID PRIMARY KEY,
      deactivated_at TIMESTAMPTZ
    );

    CREATE TABLE public.teams (
      id UUID PRIMARY KEY,
      company_id UUID NOT NULL REFERENCES public.companies(id),
      deactivated_at TIMESTAMPTZ
    );

    CREATE TABLE public.team_positions (
      id UUID PRIMARY KEY,
      team_id UUID NOT NULL REFERENCES public.teams(id),
      deactivated_at TIMESTAMPTZ
    );

    CREATE TABLE public.team_position_capabilities (
      team_position_id UUID NOT NULL REFERENCES public.team_positions(id),
      capability_id UUID NOT NULL REFERENCES public.capabilities(id)
    );

    CREATE TABLE public.workforce_profiles (
      user_id UUID PRIMARY KEY,
      primary_team_position_id UUID REFERENCES public.team_positions(id)
    );

    CREATE TABLE public.app_user_access (
      user_id UUID PRIMARY KEY,
      state TEXT NOT NULL
    );

    CREATE FUNCTION public.organization_required_coverage_gap(
      p_company_id UUID,
      p_team_id UUID,
      p_team_position_id UUID
    ) RETURNS TEXT
    LANGUAGE sql
    STABLE
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
      SELECT required.name
        FROM (VALUES
          ('permit.cro_review', 1),
          ('permit.hse_review', 1)
        ) AS required (name, minimum)
        JOIN public.capabilities cap
          ON cap.name = required.name
        JOIN public.team_position_capabilities tpc
          ON tpc.capability_id = cap.id
        JOIN public.team_positions tp
          ON tp.id = tpc.team_position_id
        JOIN public.teams t
          ON t.id = tp.team_id
        JOIN public.companies c
          ON c.id = t.company_id
       WHERE tp.deactivated_at IS NULL
         AND t.deactivated_at IS NULL
         AND c.deactivated_at IS NULL
       GROUP BY required.name, required.minimum
      HAVING count(*) FILTER (
               WHERE NOT (
                 (p_company_id IS NOT NULL AND c.id = p_company_id)
                 OR (p_team_id IS NOT NULL AND t.id = p_team_id)
                 OR (
                   p_team_position_id IS NOT NULL
                   AND tp.id = p_team_position_id
                 )
               )
             ) < LEAST(required.minimum, count(*))
       ORDER BY required.name
       LIMIT 1;
    $fn$;

    REVOKE ALL
      ON FUNCTION public.organization_required_coverage_gap(UUID, UUID, UUID)
      FROM PUBLIC;

    CREATE FUNCTION public.team_positions_guard_deactivation()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = pg_catalog
    AS $fn$
    DECLARE
      dependents BIGINT;
      gap TEXT;
    BEGIN
      IF OLD.deactivated_at IS NOT NULL OR NEW.deactivated_at IS NULL THEN
        RETURN NEW;
      END IF;

      SELECT count(*)
        INTO dependents
        FROM public.workforce_profiles wp
        JOIN public.app_user_access a
          ON a.user_id = wp.user_id
       WHERE wp.primary_team_position_id = NEW.id
         AND a.state = 'ACTIVE';

      IF dependents <> 0 THEN
        RAISE EXCEPTION
          'team position % still has % active employee(s)',
          NEW.id,
          dependents;
      END IF;

      gap := public.organization_required_coverage_gap(
        NULL,
        NULL,
        NEW.id
      );

      IF gap IS NOT NULL THEN
        RAISE EXCEPTION
          'deactivating team position % would leave required capability % below its required coverage',
          NEW.id,
          gap;
      END IF;

      RETURN NEW;
    END;
    $fn$;

    CREATE TRIGGER team_positions_guard_deactivation_trigger
      BEFORE UPDATE ON public.team_positions
      FOR EACH ROW
      EXECUTE FUNCTION public.team_positions_guard_deactivation();

    INSERT INTO public.companies (id)
    VALUES ('${COMPANY_ID}');

    INSERT INTO public.teams (id, company_id)
    VALUES ('${TEAM_ID}', '${COMPANY_ID}');

    INSERT INTO public.team_positions (id, team_id)
    VALUES ('${TEAM_POSITION_ID}', '${TEAM_ID}');

    -- Model the effective production read surface that was verified
    -- before this migration was written.
    GRANT SELECT ON
      public.workforce_profiles,
      public.app_user_access,
      public.capabilities,
      public.team_position_capabilities,
      public.team_positions,
      public.teams,
      public.companies
    TO app_runtime;

    -- 0037 already grants this lifecycle write.
    GRANT UPDATE (deactivated_at)
      ON public.team_positions
      TO app_runtime;
  `);

  return db;
}

async function asAppRuntime<T>(
  db: PGlite,
  work: () => Promise<T>,
): Promise<T> {
  await db.exec('SET ROLE app_runtime');
  try {
    return await work();
  } finally {
    await db.exec('RESET ROLE');
  }
}

test('0037-era runtime surface reproduces the production deactivation failure', async () => {
  const db = await withProductionLikeRuntimeSurface();

  const privilege = await db.query<{ allowed: boolean }>(`
    SELECT has_function_privilege(
      'app_runtime',
      'public.organization_required_coverage_gap(uuid,uuid,uuid)',
      'EXECUTE'
    ) AS allowed
  `);

  assert.equal(privilege.rows[0]?.allowed, false);

  await assert.rejects(
    asAppRuntime(db, () =>
      db.exec(`
        UPDATE public.team_positions
           SET deactivated_at = now()
         WHERE id = '${TEAM_POSITION_ID}'
      `),
    ),
    /permission denied for function organization_required_coverage_gap/i,
  );

  const state = await db.query<{ deactivated_at: Date | null }>(`
    SELECT deactivated_at
      FROM public.team_positions
     WHERE id = '${TEAM_POSITION_ID}'
  `);

  assert.equal(
    state.rows[0]?.deactivated_at,
    null,
    'the failed deactivation must roll back',
  );
});

test('0038 grants only the missing helper execution and deactivation then succeeds', async () => {
  const db = await withProductionLikeRuntimeSurface();

  await db.exec(await readFile(migration0038Url, 'utf8'));

  const privilege = await db.query<{ allowed: boolean }>(`
    SELECT has_function_privilege(
      'app_runtime',
      'public.organization_required_coverage_gap(uuid,uuid,uuid)',
      'EXECUTE'
    ) AS allowed
  `);

  assert.equal(privilege.rows[0]?.allowed, true);

  await asAppRuntime(db, () =>
    db.exec(`
      UPDATE public.team_positions
         SET deactivated_at = now()
       WHERE id = '${TEAM_POSITION_ID}'
    `),
  );

  const state = await db.query<{ deactivated: boolean }>(`
    SELECT deactivated_at IS NOT NULL AS deactivated
      FROM public.team_positions
     WHERE id = '${TEAM_POSITION_ID}'
  `);

  assert.equal(state.rows[0]?.deactivated, true);
});

test('0038 is idempotent', async () => {
  const db = await withProductionLikeRuntimeSurface();
  const sql = await readFile(migration0038Url, 'utf8');

  await db.exec(sql);
  await db.exec(sql);

  const privilege = await db.query<{ allowed: boolean }>(`
    SELECT has_function_privilege(
      'app_runtime',
      'public.organization_required_coverage_gap(uuid,uuid,uuid)',
      'EXECUTE'
    ) AS allowed
  `);

  assert.equal(privilege.rows[0]?.allowed, true);
});

test('0038 safely skips databases without app_runtime', async () => {
  const db = new PGlite();

  await db.exec(await readFile(migration0038Url, 'utf8'));
});
