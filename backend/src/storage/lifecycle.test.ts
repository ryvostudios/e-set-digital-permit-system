import '../test/syntheticDropboxEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CEO, LifecycleWorld, tinyPng } from '../test/storageLifecycleHarness.js';
import {
  completeDropboxConnect, disconnectDropbox, selectDropbox, startDropboxConnect, StorageConflict, StorageUnavailable,
  testDropboxConnection,
} from './admin.js';
import { storeManagedFile } from './managedFiles.js';

/**
 * A01 (independent audit, P1): Permit Dropbox connection lifecycle races.
 * Each test drives one interleaving deterministically through provider
 * barriers and ends on the invariant: no committed state holds a ready or
 * pending registry file, or a selection, whose connection's credentials were
 * destroyed.
 */

const world = new LifecycleWorld();
before(() => world.start());
after(() => world.stop());

const upload = (seed: string) => storeManagedFile({
  identity: randomUUID(), category: 'BRANDING', bytes: tinyPng(seed), mimeType: 'image/png', originalFilename: `${seed}.png`, createdBy: CEO,
});

test('A01 audit reproduction: a stale health success during disconnect must not revive, select or orphan', async () => {
  const id = await world.connection();
  const health = world.gate('/2/users/get_current_account');
  const revoke = world.gate('/2/auth/token/revoke');

  const healthRun = testDropboxConnection(CEO, id);
  await health.reached;                                   // health check holds a pre-disconnect snapshot
  const disconnectRun = disconnectDropbox(CEO, id, (await world.row(id)).revision);
  await revoke.reached;                                   // disconnect committed 'disconnecting', revoke in flight
  assert.equal((await world.row(id)).status, 'disconnecting');

  health.release();                                       // the stale health response arrives
  const healthResult = await Promise.allSettled([healthRun]);
  const selectResult = await Promise.allSettled([selectDropbox(CEO, await world.selectionRevision(), true, id)]);
  const uploadResult = await Promise.allSettled([upload('during-disconnect')]);

  revoke.release();
  const disconnectResult = await Promise.allSettled([disconnectRun]);

  const final = await world.row(id);
  const summary = JSON.stringify({
    health: healthResult[0]!.status, select: selectResult[0]!.status, upload: uploadResult[0]!.status,
    disconnect: disconnectResult[0]!.status, status: final.status, credentials: final.credentials ? 'present' : 'removed',
    selected: (await world.db.query('SELECT 1 FROM permit.storage_selection WHERE connection_id = $1', [id])).rows.length === 1,
    readyFiles: (await world.db.query("SELECT 1 FROM permit.file_registry WHERE connection_id = $1 AND state = 'ready'", [id])).rows.length,
    orphaned: await world.orphanedFiles(),
  });
  assert.equal(healthResult[0]!.status, 'rejected', `a stale health result is refused ${summary}`);
  assert.equal(selectResult[0]!.status, 'rejected', 'a disconnecting connection cannot be selected');
  assert.equal(uploadResult[0]!.status, 'rejected', 'no new file reference during disconnect');
  assert.equal(disconnectResult[0]!.status, 'fulfilled');
  assert.equal(final.status, 'disconnected');
  assert.equal(final.credentials, null);
  assert.equal(await world.orphanedFiles(), 0, 'no reference-bearing file or selection lost its credentials');
});

// ---- the twelve interleavings of the remediation brief --------------------


async function claimedDisconnect(id: string) {
  const revoke = world.gate('/2/auth/token/revoke');
  const run = disconnectDropbox(CEO, id, (await world.row(id)).revision);
  await revoke.reached;
  assert.equal((await world.row(id)).status, 'disconnecting');
  return { revoke, run };
}

async function reconnect(id: string): Promise<void> {
  const session = await world.session();
  const { authorizationUrl } = await startDropboxConnect(CEO, session);
  world.accountFor = `${(await world.db.query<{ account_id: string }>(
    'SELECT account_id FROM permit.storage_connections WHERE id = $1', [id])).rows[0]!.account_id}`;
  try {
    await completeDropboxConnect(CEO, session, new URL(authorizationUrl).searchParams.get('state')!, 'synthetic-code');
  } finally {
    world.accountFor = null;
  }
}

test('1. health SUCCESS vs disconnect: stale success is refused and writes nothing', async () => {
  const id = await world.connection();
  const health = world.gate('/2/users/get_current_account');
  const healthRun = testDropboxConnection(CEO, id);
  await health.reached;
  const { revoke, run } = await claimedDisconnect(id);
  health.release();
  await assert.rejects(healthRun, StorageConflict);
  assert.equal((await world.row(id)).status, 'disconnecting', 'not revived');
  revoke.release();
  await run;
  assert.equal((await world.row(id)).status, 'disconnected');
  assert.equal(await world.orphanedFiles(), 0);
});

test('2. health FAILURE vs disconnect: stale failure is refused and writes nothing', async () => {
  const id = await world.connection();
  const health = world.gate('/2/users/get_current_account');
  const healthRun = testDropboxConnection(CEO, id);
  await health.reached;
  const { revoke, run } = await claimedDisconnect(id);
  health.release('fail');
  await assert.rejects(healthRun, StorageConflict);
  const during = await world.row(id);
  assert.deepEqual([during.status, during.last_error_code], ['disconnecting', null], 'no stale error written');
  revoke.release();
  await run;
  assert.equal((await world.row(id)).status, 'disconnected');
});

test('3. activation vs disconnect: a disconnecting connection cannot be selected; a selected one cannot start disconnecting', async () => {
  const id = await world.connection();
  const { revoke, run } = await claimedDisconnect(id);
  await assert.rejects(selectDropbox(CEO, await world.selectionRevision(), true, id), StorageConflict);
  revoke.release();
  await run;

  const other = await world.connection();
  await selectDropbox(CEO, await world.selectionRevision(), true, other);
  await assert.rejects(disconnectDropbox(CEO, other, (await world.row(other)).revision), StorageConflict);
  assert.equal((await world.row(other)).status, 'connected');
  await world.deselect();
  assert.equal(await world.orphanedFiles(), 0);
});

test('4. upload reservation vs disconnect: no reservation lands on a disconnecting connection', async () => {
  const id = await world.connection({ select: true });
  await world.deselect();
  const { revoke, run } = await claimedDisconnect(id);
  // The selection was cleared, so re-point it straight in SQL to prove the database refuses it too.
  await assert.rejects(world.db.query('UPDATE permit.storage_selection SET connection_id = $1 WHERE singleton', [id]),
    /not connected/);
  await assert.rejects(world.db.query(`INSERT INTO permit.file_registry (provider, connection_id, logical_key, remote_path, category,
      original_filename, mime_type, size_bytes, sha256) VALUES ('dropbox', $1, 'cms/x.png', 'Digital Permit System/x.png',
      'BRANDING', 'x.png', 'image/png', 1, repeat('a', 64))`, [id]), /not connected/);
  revoke.release();
  await run;
  assert.equal(await world.orphanedFiles(), 0);
});

test('5. upload completion vs disconnect: an in-flight upload keeps its connection; disconnect waits for nothing and refuses', async () => {
  const id = await world.connection({ select: true });
  const uploadGate = world.gate('/2/files/upload');
  const uploadRun = upload('in-flight');
  await uploadGate.reached;                      // reservation committed, bytes in flight
  await world.deselect();
  await assert.rejects(disconnectDropbox(CEO, id, (await world.row(id)).revision), StorageConflict);
  uploadGate.release();
  await uploadRun;
  const row = await world.row(id);
  assert.equal(row.status, 'connected');
  assert.ok(row.credentials, 'credentials kept for the referenced file');
  assert.equal(await world.orphanedFiles(), 0);
});

test('6. reconnect vs old health response: the pre-reconnect result cannot overwrite the new revision', async () => {
  const id = await world.connection();
  const health = world.gate('/2/users/get_current_account');
  const healthRun = testDropboxConnection(CEO, id);
  await health.reached;
  const before = await world.row(id);
  await reconnect(id);
  const reconnected = await world.row(id);
  assert.equal(reconnected.revision, before.revision + 1);
  health.release('fail');
  await assert.rejects(healthRun, StorageConflict);
  const after = await world.row(id);
  assert.deepEqual([after.status, after.revision, after.last_error_code, after.credentials],
    [reconnected.status, reconnected.revision, null, reconnected.credentials]);
});

test('7. reconnect vs old revoke completion: the old disconnect cannot finalize over the reconnected credentials', async () => {
  const id = await world.connection();
  const { revoke, run } = await claimedDisconnect(id);
  await reconnect(id);
  const reconnected = await world.row(id);
  assert.equal(reconnected.status, 'connected');
  revoke.release();
  await assert.rejects(run, StorageConflict);
  const after = await world.row(id);
  assert.deepEqual([after.status, after.revision, after.credentials, after.last_error_code],
    [reconnected.status, reconnected.revision, reconnected.credentials, null]);
});

test('8. two concurrent disconnects: exactly one claims; the other is refused with no side effect', async () => {
  const id = await world.connection();
  const revision = (await world.row(id)).revision;
  const revoke = world.gate('/2/auth/token/revoke');
  const first = disconnectDropbox(CEO, id, revision);
  await revoke.reached;
  await assert.rejects(disconnectDropbox(CEO, id, revision), StorageConflict);
  revoke.release();
  await first;
  assert.equal((await world.row(id)).status, 'disconnected');
  assert.equal(world.calls.filter((c) => c === '/2/auth/token/revoke').length > 0, true);
});

test('9. disconnect with existing references is refused and audited; credentials stay', async () => {
  const id = await world.connection({ select: true });
  await upload('referenced');
  await world.deselect();
  await assert.rejects(disconnectDropbox(CEO, id, (await world.row(id)).revision), StorageConflict);
  const row = await world.row(id);
  assert.deepEqual([row.status, Boolean(row.credentials)], ['connected', true]);
  const refused = await world.db.query(`SELECT 1 FROM permit.storage_audit_events WHERE connection_id = $1 AND event_type = 'DISCONNECT_REFUSED'`, [id]);
  assert.equal(refused.rows.length, 1);
});

test('10. disconnect without references completes and is audited', async () => {
  const id = await world.connection();
  assert.deepEqual(await disconnectDropbox(CEO, id, (await world.row(id)).revision), { disconnected: true });
  const row = await world.row(id);
  assert.deepEqual([row.status, row.credentials, row.last_error_code], ['disconnected', null, null]);
  const done = await world.db.query(`SELECT 1 FROM permit.storage_audit_events WHERE connection_id = $1 AND event_type = 'DISCONNECTED'`, [id]);
  assert.equal(done.rows.length, 1);
});

test('11. lost revoke response: recoverable disconnecting state, then a retry confirms and finalizes', async () => {
  const id = await world.connection();
  const revoke = world.gate('/2/auth/token/revoke');
  const run = disconnectDropbox(CEO, id, (await world.row(id)).revision);
  await revoke.reached;
  revoke.release('lose');                      // Dropbox revoked the token, the response never arrived
  await assert.rejects(run, StorageUnavailable);
  const stuck = await world.row(id);
  assert.deepEqual([stuck.status, stuck.last_error_code, Boolean(stuck.credentials)], ['disconnecting', 'revoke_unconfirmed', true]);
  await assert.rejects(selectDropbox(CEO, await world.selectionRevision(), true, id), StorageConflict, 'never usable meanwhile');
  await assert.rejects(testDropboxConnection(CEO, id), StorageConflict);
  await disconnectDropbox(CEO, id, stuck.revision);   // the retry: Dropbox answers 401 for the revoked token
  assert.equal((await world.row(id)).status, 'disconnected');
});

test('12. revoke succeeds but local finalization fails: credentials kept, recoverable, retry finalizes', async () => {
  const id = await world.connection();
  await world.db.exec(`CREATE FUNCTION permit.test_fail_finalize() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic finalization failure'; END $$;
    CREATE TRIGGER test_fail_finalize BEFORE UPDATE ON permit.storage_connections FOR EACH ROW
    WHEN (NEW.status = 'disconnected') EXECUTE FUNCTION permit.test_fail_finalize();`);
  try {
    await assert.rejects(disconnectDropbox(CEO, id, (await world.row(id)).revision), StorageUnavailable);
  } finally {
    await world.db.exec('DROP TRIGGER test_fail_finalize ON permit.storage_connections; DROP FUNCTION permit.test_fail_finalize();');
  }
  const stuck = await world.row(id);
  assert.deepEqual([stuck.status, stuck.last_error_code, Boolean(stuck.credentials)], ['disconnecting', 'finalize_pending', true]);
  await disconnectDropbox(CEO, id, stuck.revision);
  assert.equal((await world.row(id)).status, 'disconnected');
  assert.equal(await world.orphanedFiles(), 0);
});

test('database guards hold without the application: no revival, no frozen-credential change, no clearing while referenced', async () => {
  const id = await world.connection({ select: true });
  await upload('guarded');
  await world.deselect();
  // Clearing credentials of a referenced connection is refused whatever the caller.
  await assert.rejects(world.db.query(`UPDATE permit.storage_connections SET credentials = NULL, account_id = NULL,
    status = 'disconnected' WHERE id = $1`, [id]), /credentials may be cleared only/);
  await assert.rejects(world.db.query(`UPDATE permit.storage_connections SET status = 'disconnecting' WHERE id = $1`, [id]),
    /cannot start disconnecting/);

  const free = await world.connection();
  await world.db.query(`UPDATE permit.storage_connections SET status = 'disconnecting', revision = revision + 1 WHERE id = $1`, [free]);
  await assert.rejects(world.db.query(`UPDATE permit.storage_connections SET status = 'connected' WHERE id = $1`, [free]),
    /without a new revision/);
  await assert.rejects(world.db.query(`UPDATE permit.storage_connections SET credentials = 'x' WHERE id = $1`, [free]),
    /frozen/);
  assert.equal(await world.orphanedFiles(), 0);
});
