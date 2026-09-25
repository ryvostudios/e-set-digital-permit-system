import { importLegacyUsers, planLegacyUserImport, type LegacyAuthUser, type LegacyImportProblem } from '../domain/auth/legacyImport.js';
import { MIGRATION_LOCK_KEY, PLATFORM_MIGRATION_LOCK_KEY } from './migrate.js';
import type { QueryFn } from './pool.js';

/**
 * STANDALONE -> SHARED PERMIT DATA IMPORT (docs/SHARED_DATABASE.md,
 * "Moving existing data"). Operator-run through
 * `npm run data:import-standalone`; never runs by itself.
 *
 * Source: the standalone Permit database (`public` 0001-0038 plus Supabase
 * `auth.users`), read in ONE read-only repeatable-read snapshot.
 * Target: the shared database's `permit` schema, fully migrated with
 * `npm run migrate -- --baseline-without-reference-data`, connected as
 * permit_migrator (the schema owner). The Permit migration advisory lock is
 * held for the whole transaction.
 *
 *   1. Preflight: target migrated, no Permit history or identity present
 *      (a second import into a populated target is refused - use verify).
 *   2. Identities: auth.users -> permit.users through the legacy import
 *      contract (UUID kept, email normalized, only supported bcrypt, fail
 *      closed). Every value of the 20 former auth.users references must
 *      name an imported identity.
 *   3. Copy every standalone table, parents first, with USER triggers
 *      disabled (they stamp new rows and would rewrite history), foreign
 *      keys enforced; sequences set to their standalone positions;
 *      triggers re-enabled.
 *   4. Verify inside the same transaction: per-table row count and digest
 *      over every column, identity set, the 20 relationships, sequences.
 *      Only then commit (execute). A dry run always rolls back; verify
 *      mode only reads.
 *
 * The report holds table names, counts, digests, permit/JSA number
 * ranges, user ids for problems and hash-format prefix counts. Never an
 * email, a hash, a name or a document.
 */

export type ImportMode = 'dry-run' | 'execute' | 'verify';

export interface ImportReport {
  mode: ImportMode;
  problems: string[];
  identityProblems: LegacyImportProblem[];
  hashPrefixCounts: Record<string, number>;
  tables: Record<string, { source: number; target: number; match: boolean }>;
  users: { source: number; target: number; match: boolean };
  identityReferences: Record<string, number>;
  sequences: { compared: number; match: boolean };
  samples: Record<string, string | null>;
  /** Target rows present before the import (migration seeds after 0038). */
  preexisting: Record<string, number>;
  committed: boolean;
}

const EXCLUDED = new Set(['schema_migrations', 'users', 'user_sessions']);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A row filter by id list, for ids that are plain identifiers (uuids, integers). */
function idFilter(ids: string[]): string {
  if (!ids.every((id) => /^[0-9A-Za-z-]+$/.test(id))) throw new Error('unexpected id format in a preexisting-row filter');
  return `WHERE t.id::text = ANY('{${ids.join(',')}}'::text[])`;
}

async function list<T extends Record<string, unknown>>(q: QueryFn, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await q<T>(sql, params)).rows;
}

async function tables(q: QueryFn, schema: string): Promise<string[]> {
  return (await list<{ relname: string }>(q,
    `SELECT relname FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind IN ('r', 'p') ORDER BY 1`, [schema]))
    .map((row) => row.relname);
}

async function columns(q: QueryFn, schema: string, table: string): Promise<string[]> {
  return (await list<{ attname: string }>(q,
    `SELECT attname FROM pg_attribute WHERE attrelid = format('%I.%I', $1::text, $2::text)::regclass
        AND attnum > 0 AND NOT attisdropped ORDER BY attnum`, [schema, table])).map((row) => row.attname);
}

/** Parents before children (foreign keys among the copied tables). */
async function dependencyOrder(target: QueryFn, copied: string[]): Promise<string[]> {
  const edges = await list<{ child: string; parent: string }>(target, `
    SELECT c.relname AS child, p.relname AS parent FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
     WHERE k.contype = 'f' AND c.relnamespace = 'permit'::regnamespace
       AND p.relnamespace = 'permit'::regnamespace AND c.oid <> p.oid`);
  const ordered: string[] = [];
  while (ordered.length < copied.length) {
    const ready = copied.filter((t) => !ordered.includes(t) &&
      edges.every((e) => e.child !== t || ordered.includes(e.parent) || !copied.includes(e.parent)));
    if (ready.length === 0) throw new Error('foreign keys between permit tables are cyclic');
    ordered.push(...ready);
  }
  return ordered;
}

/** Self-referencing tables (renewals) are copied oldest first. */
async function copyOrder(source: QueryFn, table: string, cols: string[]): Promise<string> {
  const selfRef = await list(source, `SELECT 1 FROM pg_constraint WHERE contype = 'f'
    AND conrelid = format('public.%I', $1::text)::regclass AND confrelid = conrelid`, [table]);
  if (selfRef.length > 0 && cols.includes('created_at') && cols.includes('id')) return 't.created_at, t.id';
  return 't::text';
}

/** Order-independent digest of the given columns, timestamps rendered in UTC. */
async function digest(q: QueryFn, schema: string, table: string, cols: string[], filter = ''): Promise<{ count: number; md5: string }> {
  const row = (await q<{ count: number; md5: string }>(`
    SELECT count(*)::int AS count, md5(coalesce(string_agg(x, E'\\n' ORDER BY x), '')) AS md5
      FROM (SELECT json_build_array(${cols.map((c) => `t.${quote(c)}`).join(', ')})::text AS x
              FROM ${quote(schema)}.${quote(table)} t ${filter}) s`)).rows[0]!;
  return row;
}

async function sequenceStates(q: QueryFn, schema: string): Promise<Record<string, string>> {
  const names = (await list<{ relname: string }>(q,
    `SELECT relname FROM pg_class WHERE relnamespace = $1::regnamespace AND relkind = 'S' ORDER BY 1`, [schema]))
    .map((r) => r.relname).filter((name) => name !== 'schema_migrations_id_seq');
  const states: Record<string, string> = {};
  for (const name of names) {
    const row = (await q<{ last_value: string; is_called: boolean }>(
      `SELECT last_value::text, is_called FROM ${quote(schema)}.${quote(name)}`)).rows[0]!;
    states[name] = `${row.last_value}/${row.is_called}`;
  }
  return states;
}

async function identityReferenceColumns(target: QueryFn, copied: string[]): Promise<{ table: string; column: string }[]> {
  return (await list<{ table: string; column: string }>(target, `
    SELECT c.relname AS table, a.attname AS column FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
     WHERE k.contype = 'f' AND k.confrelid = 'permit.users'::regclass AND cardinality(k.conkey) = 1
     ORDER BY 1, 2`)).filter((row) => copied.includes(row.table));
}

export async function importStandalone(
  deps: { source: QueryFn; target: QueryFn },
  options: { mode: ImportMode; allowAccountsWithoutPassword?: boolean },
): Promise<{ ok: boolean; report: ImportReport }> {
  const { source, target } = deps;
  const report: ImportReport = {
    mode: options.mode, problems: [], identityProblems: [], hashPrefixCounts: {}, tables: {},
    users: { source: 0, target: 0, match: false }, identityReferences: {}, sequences: { compared: 0, match: false },
    samples: {}, preexisting: {}, committed: false,
  };

  await source('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await target(options.mode === 'verify' ? 'BEGIN READ ONLY' : 'BEGIN');
  try {
    for (const q of [source, target]) await q("SET LOCAL TIME ZONE 'UTC'");
    const platform = await target<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1) AS acquired', [PLATFORM_MIGRATION_LOCK_KEY]);
    if (!platform.rows[0]?.acquired) throw new Error('another E-Set platform migration or release holds the platform lock');
    await target('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

    // ---- preflight
    const owner = (await target<{ ok: boolean }>(`SELECT pg_get_userbyid(nspowner) = current_user AS ok
      FROM pg_namespace WHERE nspname = 'permit'`)).rows[0];
    if (!owner?.ok) throw new Error('connect as permit_migrator, the owner of schema permit');
    if (!(await target<{ ok: boolean }>(`SELECT to_regclass('permit.users') IS NOT NULL AS ok`)).rows[0]!.ok) {
      throw new Error('the target is not migrated through 0039 (permit.users is missing)');
    }
    const sourceTables = (await tables(source, 'public')).filter((t) => !EXCLUDED.has(t));
    const targetTables = await tables(target, 'permit');
    for (const t of sourceTables.filter((t) => !targetTables.includes(t))) {
      report.problems.push(`source table public.${t} has no permit table`);
    }
    const copied = await dependencyOrder(target, sourceTables.filter((t) => targetTables.includes(t)));
    const columnsByTable: Record<string, string[]> = {};
    for (const t of copied) {
      const [s, d] = [await columns(source, 'public', t), await columns(target, 'permit', t)];
      for (const c of s.filter((c) => !d.includes(c))) report.problems.push(`source column ${t}.${c} has no target column`);
      columnsByTable[t] = s.filter((c) => d.includes(c));
    }

    // Rows the target already had that are not history (e.g. 0041's CMS
    // capability). In verify mode, rows whose id is absent from the source.
    const sourceIds = async (t: string) => (await list<{ id: string }>(source, `SELECT id::text FROM public.${quote(t)}`)).map((r) => r.id);
    const exclusion: Record<string, string> = {};
    for (const t of copied) {
      const count = (await target<{ n: number }>(`SELECT count(*)::int AS n FROM permit.${quote(t)}`)).rows[0]!.n;
      if (count === 0) continue;
      if (options.mode === 'verify') {
        if (columnsByTable[t]!.includes('id')) {
          const ids = await sourceIds(t);
          const extra = (await target<{ n: number }>(`SELECT count(*)::int AS n FROM permit.${quote(t)} WHERE id::text <> ALL($1::text[])`, [ids])).rows[0]!.n;
          if (extra > 0) { report.preexisting[t] = extra; exclusion[t] = idFilter(ids); }
        }
        continue;
      }
      if (t === 'capabilities') {
        const ids = await sourceIds(t);
        const clash = (await target<{ n: number }>(`SELECT count(*)::int AS n FROM permit.capabilities WHERE id::text = ANY($1::text[])
          OR name IN (SELECT unnest($2::text[]))`, [ids, (await list<{ name: string }>(source, 'SELECT name FROM public.capabilities')).map((r) => r.name)])).rows[0]!.n;
        if (clash === 0) { report.preexisting[t] = count; exclusion[t] = idFilter(ids); continue; }
      }
      report.problems.push(`target permit.${t} already holds ${count} row(s): install with --baseline-without-reference-data into an empty schema, or use --verify`);
    }
    const existingUsers = (await target<{ n: number }>('SELECT count(*)::int AS n FROM permit.users')).rows[0]!.n;
    if (existingUsers > 0 && options.mode !== 'verify') report.problems.push(`target permit.users already holds ${existingUsers} identities`);

    // ---- identities
    const authUsers = await list<{ id: string; email: string | null; encrypted_password: string | null; created_at: string }>(source,
      'SELECT id::text, email, encrypted_password, created_at::text FROM auth.users ORDER BY id');
    const plan = planLegacyUserImport(authUsers.map((u): LegacyAuthUser => ({
      id: u.id, email: u.email, encryptedPassword: u.encrypted_password, createdAt: u.created_at,
    })), { allowAccountsWithoutPassword: options.allowAccountsWithoutPassword === true });
    report.hashPrefixCounts = plan.hashPrefixCounts;
    if (!plan.ok) report.identityProblems = plan.problems;
    const known = new Set(authUsers.map((u) => u.id.toLowerCase()));
    const references = await identityReferenceColumns(target, copied);
    for (const { table, column } of references) {
      const ids = (await list<{ id: string }>(source,
        `SELECT DISTINCT ${quote(column)}::text AS id FROM public.${quote(table)} WHERE ${quote(column)} IS NOT NULL`)).map((r) => r.id);
      for (const id of ids.filter((id) => !known.has(id))) {
        report.identityProblems.push({ kind: 'missing_identity', userId: id });
      }
      report.identityReferences[`${table}.${column}`] = ids.length;
    }
    if (report.problems.length > 0 || report.identityProblems.length > 0 || !plan.ok) {
      await target('ROLLBACK');
      return { ok: false, report };
    }

    // ---- copy
    if (options.mode !== 'verify') {
      await importLegacyUsers(target, plan);
      for (const t of copied) await target(`ALTER TABLE permit.${quote(t)} DISABLE TRIGGER USER`);
      for (const t of copied) {
        const cols = columnsByTable[t]!;
        const list_ = cols.map(quote).join(', ');
        const order = await copyOrder(source, t, cols);
        const rows = (await source<{ rows: unknown[] | null }>(
          `SELECT json_agg(t ORDER BY ${order}) AS rows FROM public.${quote(t)} t`)).rows[0]!.rows ?? [];
        // ponytail: one table's rows are held in memory at a time; stream by keyset if a table outgrows that.
        for (let i = 0; i < rows.length; i += 500) {
          await target(`INSERT INTO permit.${quote(t)} (${list_})
            SELECT ${list_} FROM json_populate_recordset(NULL::permit.${quote(t)}, $1::json)`, [JSON.stringify(rows.slice(i, i + 500))]);
        }
      }
      const states = await sequenceStates(source, 'public');
      for (const [name, state] of Object.entries(states)) {
        const [value, called] = state.split('/');
        const exists = (await target<{ ok: boolean }>('SELECT to_regclass($1) IS NOT NULL AS ok', [`permit.${quote(name)}`])).rows[0]!.ok;
        if (!exists) { report.problems.push(`source sequence ${name} has no permit sequence`); continue; }
        await target('SELECT setval($1::regclass, $2::bigint, $3::boolean)', [`permit.${quote(name)}`, value, called === 'true']);
      }
      for (const t of copied) await target(`ALTER TABLE permit.${quote(t)} ENABLE TRIGGER USER`);
    }

    // ---- verify
    for (const t of copied) {
      const cols = columnsByTable[t]!;
      const [s, d] = [await digest(source, 'public', t, cols), await digest(target, 'permit', t, cols, exclusion[t])];
      report.tables[t] = { source: s.count, target: d.count, match: s.count === d.count && s.md5 === d.md5 };
      if (!report.tables[t]!.match) report.problems.push(`table ${t} differs`);
    }
    const planned = plan.ok ? plan.users : [];
    const identityDigest = async (rows: { id: string; email: string; password_hash: string | null }[]) =>
      rows.map((u) => `${u.id}|${u.email}|${u.password_hash ?? ''}`).sort().join('\n');
    const targetUsers = await list<{ id: string; email: string; password_hash: string | null }>(target,
      `SELECT id::text, email, CASE WHEN password_scheme = 'bcrypt_legacy' THEN password_hash END AS password_hash
         FROM permit.users WHERE id::text = ANY($1::text[])`, [planned.map((u) => u.id)]);
    const allTargetUsers = (await target<{ n: number }>('SELECT count(*)::int AS n FROM permit.users')).rows[0]!.n;
    // After an upgrade-on-login (verify mode, later), a hash is Argon2id: compare ids and emails only then.
    const upgraded = targetUsers.filter((u) => u.password_hash === null).map((u) => u.id);
    report.users = {
      source: planned.length, target: allTargetUsers,
      match: allTargetUsers === planned.length && await identityDigest(targetUsers) ===
        await identityDigest(planned.map((u) => ({ id: u.id, email: u.email, password_hash: upgraded.includes(u.id) ? null : u.passwordHash }))),
    };
    if (!report.users.match) report.problems.push('imported identities differ from the source');
    for (const { table, column } of references) {
      const dangling = (await target<{ n: number }>(`SELECT count(*)::int AS n FROM permit.${quote(table)} t
        WHERE t.${quote(column)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM permit.users u WHERE u.id = t.${quote(column)})`)).rows[0]!.n;
      if (dangling > 0) report.problems.push(`${table}.${column}: ${dangling} unresolved identity reference(s)`);
    }
    const [ss, ts] = [await sequenceStates(source, 'public'), await sequenceStates(target, 'permit')];
    report.sequences = { compared: Object.keys(ss).length, match: Object.entries(ss).every(([n, v]) => ts[n] === v) };
    if (!report.sequences.match) report.problems.push('sequence positions differ');
    for (const [label, sql] of [
      ['permitSequences', `SELECT string_agg(permit_type || ' ' || lo || '..' || hi, ', ' ORDER BY permit_type) AS v FROM (
        SELECT permit_type, min(permit_sequence) AS lo, max(permit_sequence) AS hi FROM permit.permits
         WHERE permit_sequence IS NOT NULL GROUP BY permit_type) s`],
      ['jsaSequences', `SELECT min(jsa_sequence) || '..' || max(jsa_sequence) AS v FROM permit.jsas`],
    ] as const) {
      report.samples[label] = (await target<{ v: string | null }>(sql)).rows[0]?.v ?? null;
    }

    const ok = report.problems.length === 0;
    if (options.mode === 'execute' && ok) {
      await target('COMMIT');
      report.committed = true;
    } else {
      await target('ROLLBACK');
    }
    return { ok, report };
  } catch (error) {
    await target('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await source('ROLLBACK').catch(() => undefined);
  }
}
