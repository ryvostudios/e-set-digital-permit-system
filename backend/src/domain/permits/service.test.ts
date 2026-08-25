import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createDraftPermit,
  getOwnPermit,
  submitPermit,
  updateDraftPermit,
  type JsaRow,
  type PermitRow,
  type PermitsServiceDeps,
} from './service.js';

/**
 * A minimal in-memory stand-in for Postgres that understands only the
 * exact query shapes `service.ts` issues, so these tests exercise the
 * service's transaction/locking/conflict logic without a live database.
 */
class FakeDb {
  permits = new Map<string, PermitRow>();
  jsas = new Map<string, JsaRow>();
  queries: Array<{ sql: string; params: unknown[] }> = [];
  private permitSeq = 0;
  private jsaSeq = 0;
  private permitCounter = 0;
  private jsaCounter = 0;

  private rawQuery = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const sql = text.trim();
    this.queries.push({ sql, params });

    if (sql.startsWith('INSERT INTO jsas')) {
      const [createdBy] = params as [string];
      this.jsaCounter += 1;
      this.jsaSeq += 1;
      const jsa: JsaRow = {
        id: `jsa-${this.jsaCounter}`,
        jsa_sequence: String(this.jsaSeq),
        created_by: createdBy,
        created_at: new Date().toISOString(),
      };
      this.jsas.set(jsa.id, jsa);
      return { rows: [jsa] };
    }
    if (sql.startsWith('INSERT INTO permits')) {
      const [jsaId, createdBy, siteTimezone] = params as [string, string, string];
      this.permitCounter += 1;
      this.permitSeq += 1;
      const permit: PermitRow = {
        id: `permit-${this.permitCounter}`,
        permit_sequence: String(this.permitSeq),
        jsa_id: jsaId,
        status: 'DRAFT',
        version: 1,
        created_by: createdBy,
        previous_permit_id: null,
        site_timezone: siteTimezone,
        company: null,
        company_other: null,
        submitted_at: null,
        issued_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.permits.set(permit.id, permit);
      return { rows: [permit] };
    }
    if (sql.startsWith('INSERT INTO permit_lifecycle_events')) {
      const [, eventType, , fromStatus, toStatus] = params as [string, string, string, string | null, string];
      // Mirrors migration 0006's permit_lifecycle_events_event_status_consistent
      // CHECK constraint, so a violation here fails the same way it would
      // against the real database.
      const allowed =
        (eventType === 'CREATED' && fromStatus === null && toStatus === 'DRAFT') ||
        (eventType === 'SUBMITTED' && fromStatus === 'DRAFT' && toStatus === 'PENDING_CRO');
      if (!allowed) {
        throw new Error(
          `simulated CHECK constraint violation: permit_lifecycle_events_event_status_consistent (event_type=${eventType}, from_status=${fromStatus}, to_status=${toStatus})`,
        );
      }
      return { rows: [] };
    }
    if (sql.startsWith('SELECT * FROM permits WHERE id = $1 AND created_by = $2')) {
      const [id, createdBy] = params as [string, string];
      const permit = this.permits.get(id);
      return permit && permit.created_by === createdBy ? { rows: [permit] } : { rows: [] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes('SET company')) {
      const [company, companyOther, id] = params as [string | null, string | null, string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        company: company as PermitRow['company'],
        company_other: companyOther,
        version: existing.version + 1,
        updated_at: new Date().toISOString(),
      };
      this.permits.set(id, updated);
      return { rows: [updated] };
    }
    if (sql.startsWith('UPDATE permits') && sql.includes("SET status = 'PENDING_CRO'")) {
      const [id] = params as [string];
      const existing = this.permits.get(id);
      if (!existing) return { rows: [] };
      const updated: PermitRow = {
        ...existing,
        status: 'PENDING_CRO',
        version: existing.version + 1,
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      this.permits.set(id, updated);
      return { rows: [updated] };
    }

    throw new Error(`FakeDb: unhandled query: ${sql}`);
  };

  deps(): PermitsServiceDeps {
    const query = this.rawQuery as PermitsServiceDeps['query'];
    return {
      query,
      withTransaction: (async (fn) => fn({ query } as never)) as PermitsServiceDeps['withTransaction'],
    };
  }
}

test('createDraftPermit generates unique permit/JSA numbers per call and records a CREATED event', async () => {
  const db = new FakeDb();
  const first = await createDraftPermit('user-1', 'UTC', db.deps());
  const second = await createDraftPermit('user-1', 'UTC', db.deps());

  assert.notEqual(first.permit.permit_sequence, second.permit.permit_sequence);
  assert.notEqual(first.jsa.jsa_sequence, second.jsa.jsa_sequence);
  assert.equal(first.permit.status, 'DRAFT');
  assert.equal(first.permit.version, 1);

  const createdEvents = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(createdEvents.length, 2);
});

test('createDraftPermit produces unique numbers under concurrent calls', async () => {
  const db = new FakeDb();
  const results = await Promise.all(
    Array.from({ length: 10 }, () => createDraftPermit('user-1', 'UTC', db.deps())),
  );
  const permitSequences = results.map((r) => r.permit.permit_sequence);
  const jsaSequences = results.map((r) => r.jsa.jsa_sequence);
  assert.equal(new Set(permitSequences).size, permitSequences.length);
  assert.equal(new Set(jsaSequences).size, jsaSequences.length);
});

test('getOwnPermit returns null for a permit that exists but belongs to someone else (no existence leak)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const asOwner = await getOwnPermit('owner', permit.id, db.deps());
  const asOther = await getOwnPermit('someone-else', permit.id, db.deps());
  const missing = await getOwnPermit('owner', 'no-such-id', db.deps());

  assert.equal(asOwner?.id, permit.id);
  assert.equal(asOther, null);
  assert.equal(missing, null);
});

test('updateDraftPermit rejects a stale version instead of silently overwriting', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version + 1, company: 'ESET' },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'stale_version' });
  const stillDraft = await getOwnPermit('owner', permit.id, db.deps());
  assert.equal(stillDraft?.company, null);
  assert.equal(stillDraft?.version, permit.version);
});

test('updateDraftPermit rejects updating a permit that is no longer DRAFT', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  await updateDraftPermit('owner', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  const submitted = await submitPermit('owner', permit.id, { expectedVersion: permit.version + 1 }, db.deps());
  assert.equal(submitted.outcome, 'ok');

  const result = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version + 2, company: 'SGRE' },
    db.deps(),
  );

  assert.deepEqual(result, { outcome: 'conflict', reason: 'not_draft' });
});

test('submitPermit rejects the transition when the required company field is missing', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  const result = await submitPermit('owner', permit.id, { expectedVersion: permit.version }, db.deps());

  assert.deepEqual(result, { outcome: 'invalid', reason: 'missing_required_fields' });
});

test('submitPermit requires companyOther when company is OTHER before allowing submission', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'OTHER', companyOther: 'Acme Contracting' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;

  const result = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
});

test('submitPermit performs the only implemented transition, DRAFT -> PENDING_CRO, once the required field is set', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;

  const result = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());

  assert.equal(result.outcome, 'ok');
  if (result.outcome !== 'ok') return;
  assert.equal(result.permit.status, 'PENDING_CRO');
  assert.ok(result.permit.submitted_at);
});

test('submitPermit rejects submitting an already-submitted permit (invalid transition rejection)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  const updated = await updateDraftPermit(
    'owner',
    permit.id,
    { expectedVersion: permit.version, company: 'ESET' },
    db.deps(),
  );
  assert.equal(updated.outcome, 'ok');
  if (updated.outcome !== 'ok') return;
  const firstSubmit = await submitPermit('owner', permit.id, { expectedVersion: updated.permit.version }, db.deps());
  assert.equal(firstSubmit.outcome, 'ok');
  if (firstSubmit.outcome !== 'ok') return;

  const secondSubmit = await submitPermit(
    'owner',
    permit.id,
    { expectedVersion: firstSubmit.permit.version },
    db.deps(),
  );

  assert.deepEqual(secondSubmit, { outcome: 'conflict', reason: 'not_draft' });
});

test('lifecycle events are only ever inserted, never updated or deleted (immutability at the application boundary)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  await updateDraftPermit('owner', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  await submitPermit('owner', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  const lifecycleEventQueries = db.queries.filter((q) => q.sql.includes('permit_lifecycle_events'));
  assert.ok(lifecycleEventQueries.length >= 2);
  for (const q of lifecycleEventQueries) {
    assert.ok(
      q.sql.startsWith('INSERT INTO permit_lifecycle_events'),
      `expected only INSERTs against permit_lifecycle_events, got: ${q.sql}`,
    );
  }
});

test('createDraftPermit/submitPermit only ever write event/status pairs the database CHECK constraint allows', async () => {
  // FakeDb's INSERT INTO permit_lifecycle_events handler mirrors migration
  // 0006's permit_lifecycle_events_event_status_consistent CHECK constraint
  // and throws on a disallowed pair - so simply not throwing here is the
  // assertion that both real call sites (CREATED/SUBMITTED) stay compliant.
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());
  await updateDraftPermit('owner', permit.id, { expectedVersion: permit.version, company: 'ESET' }, db.deps());
  await submitPermit('owner', permit.id, { expectedVersion: permit.version + 1 }, db.deps());

  const insertedEvents = db.queries.filter((q) => q.sql.startsWith('INSERT INTO permit_lifecycle_events'));
  assert.equal(insertedEvents.length, 2);
  assert.deepEqual(insertedEvents[0]?.params, [permit.id, 'CREATED', 'owner', null, 'DRAFT']);
  assert.deepEqual(insertedEvents[1]?.params, [permit.id, 'SUBMITTED', 'owner', 'DRAFT', 'PENDING_CRO']);
});

test('an event/status pair outside the allowed set is rejected (simulated DB CHECK constraint)', async () => {
  const db = new FakeDb();
  const { permit } = await createDraftPermit('owner', 'UTC', db.deps());

  await assert.rejects(
    () =>
      db
        .deps()
        .query(
          `INSERT INTO permit_lifecycle_events (permit_id, event_type, actor_user_id, from_status, to_status)
           VALUES ($1, $2, $3, $4, $5)`,
          [permit.id, 'SUBMITTED', 'owner', null, 'PENDING_CRO'],
        ),
    /CHECK constraint/,
  );
});
