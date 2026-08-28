import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { QueryFn } from '../../db/pool.js';
import { resolvePermitActorIdentities } from './actorIdentity.js';

/**
 * NAMING THE PEOPLE BEHIND THE USER IDS.
 *
 * The append-only lifecycle events and `permits.closed_by` record the
 * authenticated actor and nothing else. This turns those ids into names
 * for both kinds of account the system has - an ordinary employee with a
 * workforce profile, and a privileged CEO / System Site Manager who has
 * no team or position at all - and leaves anything it cannot resolve
 * explicitly unresolved.
 *
 * The SQL itself is exercised against a real PostgreSQL engine at the
 * bottom of this file, because the parts that matter most - the lateral
 * "latest grant per role" subquery and the CEO-over-SITE_MANAGER
 * precedence - live in the query rather than in TypeScript.
 */

const CRO = {
  user_id: 'cro-b',
  display_name: 'Osama',
  company_name: 'E-SET',
  team_name: 'E-BOP',
  position_name: 'CRO',
};

/** The two lookups the resolver makes, answering for exactly the ids given. */
function accounts(options: {
  workforce?: Record<string, unknown>[];
  privileged?: Record<string, unknown>[];
}): QueryFn & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = (async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    const ids = new Set((params[0] as string[]) ?? []);
    const source = sql.includes('FROM privileged_identities')
      ? (options.privileged ?? [])
      : (options.workforce ?? []);
    return { rows: source.filter((row) => ids.has(row.user_id as string)) };
  }) as unknown as QueryFn & { calls: typeof calls };
  query.calls = calls;
  return query;
}

test('an employee resolves to their real company, team and position', async () => {
  const identities = await resolvePermitActorIdentities(accounts({ workforce: [CRO] }), ['cro-b']);
  const osama = identities.get('cro-b');
  assert.equal(osama?.kind, 'NORMAL');
  assert.equal(osama?.displayName, 'Osama');
  assert.equal(osama?.companyName, 'E-SET');
  assert.equal(osama?.teamName, 'E-BOP');
  assert.equal(osama?.positionName, 'CRO');
  assert.equal(osama?.privilegedRole, null, 'an employee is never described by a privileged role');
});

test('a privileged account resolves to its role, with no team or position invented', async () => {
  const identities = await resolvePermitActorIdentities(
    accounts({ privileged: [{ user_id: 'ceo-1', display_name: 'Ayesha Khan', role: 'CEO' }] }),
    ['ceo-1'],
  );
  const ceo = identities.get('ceo-1');
  assert.equal(ceo?.kind, 'PRIVILEGED');
  assert.equal(ceo?.displayName, 'Ayesha Khan');
  assert.equal(ceo?.privilegedRole, 'CEO');
  assert.equal(ceo?.teamName, null);
  assert.equal(ceo?.positionName, null);
});

test('a System Site Manager is labelled the way the rest of the application labels them', async () => {
  const identities = await resolvePermitActorIdentities(
    accounts({ privileged: [{ user_id: 'sm-1', display_name: 'Bilal', role: 'SITE_MANAGER' }] }),
    ['sm-1'],
  );
  assert.equal(identities.get('sm-1')?.privilegedRole, 'System Site Manager');
});

test('a privileged account whose grant was revoked keeps its name but loses the role', async () => {
  // They really did perform the action, so they are still named. What
  // they may no longer claim is the authority itself.
  const identities = await resolvePermitActorIdentities(
    accounts({ privileged: [{ user_id: 'ex-ceo', display_name: 'Former CEO', role: null }] }),
    ['ex-ceo'],
  );
  assert.equal(identities.get('ex-ceo')?.displayName, 'Former CEO');
  assert.equal(identities.get('ex-ceo')?.privilegedRole, null);
  assert.equal(identities.get('ex-ceo')?.kind, 'PRIVILEGED');
});

test('an unknown actor is simply absent - never a placeholder identity', async () => {
  const identities = await resolvePermitActorIdentities(accounts({ workforce: [CRO] }), ['ghost']);
  assert.equal(identities.get('ghost'), undefined);
  assert.equal(identities.size, 0);
});

test('a blank display name counts as no identity at all', async () => {
  const identities = await resolvePermitActorIdentities(
    accounts({ workforce: [{ ...CRO, display_name: '   ' }] }),
    ['cro-b'],
  );
  assert.equal(identities.size, 0, 'an empty name is worse than no name');
});

test('many actors are resolved in one batch, deduplicated, with blanks dropped', async () => {
  const query = accounts({ workforce: [CRO, { ...CRO, user_id: 'cro-a', display_name: 'Hamza' }] });
  const identities = await resolvePermitActorIdentities(query, ['cro-a', 'cro-b', 'cro-a', '']);

  assert.equal(identities.size, 2);
  assert.equal(query.calls.length, 2, 'one privileged lookup and one workforce lookup - not one per actor');
  for (const call of query.calls) {
    const ids = call.params[0] as string[];
    assert.deepEqual([...ids].sort(), ['cro-a', 'cro-b'], 'each id asked for once, blanks excluded');
  }
});

test('asking for nobody queries nothing', async () => {
  const query = accounts({});
  assert.equal((await resolvePermitActorIdentities(query, [])).size, 0);
  assert.equal(query.calls.length, 0);
});

test('privileged accounts are not looked for a second time among employees', async () => {
  const query = accounts({
    privileged: [{ user_id: 'ceo-1', display_name: 'Ayesha Khan', role: 'CEO' }],
    workforce: [CRO],
  });
  await resolvePermitActorIdentities(query, ['ceo-1', 'cro-b']);

  const workforceCall = query.calls.find((call) => !call.sql.includes('FROM privileged_identities'))!;
  assert.deepEqual(workforceCall.params[0], ['cro-b'], 'only the ids still unresolved');
});

test('no identity is ever read from a signature', async () => {
  const query = accounts({ workforce: [CRO] });
  await resolvePermitActorIdentities(query, ['cro-b']);
  for (const call of query.calls) {
    assert.ok(!/permit_signatures/.test(call.sql), 'who signed is a different fact from who acted');
  }
});

// ---------------------------------------------------------------------
// The SQL, against a real PostgreSQL engine
// ---------------------------------------------------------------------

test('real PostgreSQL: the privileged lookup reads the latest grant per role, CEO first', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE privileged_identities (user_id uuid PRIMARY KEY, display_name text NOT NULL);
      CREATE TABLE privileged_access_events (
        ordinal bigserial PRIMARY KEY, user_id uuid NOT NULL,
        role text NOT NULL CHECK (role IN ('CEO', 'SITE_MANAGER')),
        action text NOT NULL CHECK (action IN ('GRANTED', 'REVOKED'))
      );
      CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE teams (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE team_positions (id uuid PRIMARY KEY, team_id uuid NOT NULL REFERENCES teams(id), position_id uuid NOT NULL REFERENCES positions(id));
      CREATE TABLE workforce_profiles (
        user_id uuid PRIMARY KEY, display_name text NOT NULL,
        primary_team_position_id uuid REFERENCES team_positions(id), company_id uuid REFERENCES companies(id)
      );

      INSERT INTO privileged_identities VALUES
        ('20000000-0000-4000-8000-000000000001', 'Ayesha Khan'),
        ('20000000-0000-4000-8000-000000000002', 'Bilal Ahmed'),
        ('20000000-0000-4000-8000-000000000003', 'Former Manager');

      -- Ayesha holds BOTH roles; CEO must win.
      INSERT INTO privileged_access_events (user_id, role, action) VALUES
        ('20000000-0000-4000-8000-000000000001', 'SITE_MANAGER', 'GRANTED'),
        ('20000000-0000-4000-8000-000000000001', 'CEO', 'GRANTED'),
      -- Bilal was granted, revoked, then granted again: the latest wins.
        ('20000000-0000-4000-8000-000000000002', 'SITE_MANAGER', 'GRANTED'),
        ('20000000-0000-4000-8000-000000000002', 'SITE_MANAGER', 'REVOKED'),
        ('20000000-0000-4000-8000-000000000002', 'SITE_MANAGER', 'GRANTED'),
      -- The former manager's last event is a revocation.
        ('20000000-0000-4000-8000-000000000003', 'SITE_MANAGER', 'GRANTED'),
        ('20000000-0000-4000-8000-000000000003', 'SITE_MANAGER', 'REVOKED');

      INSERT INTO companies VALUES ('30000000-0000-4000-8000-000000000001', 'E-SET');
      INSERT INTO teams VALUES ('40000000-0000-4000-8000-000000000001', 'E-BOP');
      INSERT INTO positions VALUES ('50000000-0000-4000-8000-000000000001', 'CRO');
      INSERT INTO team_positions VALUES ('60000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001');
      INSERT INTO workforce_profiles VALUES
        ('70000000-0000-4000-8000-000000000001', 'Osama',
         '60000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
      -- An employee whose primary assignment has since been cleared.
        ('70000000-0000-4000-8000-000000000002', 'Unassigned Employee', NULL, NULL);
    `);

    const query = (async (sql: string, params: unknown[] = []) =>
      db.query(sql, params as unknown[])) as unknown as QueryFn;

    const identities = await resolvePermitActorIdentities(query, [
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '20000000-0000-4000-8000-000000000003',
      '70000000-0000-4000-8000-000000000001',
      '70000000-0000-4000-8000-000000000002',
      '80000000-0000-4000-8000-000000000009',
    ]);

    const ayesha = identities.get('20000000-0000-4000-8000-000000000001');
    assert.equal(ayesha?.displayName, 'Ayesha Khan');
    assert.equal(ayesha?.privilegedRole, 'CEO', 'CEO outranks Site Manager for an account holding both');

    const bilal = identities.get('20000000-0000-4000-8000-000000000002');
    assert.equal(bilal?.privilegedRole, 'System Site Manager', 'the LATEST event per role decides');

    const former = identities.get('20000000-0000-4000-8000-000000000003');
    assert.equal(former?.displayName, 'Former Manager', 'they still performed the action');
    assert.equal(former?.privilegedRole, null, 'a revoked grant is not an authority to display');

    const osama = identities.get('70000000-0000-4000-8000-000000000001');
    assert.equal(osama?.kind, 'NORMAL');
    assert.equal(osama?.teamName, 'E-BOP');
    assert.equal(osama?.positionName, 'CRO');
    assert.equal(osama?.companyName, 'E-SET');

    const unassigned = identities.get('70000000-0000-4000-8000-000000000002');
    assert.equal(unassigned?.displayName, 'Unassigned Employee', 'a lapsed assignment costs the team, not the name');
    assert.equal(unassigned?.teamName, null);

    assert.equal(identities.get('80000000-0000-4000-8000-000000000009'), undefined, 'an unknown id stays unknown');
    assert.equal(identities.size, 5);
  } finally {
    await db.close();
  }
});
