import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryFn } from '../db/pool.js';
import { computeFileHash, type DocumentStorageAdapter } from '../domain/permits/documents.js';
import { migrateLegacyDocuments } from './migrateLegacyStorage.js';

/**
 * The offline legacy-storage copy, against fakes only: a legacy bucket, a
 * Permit Dropbox target, and a registry that remembers which jobs are copied.
 */

const pdf = (label: string) => Buffer.from(`%PDF-1.7\n${label}`);

function world(files: Record<string, Buffer>, options: { corrupt?: string; failCopy?: string; failOnce?: string } = {}) {
  const jobs = Object.entries(files).map(([path, bytes], index) => ({
    id: `8${index}000000-0000-4000-8000-000000000001`,
    storage_path: path,
    file_hash: computeFileHash(bytes),
    permit_id: `81000000-0000-4000-8000-00000000000${index}`,
    jsa_id: '82000000-0000-4000-8000-000000000001',
    permit_number: `WTG-2026-00${index}`,
    issued_at: '2026-09-25T08:00:00.000Z',
    actor_user_id: '83000000-0000-4000-8000-000000000001',
  }));
  const copied = new Map<string, Buffer>();
  const legacyDeletes: string[] = [];
  const failedOnce = new Set<string>();
  const query = (async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM permit.permit_document_jobs')) {
      const [after, limit] = params as [string, number];
      return {
        rows: jobs
          .filter((job) => job.id > after && !copied.has(job.storage_path))
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit),
      };
    }
    throw new Error(`unexpected query ${sql}`);
  }) as unknown as QueryFn;
  const legacy: DocumentStorageAdapter & { remove?: (path: string) => void } = {
    async upload() { return { ok: false, code: 'STORAGE_UPLOAD_FAILED' }; },
    async download(path) {
      const bytes = files[path];
      if (!bytes) return { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' };
      return { ok: true, data: path === options.corrupt ? Buffer.concat([bytes, Buffer.from('!')]) : bytes };
    },
    remove(path: string) { legacyDeletes.push(path); },
  };
  const target: DocumentStorageAdapter = {
    async upload(path, data) {
      if (path === options.failCopy) return { ok: false, code: 'STORAGE_UPLOAD_FAILED' };
      if (path === options.failOnce && !failedOnce.has(path)) {
        failedOnce.add(path);
        return { ok: false, code: 'STORAGE_UPLOAD_FAILED' };
      }
      copied.set(path, Buffer.from(data));
      return { ok: true, reference: `file:${path}` };
    },
    async download(reference) {
      const bytes = copied.get(reference.replace(/^file:/, ''));
      return bytes ? { ok: true, data: bytes } : { ok: false, code: 'STORAGE_DOWNLOAD_FAILED' };
    },
  };
  return { query, legacy, target, copied, legacyDeletes, jobs };
}

const files = {
  'permits/a/1.pdf': pdf('one'),
  'permits/b/2.pdf': pdf('two'),
  'permits/c/3.pdf': pdf('three'),
};

test('dry run reads and verifies every legacy document but copies nothing', async () => {
  const w = world(files);
  const report = await migrateLegacyDocuments({ dryRun: true, batchSize: 2 }, w);
  assert.equal(report.examined, 3);
  assert.equal(report.outcomes.would_copy, 3);
  assert.equal(w.copied.size, 0);
  assert.deepEqual(w.legacyDeletes, []);
});

test('execute copies each verified document, confirms it by reading back, and never deletes the source', async () => {
  const w = world(files);
  const report = await migrateLegacyDocuments({ dryRun: false, batchSize: 2 }, w);
  assert.equal(report.outcomes.copied, 3);
  for (const [path, bytes] of Object.entries(files)) assert.ok(w.copied.get(path)?.equals(bytes));
  assert.deepEqual(w.legacyDeletes, [], 'non-destructive');
  // Idempotent: a second run finds nothing left to do.
  const again = await migrateLegacyDocuments({ dryRun: false }, w);
  assert.equal(again.examined, 0);
});

test('a source whose bytes do not match the pinned file hash is flagged and never copied', async () => {
  const w = world(files, { corrupt: 'permits/b/2.pdf' });
  const report = await migrateLegacyDocuments({ dryRun: false }, w);
  assert.equal(report.outcomes.checksum_mismatch, 1);
  assert.equal(w.copied.has('permits/b/2.pdf'), false);
  assert.deepEqual(report.attention.map((entry) => entry.outcome), ['checksum_mismatch']);
  assert.doesNotMatch(JSON.stringify(report), /permits\/|%PDF/, 'the report names jobs, never paths or bytes');
});

test('an interrupted copy is reported, and the next run resumes and completes it', async () => {
  const w = world(files, { failOnce: 'permits/c/3.pdf' });
  const first = await migrateLegacyDocuments({ dryRun: false }, w);
  assert.equal(first.outcomes.copied, 2);
  assert.equal(first.outcomes.copy_failed, 1);
  const second = await migrateLegacyDocuments({ dryRun: false }, w);
  assert.equal(second.examined, 1);
  assert.equal(second.outcomes.copied, 1);
  assert.equal(w.copied.size, 3);
});

test('a missing legacy object is reported, not guessed at', async () => {
  const w = world(files);
  w.jobs.push({ ...w.jobs[0]!, id: '89000000-0000-4000-8000-000000000001', storage_path: 'permits/gone/9.pdf' });
  const report = await migrateLegacyDocuments({ dryRun: true }, w);
  assert.equal(report.outcomes.source_unavailable, 1);
});
