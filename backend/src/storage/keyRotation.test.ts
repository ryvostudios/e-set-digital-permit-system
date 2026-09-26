import { PREVIOUS_KEY_V1, RETIRED_KEY_V0 } from '../test/syntheticRotationEnv.js';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { QueryFn } from '../db/pool.js';
import { installedDatabase } from '../test/permitSchemaFixtures.js';
import { connectionClient, dropboxSetup, type StorageConnectionRow } from './connections.js';
import { envelopeKeyVersion, sealStorageSecret, storageKeyring, unsealStorageSecret } from './crypto.js';
import { reencryptConnections, storageKeyUsage } from './keyRotation.js';

/**
 * Storage key rotation against the real `permit` schema: key 2 active,
 * key 1 read-only, key 0 already removed from the configuration. Tokens are
 * unexpired, so no provider call happens (fetch is never reached).
 */

let db: PGlite;
let q: QueryFn;
const tokens = { accessToken: 'sl.synthetic', refreshToken: 'synthetic-refresh', expiresAt: Date.now() + 3_600_000 };
const v1 = storageKeyring('1', PREVIOUS_KEY_V1);
const v0 = storageKeyring('0', RETIRED_KEY_V0);

async function connection(keys: ReturnType<typeof storageKeyring>): Promise<StorageConnectionRow> {
  const id = randomUUID();
  await db.query(`INSERT INTO permit.storage_connections (id, provider, status, account_id, account_label, credentials)
    VALUES ($1, 'dropbox', 'connected', $2, 'synthetic', $3)`,
  [id, `dbid:${id}`, sealStorageSecret(tokens, `connection:${id}`, keys)]);
  return (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections WHERE id = $1', [id])).rows[0]!;
}
const row = async (id: string) =>
  (await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections WHERE id = $1', [id])).rows[0]!;

before(async () => {
  db = await installedDatabase();
  q = ((text: string, params?: unknown[]) => db.query(text, params)) as unknown as QueryFn;
  globalThis.fetch = (async () => { throw new Error('no provider call expected'); }) as typeof fetch;
});

test('configuration: key 2 active, key 1 read-only', () => {
  const setup = dropboxSetup()!;
  assert.equal(setup.key.active.version, '2');
  assert.deepEqual([...setup.key.keys.keys()], ['2', '1']);
});

test('a token sealed under the previous key is decrypted and re-sealed under the active key on use', async () => {
  const setup = dropboxSetup()!;
  const old = await connection(v1);
  const before = await storageKeyUsage(q, setup.key);
  assert.equal(before.pendingReencryption, 1);
  assert.deepEqual(before.removableVersions, []);

  await connectionClient(old, q);
  const after = await row(old.id);
  assert.equal(envelopeKeyVersion(after.credentials!), '2');
  assert.equal(after.token_revision, old.token_revision + 1);
  assert.deepEqual(unsealStorageSecret(after.credentials!, `connection:${old.id}`, setup.key), tokens);
  assert.throws(() => unsealStorageSecret(after.credentials!, `connection:${old.id}`, v1), 'no longer readable with key 1');

  const usage = await storageKeyUsage(q, setup.key);
  assert.equal(usage.pendingReencryption, 0);
  assert.deepEqual(usage.removableVersions, ['1']);
});

test('an unexpired OAuth state under the previous key keeps it non-removable until it expires', async () => {
  const setup = dropboxSetup()!;
  const [ceo] = (await db.query<{ id: string }>(`INSERT INTO permit.users (id, email) VALUES ($1, 'rotation@example.test') RETURNING id`, [randomUUID()])).rows;
  const [session] = (await db.query<{ id: string }>(`INSERT INTO permit.user_sessions (user_id, token_hash, expires_at)
    VALUES ($1, $2, now() + interval '1 hour') RETURNING id`, [ceo!.id, createHash('sha256').update('s').digest()])).rows;
  await db.query(`INSERT INTO permit.storage_oauth_states (state_hash, actor_user_id, session_id, verifier_envelope,
      connection_revision, redirect_uri, expires_at)
    VALUES ($4, $1, $2, $3, 0, 'http://localhost:3001/api/v1/cms/dropbox/callback', now() + interval '10 minutes')`,
  [ceo!.id, session!.id, sealStorageSecret({ verifier: 'v' }, 'oauth:02', v1), createHash('sha256').update('state').digest()]);
  assert.deepEqual((await storageKeyUsage(q, setup.key)).removableVersions, []);
  await db.query(`UPDATE permit.storage_oauth_states SET expires_at = now() - interval '1 second'`);
  assert.deepEqual((await storageKeyUsage(q, setup.key)).removableVersions, ['1']);
});

test('the rekey command re-seals every previous-key credential; dry run writes nothing', async () => {
  const setup = dropboxSetup()!;
  const a = await connection(v1);
  const b = await connection(v1);
  const dry = await reencryptConnections(q, setup.key, { dryRun: true });
  assert.equal(dry.reencrypted, 2);
  assert.equal(envelopeKeyVersion((await row(a.id)).credentials!), '1');

  const done = await reencryptConnections(q, setup.key, { dryRun: false });
  assert.deepEqual(done, { examined: 3, reencrypted: 2, conflicts: 0, unreadable: 0 });
  for (const id of [a.id, b.id]) assert.equal(envelopeKeyVersion((await row(id)).credentials!), '2');
  assert.equal((await reencryptConnections(q, setup.key, { dryRun: false })).reencrypted, 0, 'idempotent');
});

test('a credential under a removed key is reported missing and fails closed; a concurrent change is not overwritten', async () => {
  const setup = dropboxSetup()!;
  const orphan = await connection(v0);
  const usage = await storageKeyUsage(q, setup.key);
  assert.deepEqual(usage.missingVersions, ['0']);
  assert.ok(!JSON.stringify(usage).includes(RETIRED_KEY_V0) && !JSON.stringify(usage).includes(PREVIOUS_KEY_V1));
  await assert.rejects(connectionClient(orphan, q), /decryption failed/);
  const result = await reencryptConnections(q, setup.key, { dryRun: false });
  assert.equal(result.unreadable, 1);
  assert.equal((await row(orphan.id)).credentials, orphan.credentials, 'left untouched for the operator');

  // Stale snapshot: the row changed after it was read, so the CAS refuses.
  const racing = await connection(v1);
  await db.query('UPDATE permit.storage_connections SET token_revision = token_revision + 1 WHERE id = $1', [racing.id]);
  const { resealConnection } = await import('./connections.js');
  assert.equal(await resealConnection(q, racing, tokens, setup.key), false);
  assert.equal(envelopeKeyVersion((await row(racing.id)).credentials!), '1');
});

test('A02: accounting is label-safe; a referenced key is never removable, an unused one is', async () => {
  const key = (version: string, encoded: string) => ({ active: { version, key: Buffer.from(encoded, 'base64') },
    keys: new Map([[version, Buffer.from(encoded, 'base64')]]) }) as ReturnType<typeof storageKeyring>;
  // Envelopes carrying labels no configuration can produce (corrupt or crafted data).
  for (const label of ['__proto__', 'constructor', 'prototype']) await connection(key(label, PREVIOUS_KEY_V1));
  const ring = storageKeyring('2', RETIRED_KEY_V0, `1:${PREVIOUS_KEY_V1},7:${randomBytes32()}`);
  await connection(storageKeyring('1', PREVIOUS_KEY_V1));        // key 1 is still referenced
  const usage = await storageKeyUsage(q, ring);
  const counted = new Map(usage.envelopesByVersion);
  for (const label of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(counted.get(label), 1, `${label} is counted`);
    assert.ok(usage.missingVersions.includes(label), `${label} is reported unopenable`);
  }
  assert.ok(!usage.removableVersions.includes('1'), 'a referenced previous version is never removable');
  assert.ok(usage.removableVersions.includes('7'), 'a truly unused previous version is removable');
  assert.equal(JSON.stringify(usage).includes(PREVIOUS_KEY_V1), false);
});

function randomBytes32(): string {
  return Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256)).toString('base64');
}
