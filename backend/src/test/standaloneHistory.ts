import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import {
  cancelPermit,
  closePermit,
  createDraftPermit,
  forwardToHseReview,
  holdPermit,
  hseApprove,
  renewPermit,
  submitPermit,
  updateDraftPermit,
  updateLinkedJsa,
  type PermitsServiceDeps,
} from '../domain/permits/service.js';
import { answeredJsaV2, answeredWtgPermitV2 } from './v2Forms.js';

/**
 * A SYNTHETIC standalone Permit database history, produced by the real
 * services on a 0001-0038 replay (`public` + Supabase `auth.users`), for the
 * data-migration tests and the real-PostgreSQL rehearsal. It touches every
 * one of the 20 former auth.users relationships. No real person, email or
 * password: every identity is @example.test and every password is FAKE.
 *
 * `FixtureDb` is satisfied by PGlite and by a single pg client alike.
 */
export interface FixtureDb {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (sql: string) => Promise<unknown>;
}

export const FAKE_PASSWORD = 'FAKE-standalone-password-1';

export const PEOPLE = {
  ceo: { id: '52000000-0000-4000-8000-00000000000c', email: 'CEO.Person@Example.TEST', team: 'Management', position: 'CEO', name: 'Chief Executive' },
  applicant: { id: '52000000-0000-4000-8000-000000000001', email: 'applicant@example.test', team: 'WTG', position: 'Technician', name: 'Applicant One' },
  cro: { id: '52000000-0000-4000-8000-000000000002', email: ' cro@example.test ', team: 'E-BOP', position: 'CRO', name: 'Control Room' },
  hse: { id: '52000000-0000-4000-8000-000000000003', email: 'hse@example.test', team: 'HSE', position: 'Team Lead', name: 'Safety Lead' },
  siteManager: { id: '52000000-0000-4000-8000-000000000004', email: 'site.manager@example.test', team: null, position: null, name: 'Site Manager' },
} as const;

export function serviceDeps(db: FixtureDb): PermitsServiceDeps {
  return {
    query: ((text: string, params?: unknown[]) => db.query(text, params)) as PermitsServiceDeps['query'],
    withTransaction: (async <T>(work: (client: PoolClient) => Promise<T>) => {
      await db.exec('BEGIN');
      try {
        const result = await work({ query: (text: string, params?: unknown[]) => db.query(text, params) } as unknown as PoolClient);
        await db.exec('COMMIT');
        return result;
      } catch (error) {
        await db.exec('ROLLBACK');
        throw error;
      }
    }) as PermitsServiceDeps['withTransaction'],
  };
}

type Versioned = { permit: { version: number } };
const v = (result: unknown) => (result as Versioned).permit.version;
function ok(result: { outcome: string }, step: string): void {
  if (result.outcome !== 'ok') throw new Error(`fixture step ${step} failed: ${JSON.stringify(result)}`);
}

/** Supabase's own auth.users columns that the import reads, on top of the emulation's id/email. */
async function authUsers(db: FixtureDb): Promise<void> {
  await db.exec(`ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS encrypted_password varchar(255),
    ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now()`);
  const hashes = [await bcrypt.hash(FAKE_PASSWORD, 10), (await bcrypt.hash(FAKE_PASSWORD, 4)).replace(/^\$2b\$/, '$2a$')];
  let i = 0;
  for (const person of Object.values(PEOPLE)) {
    await db.query(`INSERT INTO auth.users (id, email, encrypted_password, created_at)
      VALUES ($1, $2, $3, '2024-01-0${1 + i}T08:00:00Z')`, [person.id, person.email, hashes[i % 2]]);
    i += 1;
  }
}

async function assign(db: FixtureDb, person: { id: string; team: string | null; position: string | null; name: string }): Promise<void> {
  await db.query(`INSERT INTO app_user_access (user_id, state) VALUES ($1, 'ACTIVE')`, [person.id]);
  if (!person.team) return;
  await db.query(`
    INSERT INTO user_team_positions (user_id, team_position_id)
    SELECT $1, tp.id FROM team_positions tp JOIN teams t ON t.id = tp.team_id
      JOIN companies c ON c.id = t.company_id JOIN positions p ON p.id = tp.position_id
     WHERE c.code = 'E_SET' AND t.name = $2 AND p.name = $3`, [person.id, person.team, person.position]);
  await db.query(`
    INSERT INTO workforce_profiles (user_id, display_name, primary_team_position_id, company_id)
    SELECT $1, $2, utp.team_position_id, t.company_id FROM user_team_positions utp
      JOIN team_positions tp ON tp.id = utp.team_position_id JOIN teams t ON t.id = tp.team_id
     WHERE utp.user_id = $1`, [person.id, person.name]);
}

async function issue(d: PermitsServiceDeps): Promise<{ id: string; version: number }> {
  const { permit } = await createDraftPermit(PEOPLE.applicant.id, 'Asia/Karachi', 'WTG_WORK', d);
  const drafted = await updateDraftPermit(PEOPLE.applicant.id, permit.id, { expectedVersion: permit.version, form: answeredWtgPermitV2() }, d);
  ok(drafted, 'draft');
  const jsa = await updateLinkedJsa(PEOPLE.applicant.id, permit.id, { expectedVersion: v(drafted), form: answeredJsaV2() }, d);
  ok(jsa, 'jsa');
  const submitted = await submitPermit(PEOPLE.applicant.id, permit.id, { expectedVersion: v(jsa) }, d);
  ok(submitted, 'submit');
  const forwarded = await forwardToHseReview(PEOPLE.cro.id, permit.id, { expectedVersion: v(submitted) }, d);
  ok(forwarded, 'forward');
  const approved = await hseApprove(PEOPLE.hse.id, permit.id, { expectedVersion: v(forwarded) }, d);
  ok(approved, 'approve');
  return { id: permit.id, version: v(approved) };
}

/**
 * The standalone history: identities with bcrypt hashes, access and
 * workforce profiles, CEO and Site Manager privileged identities and their
 * append-only grant log, a capability grant, account and organization
 * audit, the CEO bootstrap record, and permits that are issued, closed and
 * renewed, held, and cancelled (lifecycle events, signatures, immutable
 * issued snapshots, document jobs, notifications).
 */
export async function produceStandaloneHistory(db: FixtureDb): Promise<void> {
  // The current issuance code reads the Permit CMS branding. A standalone
  // database has no CMS, so give it exactly a fresh CMS's state, in the
  // schema the code reads. Not part of the copied history (only `public` is).
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS permit;
    CREATE TABLE permit.cms_settings (singleton boolean PRIMARY KEY, organization_name text NOT NULL);
    INSERT INTO permit.cms_settings VALUES (true, 'E-Set Engineering Services');
    CREATE TABLE permit.file_registry (id uuid PRIMARY KEY, sha256 text NOT NULL, state text NOT NULL);
    CREATE TABLE permit.cms_logo_assets (file_id uuid, display_label text, purpose text, active boolean,
      display_order int, applicable_document_types text[]);
  `);
  await db.exec('SET search_path = public, pg_catalog');
  await authUsers(db);
  for (const person of Object.values(PEOPLE)) await assign(db, person);

  // Privileged identities and their grant log; CEO bootstrap completed.
  await db.query(`INSERT INTO privileged_identities (user_id, display_name) VALUES ($1, 'Chief Executive'), ($2, 'Site Manager')`,
    [PEOPLE.ceo.id, PEOPLE.siteManager.id]);
  await db.query(`INSERT INTO privileged_access_events (user_id, role, action, actor_user_id, reason)
    VALUES ($1, 'CEO', 'GRANTED', NULL, 'initial bootstrap'), ($2, 'SITE_MANAGER', 'GRANTED', $1, 'appointed')`,
    [PEOPLE.ceo.id, PEOPLE.siteManager.id]);
  await db.query(`INSERT INTO initial_ceo_bootstrap (email, auth_user_id, status, completed_at)
    VALUES ('ceo.person@example.test', $1, 'COMPLETED', '2024-01-01T09:00:00Z')`, [PEOPLE.ceo.id]);
  await db.query(`INSERT INTO user_capability_grants (user_id, capability_id, action, actor_user_id)
    SELECT $1, id, 'GRANTED', $2 FROM capabilities WHERE individually_grantable ORDER BY name LIMIT 1`, [PEOPLE.hse.id, PEOPLE.ceo.id]);
  await db.query(`INSERT INTO account_audit_events (event_type, target_user_id, actor_user_id)
    VALUES ('EMPLOYEE_ACCOUNT_CREATED', $1, $2)`, [PEOPLE.applicant.id, PEOPLE.ceo.id]);
  await db.query(`INSERT INTO organization_audit_events (event_type, actor_user_id, team_id)
    SELECT 'TEAM_CREATED', $1, id FROM teams ORDER BY name LIMIT 1`, [PEOPLE.ceo.id]);

  const d = serviceDeps(db);
  const closed = await issue(d);
  const closeResult = await closePermit(PEOPLE.cro.id, closed.id, { expectedVersion: closed.version, closureRemarks: 'Done' }, d);
  ok(closeResult, 'close');
  // Age the closed permit past its validity (every timestamp together), so it can be renewed.
  await db.exec(`
    ALTER TABLE permits DISABLE TRIGGER USER;
    DO $age$ DECLARE cols text; BEGIN
      SELECT string_agg(format('%I = %I - interval ''2 days''', attname, attname), ', ') INTO cols
        FROM pg_attribute WHERE attrelid = 'public.permits'::regclass AND attnum > 0 AND NOT attisdropped
         AND atttypid = 'timestamptz'::regtype;
      EXECUTE format('UPDATE permits SET %s WHERE id = %L', cols, '${closed.id}');
    END $age$;
    ALTER TABLE permits ENABLE TRIGGER USER;`);
  ok(await renewPermit(PEOPLE.cro.id, closed.id, d), 'renew');

  const held = await issue(d);
  ok(await holdPermit(PEOPLE.cro.id, held.id, { expectedVersion: held.version, reason: 'Weather' }, d), 'hold');
  const cancelled = await issue(d);
  ok(await cancelPermit(PEOPLE.cro.id, cancelled.id, { expectedVersion: cancelled.version, reason: 'Scope changed' }, d), 'cancel');
  await db.exec('SET search_path = pg_catalog');
}

/**
 * The standalone worker's end state for every document job: GENERATED at
 * its legacy Supabase Storage key (`permits/<permit>/<snapshot>.pdf`) with a
 * pinned hash. Returns the legacy bucket's synthetic objects (not real PDFs
 * of the permits; the storage migration only moves and verifies bytes).
 */
export async function markLegacyDocumentsGenerated(db: FixtureDb): Promise<Map<string, Buffer>> {
  const { createHash } = await import('node:crypto');
  const jobs = (await db.query(`SELECT j.id, s.permit_id, s.id AS snapshot_id FROM public.permit_document_jobs j
    JOIN public.issued_document_snapshots s ON s.id = j.snapshot_id ORDER BY j.id`)).rows as
    { id: string; permit_id: string; snapshot_id: string }[];
  const objects = new Map<string, Buffer>();
  await db.exec('ALTER TABLE public.permit_document_jobs DISABLE TRIGGER USER');
  for (const job of jobs) {
    const key = `permits/${job.permit_id}/${job.snapshot_id}.pdf`;
    const bytes = Buffer.from(`%PDF-1.7\n% synthetic legacy document ${job.id}\n%%EOF\n`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    objects.set(key, bytes);
    await db.query(`UPDATE public.permit_document_jobs SET status = 'GENERATED', storage_path = $2, file_hash = $3,
      generated_at = '2025-06-01T10:00:00Z', renderer_version = 'PDFKIT_V3', expected_file_hash = $3,
      claim_token = NULL, claimed_at = NULL WHERE id = $1`, [job.id, key, hash]);
  }
  await db.exec('ALTER TABLE public.permit_document_jobs ENABLE TRIGGER USER');
  return objects;
}
