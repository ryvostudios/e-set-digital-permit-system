import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import { forwardToHseReview, type PermitsServiceDeps } from './service.js';

test('real PostgreSQL transaction rolls back fallback-only CRO forward when no HSE reviewer exists', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE app_users (id uuid PRIMARY KEY);
      CREATE TABLE jsas (id uuid PRIMARY KEY, created_by uuid NOT NULL REFERENCES app_users(id));
      CREATE TABLE permits (
        id uuid PRIMARY KEY, permit_sequence bigint NOT NULL, status text NOT NULL, version integer NOT NULL,
        created_by uuid NOT NULL REFERENCES app_users(id), jsa_id uuid NOT NULL REFERENCES jsas(id),
        hse_review_started_at timestamptz, hse_review_deadline_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE permit_lifecycle_events (
        id uuid PRIMARY KEY DEFAULT '50000000-0000-4000-8000-000000000001', permit_id uuid NOT NULL REFERENCES permits(id),
        event_type text NOT NULL, actor_user_id uuid NOT NULL, from_status text, to_status text NOT NULL
      );
      CREATE TABLE notifications (
        id uuid PRIMARY KEY DEFAULT '50000000-0000-4000-8000-000000000002', recipient_user_id uuid NOT NULL, permit_id uuid NOT NULL,
        source_event_id uuid NOT NULL REFERENCES permit_lifecycle_events(id), notification_type text NOT NULL,
        title text NOT NULL, message text NOT NULL
      );
      CREATE TABLE whatsapp_outbox_messages (id uuid PRIMARY KEY);
      CREATE TABLE issued_document_snapshots (id uuid PRIMARY KEY);
      CREATE TABLE capabilities (id uuid PRIMARY KEY, name text NOT NULL UNIQUE);
      CREATE TABLE team_position_capabilities (team_position_id uuid NOT NULL, capability_id uuid NOT NULL REFERENCES capabilities(id));
      CREATE TABLE user_team_positions (user_id uuid NOT NULL, team_position_id uuid NOT NULL);

      INSERT INTO app_users VALUES
        ('10000000-0000-4000-8000-000000000001'),
        ('10000000-0000-4000-8000-000000000002'),
        ('10000000-0000-4000-8000-000000000003');
      INSERT INTO jsas VALUES
        ('60000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000003');
      INSERT INTO permits (id, permit_sequence, status, version, created_by, jsa_id)
      VALUES (
        '20000000-0000-4000-8000-000000000001', 1045, 'PENDING_CRO', 7,
        '10000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000001'
      );
      INSERT INTO capabilities VALUES
        ('30000000-0000-4000-8000-000000000001', 'permit.forward_hse'),
        ('30000000-0000-4000-8000-000000000002', 'permit.fallback_approve'),
        ('30000000-0000-4000-8000-000000000003', 'permit.hse_review');
      INSERT INTO team_position_capabilities VALUES
        ('40000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001'),
        ('40000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002');
      INSERT INTO user_team_positions VALUES
        ('10000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001'),
        ('10000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000002');
    `);

    const deps: PermitsServiceDeps = {
      query: db.query.bind(db) as PermitsServiceDeps['query'],
      withTransaction: (async <T>(work: (client: PoolClient) => Promise<T>) => db.transaction(
        async (tx) => work({ query: tx.query.bind(tx) } as unknown as PoolClient),
      )) as PermitsServiceDeps['withTransaction'],
    };

    const result = await forwardToHseReview(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
      { expectedVersion: 7 },
      deps,
    );
    assert.deepEqual(result, { outcome: 'conflict', reason: 'no_responsible_recipient', responsibility: 'HSE' });

    const permit = await db.query<{
      status: string; version: number; hse_review_started_at: Date | null; hse_review_deadline_at: Date | null;
    }>('SELECT status, version, hse_review_started_at, hse_review_deadline_at FROM permits');
    assert.deepEqual(permit.rows[0], {
      status: 'PENDING_CRO', version: 7, hse_review_started_at: null, hse_review_deadline_at: null,
    });
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM permit_lifecycle_events')).rows[0]!.count, 0);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM notifications')).rows[0]!.count, 0);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM whatsapp_outbox_messages')).rows[0]!.count, 0);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM issued_document_snapshots')).rows[0]!.count, 0);
  } finally {
    await db.close();
  }
});
