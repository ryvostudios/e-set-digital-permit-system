import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import { buildPermitClosure, getPermitClosure } from './closure.js';
import type { PermitRow } from './service.js';

/**
 * WHO CLOSED THE PERMIT IS ITS OWN FACT.
 *
 * `permits.closed_by` holds the authenticated actor who actually
 * performed the close - which is very often NOT the CRO who reviewed or
 * forwarded the permit hours earlier. It is a raw user id, so nothing
 * could show it; this resolves it to a name and team for display,
 * without inferring anything from the frozen CRO authorization.
 */

type ClosurePermit = Pick<PermitRow, 'status' | 'closed_by' | 'closed_at' | 'closure_remarks'>;

const closedPermit = (overrides: Partial<ClosurePermit> = {}): ClosurePermit => ({
  status: 'CLOSED',
  closed_by: 'cro-b',
  closed_at: '2026-08-29T11:15:00.000Z',
  closure_remarks: 'Work completed and area restored.',
  ...overrides,
});

/**
 * The two account lookups the shared actor resolver makes, answering for
 * exactly the ids each is given: privileged identities first, then
 * workforce profiles for whoever is left.
 */
function accounts(options: {
  workforce?: Record<string, Record<string, string | null>>;
  privileged?: Record<string, { display_name: string; role: 'CEO' | 'SITE_MANAGER' | null }>;
}): QueryFn {
  return (async (sql: string, params: unknown[] = []) => {
    const ids = (params[0] as string[]) ?? [];
    if (sql.includes('FROM privileged_identities')) {
      return {
        rows: ids
          .filter((id) => options.privileged?.[id])
          .map((id) => ({ user_id: id, ...options.privileged![id] })),
      };
    }
    return {
      rows: ids
        .filter((id) => options.workforce?.[id])
        .map((id) => ({ user_id: id, ...options.workforce![id] })),
    };
  }) as unknown as QueryFn;
}

/** Shorthand for the common case: only workforce employees exist. */
const workforce = (rows: Record<string, Record<string, string | null>>): QueryFn =>
  accounts({ workforce: rows });

const OSAMA = {
  display_name: 'Osama',
  company_name: 'E-SET',
  team_name: 'E-BOP',
  position_name: 'CRO',
};

test('an unclosed permit has no closure record at all', async () => {
  const query = workforce({});
  for (const status of ['DRAFT', 'PENDING_CRO', 'PENDING_HSE', 'ISSUED', 'HELD'] as const) {
    const closure = await getPermitClosure(query, closedPermit({ status, closed_at: null, closed_by: null }));
    assert.equal(closure, null, `${status} must have no closure`);
  }
});

test('a closed permit names the actor the server recorded as the closer', async () => {
  const closure = await getPermitClosure(workforce({ 'cro-b': OSAMA }), closedPermit());
  assert.ok(closure);
  assert.equal(closure.closedBy?.userId, 'cro-b');
  assert.equal(closure.closedBy?.displayName, 'Osama');
  assert.equal(closure.closedBy?.positionName, 'CRO');
  assert.equal(closure.closedBy?.teamName, 'E-BOP');
  assert.equal(closure.closedBy?.companyName, 'E-SET');
});

test('it resolves the CLOSER, never the original reviewer', async () => {
  // Two different CROs exist. The permit was reviewed by A and closed by
  // B, and only B's identity may come back.
  const query = workforce({
    'cro-a': { display_name: 'Hamza', company_name: 'E-SET', team_name: 'E-BOP', position_name: 'CRO' },
    'cro-b': OSAMA,
  });
  const closure = await getPermitClosure(query, closedPermit({ closed_by: 'cro-b' }));
  assert.equal(closure?.closedBy?.displayName, 'Osama');
  assert.notEqual(closure?.closedBy?.displayName, 'Hamza');
});

test('the timestamp and remarks are the permit’s own, verbatim', async () => {
  const closure = await getPermitClosure(workforce({ 'cro-b': OSAMA }), closedPermit());
  assert.equal(closure?.closedAt, '2026-08-29T11:15:00.000Z');
  assert.equal(closure?.remarks, 'Work completed and area restored.');
});

test('blank remarks stay blank - nothing plausible is substituted', async () => {
  const closure = await getPermitClosure(
    workforce({ 'cro-b': OSAMA }),
    closedPermit({ closure_remarks: null }),
  );
  assert.ok(closure);
  assert.equal(closure.remarks, null);
  // The closure itself is still a fact, remarks or not.
  assert.equal(closure.closedBy?.displayName, 'Osama');
});

test('a closer with no account record is reported unnamed, never invented', async () => {
  const closure = await getPermitClosure(workforce({}), closedPermit());
  assert.ok(closure, 'the closure is still a fact');
  assert.equal(closure.closedBy, null, 'no name may be fabricated');
  assert.equal(closure.closedAt, '2026-08-29T11:15:00.000Z');
  assert.equal(closure.remarks, 'Work completed and area restored.');
});

test('a closer whose team assignment has ended still has a name', async () => {
  // The LEFT JOINs mean a lapsed assignment costs the team and position,
  // not the person's name.
  const closure = await getPermitClosure(
    workforce({ 'cro-b': { ...OSAMA, team_name: null, position_name: null } }),
    closedPermit(),
  );
  assert.equal(closure?.closedBy?.displayName, 'Osama');
  assert.equal(closure?.closedBy?.teamName, null);
  assert.equal(closure?.closedBy?.positionName, null);
});

test('a blank display name is treated as no identity rather than an empty one', async () => {
  const closure = await getPermitClosure(
    workforce({ 'cro-b': { ...OSAMA, display_name: '   ' } }),
    closedPermit(),
  );
  assert.equal(closure?.closedBy, null);
});

test('a closed permit with no recorded closer still reports its closure', async () => {
  const closure = await getPermitClosure(workforce({ 'cro-b': OSAMA }), closedPermit({ closed_by: null }));
  assert.ok(closure);
  assert.equal(closure.closedBy, null);
  assert.equal(closure.closedAt, '2026-08-29T11:15:00.000Z');
});

test('it looks the closer up by id, and asks for nothing else', async () => {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const query = (async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params });
    return { rows: [] };
  }) as unknown as QueryFn;

  await getPermitClosure(query, closedPermit());

  assert.ok(captured.length > 0, 'the closer is actually looked up');
  for (const { params } of captured) {
    assert.deepEqual(params, [['cro-b']], 'the recorded closer id, and nothing else');
  }
  // It must not read the signature table - the closer is not a signatory,
  // and the frozen CRO authorization is a different fact entirely.
  for (const { sql } of captured) {
    assert.ok(!/permit_signatures/.test(sql), 'no identity may come from a signature');
  }
});

test('a privileged CEO who closes a permit is named, not left unknown', async () => {
  const closure = await getPermitClosure(
    accounts({ privileged: { 'ceo-1': { display_name: 'Ayesha Khan', role: 'CEO' } } }),
    closedPermit({ closed_by: 'ceo-1' }),
  );
  assert.equal(closure?.closedBy?.displayName, 'Ayesha Khan');
  assert.equal(closure?.closedBy?.kind, 'PRIVILEGED');
  assert.equal(closure?.closedBy?.privilegedRole, 'CEO');
  // A privileged account holds no team or position, and must not be
  // given a fabricated one.
  assert.equal(closure?.closedBy?.teamName, null);
  assert.equal(closure?.closedBy?.positionName, null);
});

test('a closer who is neither privileged nor an employee stays explicitly unknown', async () => {
  const closure = await getPermitClosure(accounts({}), closedPermit({ closed_by: 'ghost' }));
  assert.ok(closure, 'the closure itself is still a fact');
  assert.equal(closure.closedBy, null, 'no name may be guessed');
  assert.equal(closure.remarks, 'Work completed and area restored.');
});

test('an ordinary employee is described by their real assignment, never a privileged role', async () => {
  const closure = await getPermitClosure(workforce({ 'cro-b': OSAMA }), closedPermit());
  assert.equal(closure?.closedBy?.kind, 'NORMAL');
  assert.equal(closure?.closedBy?.privilegedRole, null);
  assert.equal(closure?.closedBy?.positionName, 'CRO');
});

test('buildPermitClosure reads the closer from the already-resolved actors', async () => {
  const actors = new Map([
    ['cro-a', { userId: 'cro-a', kind: 'NORMAL' as const, displayName: 'Hamza', companyName: 'E-SET', teamName: 'E-BOP', positionName: 'CRO', privilegedRole: null }],
    ['cro-b', { userId: 'cro-b', kind: 'NORMAL' as const, displayName: 'Osama', companyName: 'E-SET', teamName: 'E-BOP', positionName: 'CRO', privilegedRole: null }],
  ]);
  // The permit was reviewed by A and closed by B; only B may come back,
  // even with both identities in hand.
  const closure = buildPermitClosure(closedPermit({ closed_by: 'cro-b' }), actors);
  assert.equal(closure?.closedBy?.displayName, 'Osama');
  assert.equal(buildPermitClosure(closedPermit({ closed_by: 'nobody' }), actors)?.closedBy, null);
  assert.equal(buildPermitClosure(closedPermit({ status: 'ISSUED' }), actors), null);
});
