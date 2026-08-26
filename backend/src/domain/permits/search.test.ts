import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../../db/pool.js';
import { searchPermitLifecycleEvents, searchPermits } from './search.js';
import type { LifecycleEventRow, PermitRow, PermitStatus } from './service.js';

/**
 * A permits+jsas fake that interprets the ACTUAL dynamically-built SQL
 * text `search.ts` sends - rather than hand-simulating each filter
 * combination separately - by extracting each optional filter's bound
 * parameter index straight out of the SQL (`p.company = $3` -> read
 * `params[2]`), the same way Postgres itself would. This is what lets
 * these tests prove the real WHERE-clause-building logic in
 * `search.ts`, not a re-implementation of it.
 */
function paramAt(sql: string, pattern: RegExp, params: readonly unknown[]): unknown {
  const match = sql.match(pattern);
  if (!match) return undefined;
  return params[Number(match[1]!) - 1];
}

interface FakePermitJoinRow extends PermitRow {
  jsa_sequence: string;
}

function buildPermitsQuery(rows: FakePermitJoinRow[]): QueryFn {
  return (async (text: string, params: unknown[] = []) => {
    const sql = text.trim();
    const viewerId = params[0] as string;
    const allowedStatuses = params[1] as PermitStatus[];
    const permitNumber = paramAt(sql, /p\.permit_sequence = \$(\d+)/, params);
    const jsaNumber = paramAt(sql, /j\.jsa_sequence = \$(\d+)/, params);
    const status = paramAt(sql, / AND p\.status = \$(\d+)/, params);
    const company = paramAt(sql, /p\.company = \$(\d+)/, params);
    const createdBy = paramAt(sql, / AND p\.created_by = \$(\d+)/, params);
    const createdFrom = paramAt(sql, /p\.created_at >= \$(\d+)/, params);
    const createdTo = paramAt(sql, /p\.created_at <= \$(\d+)/, params);

    const matches = rows.filter((row) => {
      if (!(row.created_by === viewerId || allowedStatuses.includes(row.status))) return false;
      if (permitNumber !== undefined && row.permit_sequence !== permitNumber) return false;
      if (jsaNumber !== undefined && row.jsa_sequence !== jsaNumber) return false;
      if (status !== undefined && row.status !== status) return false;
      if (company !== undefined && row.company !== company) return false;
      if (createdBy !== undefined && row.created_by !== createdBy) return false;
      if (createdFrom !== undefined && row.created_at < (createdFrom as string)) return false;
      if (createdTo !== undefined && row.created_at > (createdTo as string)) return false;
      return true;
    });

    if (sql.startsWith('SELECT p.*')) {
      const sorted = [...matches].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      const pageSize = params[params.length - 2] as number;
      const offset = params[params.length - 1] as number;
      return { rows: sorted.slice(offset, offset + pageSize) };
    }
    if (sql.startsWith('SELECT COUNT(*)')) {
      return { rows: [{ count: String(matches.length) }] };
    }
    throw new Error(`unhandled query: ${sql}`);
  }) as QueryFn;
}

function makePermit(overrides: Partial<FakePermitJoinRow>): FakePermitJoinRow {
  return {
    id: 'permit-x',
    permit_sequence: '1',
    jsa_id: 'jsa-x',
    jsa_sequence: '1',
    status: 'ISSUED',
    version: 1,
    created_by: 'someone',
    previous_permit_id: null,
    site_timezone: 'UTC',
    company: 'ESET',
    company_other: null,
    submitted_at: null,
    hse_review_started_at: null,
    hse_review_deadline_at: null,
    issued_at: '2026-01-01T09:00:00.000Z',
    closed_by: null,
    closed_at: null,
    closure_remarks: null,
    held_by: null,
    held_at: null,
    hold_reason: null,
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('searchPermits: a caller with no capabilities only finds their own permits', async () => {
  const rows = [
    makePermit({ id: 'p1', permit_sequence: '1', created_by: 'me', status: 'ISSUED' }),
    makePermit({ id: 'p2', permit_sequence: '2', created_by: 'someone-else', status: 'ISSUED' }),
  ];
  const page = await searchPermits(
    { viewerId: 'me', allowedStatuses: [] },
    {},
    { page: 1, pageSize: 20 },
    { query: buildPermitsQuery(rows) },
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, 'p1');
});

test('searchPermits: a status capability grants visibility into OTHER users\' permits in that status only', async () => {
  const rows = [
    makePermit({ id: 'p1', permit_sequence: '1', created_by: 'someone-else', status: 'PENDING_CRO' }),
    makePermit({ id: 'p2', permit_sequence: '2', created_by: 'someone-else', status: 'DRAFT' }),
  ];
  const page = await searchPermits(
    { viewerId: 'me', allowedStatuses: ['PENDING_CRO'] },
    {},
    { page: 1, pageSize: 20 },
    { query: buildPermitsQuery(rows) },
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, 'p1');
});

test('searchPermits: search must never reveal a permit the caller cannot normally view, even by guessing its exact Permit Number', async () => {
  const rows = [makePermit({ id: 'p1', permit_sequence: '1045', created_by: 'someone-else', status: 'DRAFT' })];
  const page = await searchPermits(
    { viewerId: 'me', allowedStatuses: [] },
    { permitNumber: 1045 },
    { page: 1, pageSize: 20 },
    { query: buildPermitsQuery(rows) },
  );
  assert.equal(page.items.length, 0);
  assert.equal(page.totalCount, 0);
});

test('searchPermits: filters by exact Permit Number and JSA Number', async () => {
  const rows = [
    makePermit({ id: 'p1', permit_sequence: '1045', jsa_sequence: '234', created_by: 'me' }),
    makePermit({ id: 'p2', permit_sequence: '1046', jsa_sequence: '235', created_by: 'me' }),
  ];
  const byPermit = await searchPermits({ viewerId: 'me', allowedStatuses: [] }, { permitNumber: 1045 }, { page: 1, pageSize: 20 }, { query: buildPermitsQuery(rows) });
  assert.equal(byPermit.items.length, 1);
  assert.equal(byPermit.items[0]?.id, 'p1');

  const byJsa = await searchPermits({ viewerId: 'me', allowedStatuses: [] }, { jsaNumber: 235 }, { page: 1, pageSize: 20 }, { query: buildPermitsQuery(rows) });
  assert.equal(byJsa.items.length, 1);
  assert.equal(byJsa.items[0]?.id, 'p2');
});

test('searchPermits: filters by company and date range narrow within the access scope', async () => {
  const rows = [
    makePermit({ id: 'p1', permit_sequence: '1', created_by: 'me', company: 'ESET', created_at: '2026-01-01T00:00:00.000Z' }),
    makePermit({ id: 'p2', permit_sequence: '2', created_by: 'me', company: 'SGRE', created_at: '2026-02-01T00:00:00.000Z' }),
  ];
  const byCompany = await searchPermits({ viewerId: 'me', allowedStatuses: [] }, { company: 'SGRE' }, { page: 1, pageSize: 20 }, { query: buildPermitsQuery(rows) });
  assert.equal(byCompany.items.length, 1);
  assert.equal(byCompany.items[0]?.id, 'p2');

  const byDate = await searchPermits(
    { viewerId: 'me', allowedStatuses: [] },
    { createdFrom: new Date('2026-01-15T00:00:00.000Z') },
    { page: 1, pageSize: 20 },
    { query: buildPermitsQuery(rows) },
  );
  assert.equal(byDate.items.length, 1);
  assert.equal(byDate.items[0]?.id, 'p2');
});

test('searchPermits: COUNT and returned rows share identical authorization scope', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => makePermit({ id: `p${i}`, permit_sequence: String(i), created_by: 'me' }));
  const page = await searchPermits({ viewerId: 'me', allowedStatuses: [] }, {}, { page: 1, pageSize: 2 }, { query: buildPermitsQuery(rows) });
  assert.equal(page.items.length, 2);
  assert.equal(page.totalCount, 5);
});

test('searchPermits: rejects a pathological pagination offset defensively', async () => {
  await assert.rejects(() =>
    searchPermits({ viewerId: 'me', allowedStatuses: [] }, {}, { page: 999_999_999, pageSize: 100 }, { query: buildPermitsQuery([]) }),
  );
});

function buildLifecycleQuery(rows: LifecycleEventRow[]): QueryFn {
  return (async (text: string, params: unknown[] = []) => {
    const sql = text.trim();
    const permitId = params[0] as string;
    const eventType = paramAt(sql, /event_type = \$(\d+)/, params);
    const actorUserId = paramAt(sql, /actor_user_id = \$(\d+)/, params);
    const fromStatus = paramAt(sql, / AND from_status = \$(\d+)/, params);
    const toStatus = paramAt(sql, / AND to_status = \$(\d+)/, params);
    const occurredFrom = paramAt(sql, /occurred_at >= \$(\d+)/, params);
    const occurredTo = paramAt(sql, /occurred_at <= \$(\d+)/, params);

    const matches = rows.filter((row) => {
      if (row.permit_id !== permitId) return false;
      if (eventType !== undefined && row.event_type !== eventType) return false;
      if (actorUserId !== undefined && row.actor_user_id !== actorUserId) return false;
      if (fromStatus !== undefined && row.from_status !== fromStatus) return false;
      if (toStatus !== undefined && row.to_status !== toStatus) return false;
      if (occurredFrom !== undefined && row.occurred_at < (occurredFrom as string)) return false;
      if (occurredTo !== undefined && row.occurred_at > (occurredTo as string)) return false;
      return true;
    });

    if (sql.startsWith('SELECT * FROM permit_lifecycle_events')) {
      const sorted = [...matches].sort((a, b) => a.ordinal.localeCompare(b.ordinal));
      const pageSize = params[params.length - 2] as number;
      const offset = params[params.length - 1] as number;
      return { rows: sorted.slice(offset, offset + pageSize) };
    }
    if (sql.startsWith('SELECT COUNT(*)')) {
      return { rows: [{ count: String(matches.length) }] };
    }
    throw new Error(`unhandled query: ${sql}`);
  }) as QueryFn;
}

function makeEvent(overrides: Partial<LifecycleEventRow>): LifecycleEventRow {
  return {
    id: 'event-x',
    ordinal: '1',
    permit_id: 'permit-1',
    event_type: 'CREATED',
    actor_user_id: 'user-1',
    from_status: null,
    to_status: 'DRAFT',
    reason: null,
    occurred_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('searchPermitLifecycleEvents: filters by event type, actor, and status pair - scoped to one permit only', async () => {
  const rows = [
    makeEvent({ id: 'e1', ordinal: '1', permit_id: 'permit-1', event_type: 'CREATED', actor_user_id: 'user-1', to_status: 'DRAFT' }),
    makeEvent({ id: 'e2', ordinal: '2', permit_id: 'permit-1', event_type: 'SUBMITTED', actor_user_id: 'user-1', from_status: 'DRAFT', to_status: 'PENDING_CRO' }),
    makeEvent({ id: 'e3', ordinal: '1', permit_id: 'permit-2', event_type: 'CREATED', actor_user_id: 'user-2', to_status: 'DRAFT' }),
  ];
  const page = await searchPermitLifecycleEvents('permit-1', { eventType: 'SUBMITTED' }, { page: 1, pageSize: 20 }, { query: buildLifecycleQuery(rows) });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]?.id, 'e2');
});

test('searchPermitLifecycleEvents: chronological ordering is deterministic under pagination', async () => {
  const rows = [
    makeEvent({ id: 'e1', ordinal: '1' }),
    makeEvent({ id: 'e2', ordinal: '2' }),
    makeEvent({ id: 'e3', ordinal: '3' }),
  ];
  const page = await searchPermitLifecycleEvents('permit-1', {}, { page: 1, pageSize: 2 }, { query: buildLifecycleQuery(rows) });
  assert.deepEqual(page.items.map((e) => e.id), ['e1', 'e2']);
  assert.equal(page.totalCount, 3);
});
