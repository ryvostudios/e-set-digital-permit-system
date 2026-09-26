import '../test/syntheticDropboxEnv.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import sharp from 'sharp';
import { CmsUploadConflict, MAX_UNFINISHED_UPLOADS, uploadAsset } from '../domain/cms/cms.js';
import { CEO, LifecycleWorld } from '../test/storageLifecycleHarness.js';
import { disconnectDropbox } from './admin.js';
import { ManagedStorageUnavailable, productionReconcileDeps, reconcileStaleManagedFiles } from './managedFiles.js';

/**
 * A03 (pre-production audit): a retried CMS upload resumes its own
 * reservation instead of leaving the first pending and creating a second.
 * Real `permit` schema and upload path; Dropbox is the barrier-controlled fake.
 */

const world = new LifecycleWorld();
const OTHER = '73000000-0000-4000-8000-000000000002';
let connectionId = '';

before(async () => {
  await world.start();
  await world.db.query(`INSERT INTO permit.users (id, email) VALUES ($1, 'other.editor@example.test')`, [OTHER]);
});
after(() => world.stop());
beforeEach(async () => {
  await world.deselect();
  connectionId = await world.connection({ select: true });
});

const image = (colour: string) => sharp({ create: { width: 300, height: 100, channels: 3, background: colour } }).png().toBuffer();
const send = async (requestId: string, options: { actor?: string; label?: string; colour?: string } = {}) => uploadAsset(
  options.actor ?? CEO,
  { requestId, purpose: 'PDF_LOGO', label: options.label ?? 'Logo', declaredMime: 'image/png', bytes: await image(options.colour ?? '#123456') });
const registry = async () => (await world.db.query<{ id: string; state: string; logical_key: string }>(
  'SELECT id, state, logical_key FROM permit.file_registry WHERE connection_id = $1 ORDER BY created_at', [connectionId])).rows;
const assets = async () => (await world.db.query<{ n: number }>(
  `SELECT count(*)::int AS n FROM permit.cms_logo_assets a JOIN permit.file_registry f ON f.id = a.file_id
    WHERE f.connection_id = $1`, [connectionId])).rows[0]!.n;

test('failure before the remote write: the retry resumes the same reservation', async () => {
  const requestId = randomUUID();
  world.failNext.set('/2/files/upload', 1);
  await assert.rejects(send(requestId), ManagedStorageUnavailable);
  const pending = await registry();
  assert.deepEqual(pending.map((f) => f.state), ['pending']);
  const { id } = await send(requestId);
  const after = await registry();
  assert.deepEqual(after.map((f) => [f.id, f.state]), [[pending[0]!.id, 'ready']], 'one reservation, now ready');
  assert.equal(await assets(), 1);
  assert.ok(id);
});

test('the remote write succeeded but its response was lost: the retry recognises the stored bytes', async () => {
  const requestId = randomUUID();
  const gate = world.gate('/2/files/upload');
  const first = send(requestId);
  await gate.reached;
  gate.release('lose');
  await assert.rejects(first, ManagedStorageUnavailable);
  const remoteBefore = world.files.size;
  await send(requestId);
  assert.equal(world.files.size, remoteBefore, 'no second remote file');
  assert.deepEqual((await registry()).map((f) => f.state), ['ready']);
  assert.equal(await assets(), 1);
});

test('the database finalization failed: the retry creates the asset exactly once', async () => {
  const requestId = randomUUID();
  await world.db.exec(`CREATE FUNCTION permit.test_fail_asset() RETURNS trigger LANGUAGE plpgsql AS
    $$ BEGIN RAISE EXCEPTION 'synthetic finalization failure'; END $$;
    CREATE TRIGGER test_fail_asset BEFORE INSERT ON permit.cms_logo_assets FOR EACH ROW EXECUTE FUNCTION permit.test_fail_asset();`);
  try {
    await assert.rejects(send(requestId));
  } finally {
    await world.db.exec('DROP TRIGGER test_fail_asset ON permit.cms_logo_assets; DROP FUNCTION permit.test_fail_asset();');
  }
  assert.deepEqual((await registry()).map((f) => f.state), ['ready'], 'the bytes are stored and verified');
  assert.equal(await assets(), 0);
  await send(requestId);
  assert.equal(await assets(), 1);
  assert.equal((await registry()).length, 1);
});

test('an exact retry after success returns the same asset and stores nothing new', async () => {
  const requestId = randomUUID();
  const first = await send(requestId);
  const remote = world.files.size;
  assert.deepEqual(await send(requestId), first);
  assert.equal(world.files.size, remote);
  assert.equal((await registry()).length, 1);
  assert.equal(await assets(), 1);
});

test('concurrent duplicates of one request create one reservation, one remote file and one asset', async () => {
  const requestId = randomUUID();
  const gate = world.gate('/2/files/upload');
  const first = send(requestId);
  await gate.reached;                  // first holds the reservation, bytes in flight
  const second = await send(requestId); // the duplicate resumes the same reservation and finishes
  gate.release();
  assert.deepEqual(await first, second);
  assert.equal((await registry()).length, 1);
  assert.equal(await assets(), 1);
});

test('the same request id with a different image or label is refused', async () => {
  const requestId = randomUUID();
  await send(requestId);
  await assert.rejects(send(requestId, { colour: '#654321' }), CmsUploadConflict);
  await assert.rejects(send(requestId, { label: 'Other' }), CmsUploadConflict);
  assert.equal(await assets(), 1);
});

test("a request id is scoped to its user: another user's identical id is an independent request", async () => {
  const requestId = randomUUID();
  const mine = await send(requestId);
  const theirs = await send(requestId, { actor: OTHER, colour: '#abcdef' });
  assert.notEqual(theirs.id, mine.id);
  assert.equal(await assets(), 2);
  const rows = (await world.db.query('SELECT actor_user_id FROM permit.managed_upload_requests WHERE request_id = $1', [requestId])).rows;
  assert.equal(rows.length, 2);
});

test('unfinished uploads per user are bounded', async () => {
  world.failNext.set('/2/files/upload', MAX_UNFINISHED_UPLOADS);
  for (let i = 0; i < MAX_UNFINISHED_UPLOADS; i += 1) {
    await assert.rejects(send(randomUUID(), { colour: `#0000${(16 + i).toString(16).padStart(2, '0')}` }), ManagedStorageUnavailable);
  }
  await assert.rejects(send(randomUUID()), CmsUploadConflict);
});

test('later disconnect: an abandoned reservation blocks it until reconciliation proves nothing was stored', async () => {
  // OTHER, not CEO: the bound test above deliberately left CEO at the limit.
  const requestId = randomUUID();
  world.failNext.set('/2/files/upload', 1);
  await assert.rejects(send(requestId, { actor: OTHER }), ManagedStorageUnavailable);
  await world.deselect();
  await assert.rejects(disconnectDropbox(CEO, connectionId, (await world.row(connectionId)).revision), /referenced/);

  const deps = { ...productionReconcileDeps };
  const dry = await reconcileStaleManagedFiles({ olderThanMinutes: 0, dryRun: true }, deps);
  assert.ok(dry.released >= 1);
  assert.deepEqual((await registry()).map((f) => f.state), ['pending'], 'dry run changes nothing');

  const done = await reconcileStaleManagedFiles({ olderThanMinutes: 0, dryRun: false }, deps);
  assert.ok(done.released >= 1);
  assert.deepEqual((await registry()).map((f) => f.state), ['cleanup_pending']);
  await assert.rejects(send(requestId, { actor: OTHER }), CmsUploadConflict, 'the released request has expired');
  assert.deepEqual(await disconnectDropbox(CEO, connectionId, (await world.row(connectionId)).revision), { disconnected: true });
  assert.equal(await world.orphanedFiles(), 0);
});

test('reconciliation completes a reservation whose bytes did reach Dropbox', async () => {
  const requestId = randomUUID();
  const gate = world.gate('/2/files/upload');
  const first = send(requestId, { actor: OTHER });
  await gate.reached;
  gate.release('lose');
  await assert.rejects(first, ManagedStorageUnavailable);
  const report = await reconcileStaleManagedFiles({ olderThanMinutes: 0, dryRun: false }, productionReconcileDeps);
  assert.ok(report.completed >= 1);
  assert.deepEqual((await registry()).map((f) => f.state), ['ready']);
  await send(requestId, { actor: OTHER });             // the request then finishes on the same file
  assert.equal(await assets(), 1);
  assert.equal((await registry()).length, 1);
});
