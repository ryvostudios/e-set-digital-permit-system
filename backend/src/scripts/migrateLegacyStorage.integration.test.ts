import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import type { QueryFn } from '../db/pool.js';
import { importStandalone } from '../db/standaloneImport.js';
import type { DocumentStorageAdapter } from '../domain/permits/documents.js';
import { activeConnection } from '../storage/connections.js';
import { PermitDocumentStorage } from '../storage/documentStorage.js';
import { dropboxContentHash, DropboxHttp, DropboxProvider } from '../storage/dropbox.js';
import { historicalDatabase, installedDatabase } from '../test/permitSchemaFixtures.js';
import { markLegacyDocumentsGenerated, produceStandaloneHistory } from '../test/standaloneHistory.js';
import { migrateLegacyDocuments, verifyMigratedDocuments } from './migrateLegacyStorage.js';

/**
 * Legacy Supabase Storage -> Permit Dropbox, end to end: the standalone
 * history (every document job GENERATED at its legacy key) imported into
 * the shared `permit` schema, the REAL registry and PermitDocumentStorage,
 * the REAL DropboxProvider (mode "add", 409 -> metadata -> content-hash
 * check) over an in-memory Dropbox, and a fake legacy bucket. No network.
 */

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let target: PGlite;
let legacyObjects: Map<string, Buffer>;
let pristineLegacy: string;
let jobs: { id: string; storage_path: string; file_hash: string }[];
const legacyCalls = { uploads: 0, deletes: 0 };

/** In-memory Dropbox with fault injection, speaking the real HTTP shapes. */
const dropbox = {
  folders: new Set<string>(),
  files: new Map<string, { id: string; bytes: Buffer }>(),
  failBeforeStore: new Set<string>(),
  loseResponseAfterStore: new Set<string>(),
  byId(id: string) { return [...this.files.values()].find((f) => f.id === id); },
};
function reply(status: number, body: unknown): Response {
  return new Response(Buffer.isBuffer(body) ? body : JSON.stringify(body), { status });
}
const transport = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  const args = headers.get('Dropbox-API-Arg') ? JSON.parse(headers.get('Dropbox-API-Arg')!) : JSON.parse(String(init?.body ?? 'null'));
  const fileMeta = (f: { id: string; bytes: Buffer }) => ({ '.tag': 'file', id: f.id, size: f.bytes.length, content_hash: dropboxContentHash(f.bytes) });
  switch (url.pathname) {
    case '/2/files/create_folder_v2':
      if (dropbox.folders.has(args.path)) return reply(409, { error: { path: { '.tag': 'conflict' } } });
      dropbox.folders.add(args.path);
      return reply(200, { metadata: { '.tag': 'folder' } });
    case '/2/files/get_metadata': {
      if (dropbox.folders.has(args.path)) return reply(200, { '.tag': 'folder' });
      const file = args.path.startsWith('id:') ? dropbox.byId(args.path) : dropbox.files.get(args.path);
      return file ? reply(200, fileMeta(file)) : reply(409, { error: { path: { '.tag': 'not_found' } } });
    }
    case '/2/files/upload': {
      const bytes = Buffer.from(init!.body as Uint8Array);
      if (dropbox.failBeforeStore.delete(args.path)) throw new TypeError('synthetic network failure');
      if (dropbox.files.has(args.path)) return reply(409, { error: { reason: { '.tag': 'conflict' } } });
      const file = { id: `id:${randomUUID().replaceAll('-', '')}`, bytes };
      dropbox.files.set(args.path, file);
      if (dropbox.loseResponseAfterStore.delete(args.path)) return reply(503, {});
      return reply(200, fileMeta(file));
    }
    case '/2/files/download': {
      const file = dropbox.byId(args.path);
      return file ? reply(200, file.bytes) : reply(409, { error: { path: { '.tag': 'not_found' } } });
    }
    default:
      return reply(400, {});
  }
}) as typeof fetch;

const legacy: DocumentStorageAdapter = {
  async upload() { legacyCalls.uploads += 1; return { ok: false, code: 'STORAGE_UPLOAD_FAILED' }; },
  async download(path) {
    const bytes = legacyObjects.get(path);
    return bytes ? { ok: true, data: Buffer.from(bytes) } : { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' };
  },
};

let q: QueryFn;
let storage: PermitDocumentStorage;
const run = (dryRun: boolean) => migrateLegacyDocuments({ dryRun, batchSize: 2 }, { query: q, legacy, target: storage });
const registry = async () => (await target.query<{ document_job_id: string; state: string; sha256: string; size_bytes: string; remote_path: string }>(
  'SELECT document_job_id::text, state, sha256, size_bytes::text, remote_path FROM permit.file_registry ORDER BY document_job_id')).rows;

before(async () => {
  const source = await historicalDatabase();
  const fixture = { query: (t: string, p?: unknown[]) => source.query(t, p), exec: (s: string) => source.exec(s) };
  await produceStandaloneHistory(fixture);
  legacyObjects = await markLegacyDocumentsGenerated(fixture);
  pristineLegacy = sha(Buffer.from([...legacyObjects].map(([k, v]) => `${k}:${sha(v)}`).sort().join('\n')));
  target = await installedDatabase({ baselineReferenceData: false });
  q = ((text: string, params?: unknown[]) => target.query(text, params)) as unknown as QueryFn;
  await target.exec('SET ROLE permit_migrator; SET search_path = pg_catalog, permit, pg_temp');
  const imported = await importStandalone({ source: ((t: string, p?: unknown[]) => source.query(t, p)) as unknown as QueryFn, target: q }, { mode: 'execute' });
  await target.exec('RESET ROLE; SET search_path = pg_catalog');
  await source.close();
  assert.equal(imported.ok, true, JSON.stringify(imported.report.problems));

  const connectionId = randomUUID();
  await target.query(`INSERT INTO permit.storage_connections (id, provider, status, account_id, account_label, credentials)
    VALUES ($1, 'dropbox', 'connected', 'dbid:synthetic', 'Synthetic', 'sealed-elsewhere')`, [connectionId]);
  await target.query('UPDATE permit.storage_selection SET connection_id = $1 WHERE singleton', [connectionId]);
  storage = new PermitDocumentStorage(null, {
    query: q,
    withTransaction: async <T>(fn: (client: PoolClient) => Promise<T>) =>
      target.transaction(async (tx) => fn({ query: tx.query.bind(tx) } as unknown as PoolClient)),
    active: activeConnection,
    client: async () => new DropboxProvider('synthetic-token', new DropboxHttp(transport)),
  });
  jobs = (await target.query<{ id: string; storage_path: string; file_hash: string }>(
    `SELECT id::text, storage_path, file_hash FROM permit.permit_document_jobs WHERE status = 'GENERATED' ORDER BY id`)).rows;
  assert.ok(jobs.length >= 4, `enough generated jobs (${jobs.length})`);
});

after(async () => { await target?.close(); });

test('dry run reads and verifies every legacy object and writes nothing anywhere', async () => {
  const report = await run(true);
  assert.equal(report.examined, jobs.length);
  assert.equal(report.outcomes.would_copy, jobs.length);
  assert.deepEqual(await registry(), []);
  assert.equal(dropbox.files.size, 0);
});

test('execute with a missing source, a network failure and a lost response: the rest copy, problems are reported', async () => {
  const [missing, networkFail, lostResponse] = jobs;
  const missingBytes = legacyObjects.get(missing!.storage_path)!;
  legacyObjects.delete(missing!.storage_path);
  const remotePathOf = async (jobId: string) => (await registry()).find((r) => r.document_job_id === jobId)?.remote_path;
  // Faults are armed by the pinned remote path the registry will reserve.
  const original = storage.upload.bind(storage);
  storage.upload = async (key, data, type, context) => {
    const reserved = await remotePathOf(context!.documentJobId);
    if (!reserved) {
      const years = new Date(context!.issuedAt).getUTCFullYear();
      const path = `/Digital Permit System/Permits/${years}/${context!.permitNumber}/Issued/${context!.permitNumber}-${context!.documentJobId}.pdf`;
      if (context!.documentJobId === networkFail!.id) dropbox.failBeforeStore.add(path);
      if (context!.documentJobId === lostResponse!.id) dropbox.loseResponseAfterStore.add(path);
    }
    return original(key, data, type, context);
  };
  const report = await run(false);
  storage.upload = original;
  legacyObjects.set(missing!.storage_path, missingBytes);

  assert.equal(report.outcomes.source_unavailable, 1);
  assert.equal(report.outcomes.copy_failed, 2);
  assert.equal(report.outcomes.copied, jobs.length - 3);
  assert.deepEqual(report.attention.map((a) => a.jobId).sort(), [missing!.id, networkFail!.id, lostResponse!.id].sort());
  const rows = await registry();
  assert.deepEqual(rows.filter((r) => r.state === 'pending').map((r) => r.document_job_id).sort(),
    [networkFail!.id, lostResponse!.id].sort(), 'failed uploads keep their pinned reservation');
  assert.ok(!rows.some((r) => r.document_job_id === missing!.id), 'nothing reserved for a missing source');
});

test('resume: two runs at once complete the remaining jobs once each; a third run has nothing to do', async () => {
  const [a, b] = await Promise.all([run(false), run(false)]);
  // Overlapping runs may both pick a job; each then verifies the one shared
  // copy by reading it back, so a job can be reported by both - the effect
  // (registry row, remote file) is single, checked below.
  assert.ok(a.outcomes.copied <= 3 && b.outcomes.copied <= 3 && a.outcomes.copied + b.outcomes.copied >= 3);
  assert.equal(a.outcomes.copy_failed + b.outcomes.copy_failed, 0);
  const rows = await registry();
  assert.equal(rows.length, jobs.length, 'one registry row per job (document_job_id is unique)');
  assert.ok(rows.every((r) => r.state === 'ready'));
  assert.equal(dropbox.files.size, jobs.length, 'the lost-response upload was reused, not duplicated');
  assert.equal((await run(false)).examined, 0, 'idempotent');
});

test('registry, remote bytes and downloads reconcile with every pinned hash; the source is untouched', async () => {
  const rows = new Map((await registry()).map((r) => [r.document_job_id, r]));
  for (const job of jobs) {
    const row = rows.get(job.id)!;
    assert.equal(row.sha256, job.file_hash);
    assert.equal(Number(row.size_bytes), legacyObjects.get(job.storage_path)!.length);
    assert.equal(sha(dropbox.files.get(`/${row.remote_path}`)!.bytes), job.file_hash);
    const download = await storage.download(job.storage_path);
    assert.ok(download.ok && sha(download.data) === job.file_hash, 'the logical key now reads the verified Dropbox copy');
  }
  assert.equal(sha(Buffer.from([...legacyObjects].map(([k, v]) => `${k}:${sha(v)}`).sort().join('\n'))), pristineLegacy);
  assert.deepEqual(legacyCalls, { uploads: 0, deletes: 0 });
  assert.deepEqual(await verifyMigratedDocuments({ query: q, target: storage }), { examined: jobs.length, verified: jobs.length, mismatched: [] });
});

test('a destination altered after the copy is detected by --verify and is never served', async () => {
  const job = jobs.at(-1)!;
  const row = (await registry()).find((r) => r.document_job_id === job.id)!;
  const remote = dropbox.files.get(`/${row.remote_path}`)!;
  const original = remote.bytes;
  remote.bytes = Buffer.concat([original, Buffer.from('tampered')]);
  try {
    const report = await verifyMigratedDocuments({ query: q, target: storage });
    assert.deepEqual(report.mismatched, [job.id]);
    const download = await storage.download(job.storage_path);
    assert.equal(download.ok, false);
    assert.equal(download.ok ? '' : download.code, 'STORAGE_INTEGRITY_MISMATCH');
  } finally {
    remote.bytes = original;
  }
});
