import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { PermitDocumentStorage, type StorageDeps } from './documentStorage.js';
import type { StorageConnectionRow } from './connections.js';

const connection: StorageConnectionRow = {
  id: '91000000-0000-4000-8000-000000000001', provider: 'dropbox', status: 'connected',
  account_id: 'dbid:synthetic', account_label: 'Synthetic account', credentials: 'encrypted-only',
  revision: 1, token_revision: 1, last_health_at: new Date().toISOString(), last_error_code: null,
};
const fileId = '92000000-0000-4000-8000-000000000001';
const jobId = '93000000-0000-4000-8000-000000000001';
const permitId = '94000000-0000-4000-8000-000000000001';
const snapshotId = '95000000-0000-4000-8000-000000000001';
const logicalKey = `permits/${permitId}/${snapshotId}.pdf`;
const bytes = Buffer.from('%PDF-1.7\nsynthetic document');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const context = { documentJobId: jobId, permitId,
  jsaId: '96000000-0000-4000-8000-000000000001', permitNumber: 'WTG-2026-001',
  issuedAt: '2026-09-25T00:00:00.000Z', actorUserId: '97000000-0000-4000-8000-000000000001' };

function fixture(options: { selected?: boolean; account?: string; remote?: Buffer; uploadFails?: boolean;
  registryFails?: boolean; initialState?: 'pending' | 'ready' } = {}) {
  const calls: string[] = [];
  const remote = options.remote ?? bytes;
  let file: Record<string, unknown> | null = options.initialState ? {
    id: fileId, provider: 'dropbox', connection_id: connection.id, logical_key: logicalKey,
    remote_path: `Digital Permit System/Permits/2026/WTG-2026-001/Issued/WTG-2026-001-${jobId}.pdf`,
    remote_id: options.initialState === 'ready' ? 'id:synthetic' : null,
    state: options.initialState, size_bytes: String(bytes.length), sha256, document_job_id: jobId,
  } : null;
  const rows = async (sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    calls.push(sql);
    if (sql.includes('JOIN permit.storage_connections')) return { rows: options.selected === false ? [] : [connection as unknown as Record<string, unknown>] };
    if (sql.includes('FROM permit.storage_selection') && sql.includes('FOR UPDATE')) return { rows: [{ connection_id: connection.id }] };
    if (sql.includes('FROM permit.file_registry WHERE document_job_id')) return { rows: file ? [file] : [] };
    if (sql.includes('FROM permit.storage_connections WHERE id=')) return { rows: [connection as unknown as Record<string, unknown>] };
    if (sql.startsWith('INSERT INTO permit.file_registry')) {
      if (options.registryFails) throw new Error('synthetic DB write failure');
      file = { id: fileId, provider: 'dropbox', connection_id: connection.id, logical_key: logicalKey,
        remote_path: params[2], remote_id: null, state: 'pending', size_bytes: String(bytes.length),
        sha256, document_job_id: jobId };
      return { rows: [file] };
    }
    if (sql.startsWith('UPDATE permit.file_registry')) {
      if (options.registryFails) throw new Error('synthetic DB finalize failure');
      if (file) file = { ...file, remote_id: params[1], state: 'ready' };
      return { rows: [] };
    }
    if (sql.includes('FROM permit.file_registry WHERE id=')) return { rows: file ? [file] : [] };
    if (sql.includes('FROM permit.file_registry WHERE logical_key=')) return { rows: file ? [file] : [] };
    throw new Error(`Unexpected fake query: ${sql}`);
  };
  const deps: StorageDeps = {
    query: rows as StorageDeps['query'],
    withTransaction: async work => work({ query: rows } as unknown as PoolClient),
    active: async () => options.selected === false ? null : connection,
    client: async () => ({
      account: async () => ({ id: options.account ?? connection.account_id!, label: 'Synthetic account' }),
      ensureRoot: async () => { calls.push('ensureRoot'); },
      upload: async () => { calls.push('remoteUpload'); if (options.uploadFails) throw new Error('synthetic upload failure'); return 'id:synthetic'; },
      metadata: async () => ({ id: 'id:synthetic' }),
      download: async () => remote,
    }),
  };
  return { storage: new PermitDocumentStorage(null, deps), calls, get file() { return file; } };
}

test('readiness checks selected account and root without trusting only a database row', async () => {
  assert.deepEqual(await fixture({ selected: false }).storage.preflight(), { ok: false, code: 'STORAGE_NOT_CONFIGURED' });
  assert.deepEqual(await fixture({ account: 'dbid:other' }).storage.preflight(), { ok: false, code: 'STORAGE_PREFLIGHT_FAILED' });
  assert.deepEqual(await fixture().storage.preflight(), { ok: true });
});

test('issued PDF reserves the pinned file row before remote upload and returns only an opaque reference', async () => {
  const state = fixture();
  assert.deepEqual(await state.storage.upload(logicalKey, bytes, 'application/pdf', context),
    { ok: true, reference: `file:${fileId}` });
  assert.ok(state.calls.findIndex(call => call.startsWith('INSERT INTO permit.file_registry')) < state.calls.indexOf('remoteUpload'));
  assert.equal(state.file?.state, 'ready');
  assert.deepEqual(await state.storage.download(`file:${fileId}`),
    { ok: true, data: bytes, reference: `file:${fileId}` });
});

test('failed remote upload leaves a pinned pending reservation for safe retry', async () => {
  const state = fixture({ uploadFails: true });
  assert.deepEqual(await state.storage.upload(logicalKey, bytes, 'application/pdf', context),
    { ok: false, code: 'STORAGE_UPLOAD_FAILED' });
  assert.equal(state.file?.state, 'pending');
  assert.equal(state.file?.remote_id, null);
});

test('provider success followed by DB finalize failure never reports a completed document', async () => {
  const state = fixture({ registryFails: true, initialState: 'pending' });
  assert.deepEqual(await state.storage.upload(logicalKey, bytes, 'application/pdf', context),
    { ok: false, code: 'STORAGE_UPLOAD_FAILED' });
  assert.equal(state.file?.state, 'pending');
});

test('ambiguous pending upload can be recovered only after remote bytes match pinned size and SHA-256', async () => {
  const good = fixture({ initialState: 'pending' });
  assert.deepEqual(await good.storage.download(logicalKey),
    { ok: true, data: bytes, reference: `file:${fileId}` });
  assert.equal(good.file?.state, 'ready');
  const bad = fixture({ initialState: 'pending', remote: Buffer.from('%PDF-1.7\nchanged') });
  assert.deepEqual(await bad.storage.download(logicalKey), { ok: false, code: 'STORAGE_INTEGRITY_MISMATCH' });
  assert.equal(bad.file?.state, 'pending');
});

test('registered download refuses altered bytes and invalid IDs without calling Dropbox', async () => {
  const state = fixture({ initialState: 'ready', remote: Buffer.from('%PDF-1.7\nchanged') });
  assert.deepEqual(await state.storage.download(`file:${fileId}`), { ok: false, code: 'STORAGE_INTEGRITY_MISMATCH' });
  const before = state.calls.length;
  assert.deepEqual(await state.storage.download('file:../../secrets'), { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' });
  assert.equal(state.calls.length, before);
});
