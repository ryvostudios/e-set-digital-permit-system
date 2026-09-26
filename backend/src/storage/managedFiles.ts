import type { PoolClient } from 'pg';
import { query, withTransaction, type QueryFn } from '../db/pool.js';
import { connectionClient, type StorageConnectionRow } from './connections.js';
import { sha256Hex } from './crypto.js';
import { DropboxError, type DropboxProvider } from './dropbox.js';
import { filePath } from './paths.js';

/**
 * Permit-managed files other than issued permit PDFs - today the CMS
 * branding images. Same contract as issued documents
 * (storage/documentStorage.ts):
 *
 *   * a `permit.file_registry` row is reserved BEFORE any network I/O and
 *     pins the connection and deterministic remote path, so a retried or
 *     ambiguous upload can never land somewhere else;
 *   * the upload is verified against Dropbox's own content hash, and every
 *     read is verified against the registry's SHA-256 before a byte is used;
 *   * new files go to the ACTIVE connection; an existing file is always
 *     read from the connection it was written to.
 *
 * Dropbox holds the bytes. PostgreSQL holds everything that decides what
 * the bytes are for (CMS configuration, the registry, audit).
 */

type ManagedCategory = 'BRANDING' | 'CMS_ASSET';
type StorageClient = Pick<DropboxProvider, 'upload' | 'download'>;

export interface ManagedFileDeps {
  query: QueryFn;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  client: (connection: StorageConnectionRow) => Promise<StorageClient>;
}

const productionDeps: ManagedFileDeps = {
  query,
  withTransaction,
  client: (connection) => connectionClient(connection, query, true),
};

export class ManagedStorageUnavailable extends Error {}

export interface StoredFile {
  id: string;
  sha256: string;
  sizeBytes: number;
}

export class ManagedStorageConflict extends Error {}

/**
 * Stores bytes under a caller-supplied, stable `identity` (A03: the id of the
 * managed upload request). The registry row for that identity is the unit of
 * work, so a retry resumes it instead of creating another:
 *
 *   * no row yet: reserve one on the ACTIVE connection, before any I/O;
 *   * `pending`: resume on the connection and remote path it pinned (an
 *     upload whose response was lost is recognised by Dropbox's content hash
 *     through the provider's conflict handling, never re-created elsewhere);
 *   * `ready`: return it;
 *   * `cleanup_pending`: reconciliation proved nothing was stored and
 *     released the reservation; the request is expired (use a new one).
 *
 * The same identity with different bytes is a conflict, never an overwrite.
 */
export async function storeManagedFile(
  input: {
    identity: string;
    category: ManagedCategory;
    bytes: Buffer;
    mimeType: 'image/png';
    originalFilename: string;
    createdBy: string;
  },
  deps: ManagedFileDeps = productionDeps,
): Promise<StoredFile> {
  if (input.bytes.length === 0 || input.bytes.length > 2 * 1024 * 1024 || !/^[0-9a-f-]{36}$/.test(input.identity)) {
    throw new ManagedStorageUnavailable('Invalid file');
  }
  const sha256 = sha256Hex(input.bytes);
  const logicalKey = `cms/${input.identity}.png`;
  const reserved = await deps.withTransaction(async (db) => {
    const existing = (await db.query<{ id: string; connection_id: string; remote_path: string; state: string; sha256: string; size_bytes: string }>(
      `SELECT id, connection_id, remote_path, state, sha256, size_bytes::text AS size_bytes
         FROM permit.file_registry WHERE provider = 'dropbox' AND logical_key = $1
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [logicalKey])).rows[0];
    if (existing) {
      if (existing.sha256 !== sha256 || Number(existing.size_bytes) !== input.bytes.length) {
        throw new ManagedStorageConflict('A different file was already stored for this request');
      }
      if (existing.state === 'cleanup_pending') throw new ManagedStorageConflict('This upload request has expired');
      if (existing.state === 'ready') return { fileId: existing.id, connection: null, remotePath: existing.remote_path };
      const pinned = (await db.query<StorageConnectionRow>(
        'SELECT * FROM permit.storage_connections WHERE id = $1 FOR UPDATE', [existing.connection_id])).rows[0];
      if (!pinned || pinned.status !== 'connected' || !pinned.credentials) return null;
      return { fileId: existing.id, connection: pinned, remotePath: existing.remote_path };
    }
    const selected = await db.query<StorageConnectionRow>(
      `SELECT c.* FROM permit.storage_selection s
         JOIN permit.storage_connections c ON c.id = s.connection_id
        WHERE s.singleton = true FOR UPDATE OF c`);
    const connection = selected.rows[0];
    if (!connection || connection.status !== 'connected' || !connection.credentials) return null;
    const remotePath = filePath({ category: input.category, identity: input.identity, extension: 'png' });
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO permit.file_registry
         (provider, connection_id, logical_key, remote_path, category, original_filename, mime_type,
          size_bytes, sha256, created_by)
       VALUES ('dropbox', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [connection.id, logicalKey, remotePath, input.category,
        input.originalFilename.slice(0, 200) || 'image.png', input.mimeType, input.bytes.length, sha256, input.createdBy]);
    return { fileId: inserted.rows[0]!.id, connection, remotePath };
  });
  if (!reserved) throw new ManagedStorageUnavailable('Permit storage is not connected');
  if (reserved.connection) {
    try {
      const client = await deps.client(reserved.connection);
      const remoteId = await client.upload(reserved.remotePath, input.bytes);
      await deps.query(
        `UPDATE permit.file_registry SET remote_id = $2, state = 'ready' WHERE id = $1 AND state = 'pending'`,
        [reserved.fileId, remoteId]);
    } catch {
      // The reservation stays `pending` on its pinned connection and path: the
      // same request resumes it, and reconciliation settles an abandoned one.
      throw new ManagedStorageUnavailable('Permit storage upload failed');
    }
  }
  return { id: reserved.fileId, sha256, sizeBytes: input.bytes.length };
}

/** Production remote lookup for reconciliation: the file's metadata, or null when Dropbox reports the path missing. */
export const productionReconcileDeps = {
  ...productionDeps,
  metadata: async (connection: StorageConnectionRow, path: string): Promise<{ id: string } | null> => {
    const client = await connectionClient(connection, query, true);
    try {
      const found = await client.metadata(path);
      return typeof found.id === 'string' ? { id: found.id } : null;
    } catch (error) {
      if (error instanceof DropboxError && error.missing) return null;
      throw error;
    }
  },
};

export interface ReconcileReport { examined: number; completed: number; released: number; attention: string[] }

/**
 * Settles managed (CMS) reservations left `pending` for longer than
 * `olderThanMinutes` by an abandoned request. Deterministic and
 * non-destructive: nothing remote is deleted.
 *   * the bytes are at the pinned path and match the registry: marked
 *     `ready` (a later retry of the request, or nothing, uses them);
 *   * nothing is at the pinned path: marked `cleanup_pending`, which
 *     releases the reservation (it no longer blocks a disconnect, and the
 *     request is expired);
 *   * anything else (different bytes, provider unavailable): left `pending`
 *     and listed for the operator.
 */
export async function reconcileStaleManagedFiles(
  options: { olderThanMinutes: number; dryRun: boolean },
  deps: ManagedFileDeps & { metadata: (connection: StorageConnectionRow, path: string) => Promise<{ id: string } | null> },
): Promise<ReconcileReport> {
  const report: ReconcileReport = { examined: 0, completed: 0, released: 0, attention: [] };
  const stale = await deps.query<{ id: string; connection_id: string; remote_path: string; sha256: string; size_bytes: string }>(
    `SELECT id, connection_id, remote_path, sha256, size_bytes::text AS size_bytes FROM permit.file_registry
      WHERE provider = 'dropbox' AND state = 'pending' AND category IN ('BRANDING', 'CMS_ASSET')
        AND created_at < now() - make_interval(mins => $1::int)
      ORDER BY created_at`, [options.olderThanMinutes]);
  for (const file of stale.rows) {
    report.examined += 1;
    try {
      const connection = (await deps.query<StorageConnectionRow>(
        'SELECT * FROM permit.storage_connections WHERE id = $1', [file.connection_id])).rows[0];
      if (!connection?.credentials) throw new Error('connection unavailable');
      const found = await deps.metadata(connection, `/${file.remote_path}`);
      if (!found) {
        if (!options.dryRun) {
          await deps.query(`UPDATE permit.file_registry SET state = 'cleanup_pending' WHERE id = $1 AND state = 'pending'`, [file.id]);
        }
        report.released += 1;
        continue;
      }
      const bytes = await (await deps.client(connection)).download(found.id);
      if (bytes.length !== Number(file.size_bytes) || sha256Hex(bytes) !== file.sha256) throw new Error('different bytes');
      if (!options.dryRun) {
        await deps.query(`UPDATE permit.file_registry SET remote_id = $2, state = 'ready' WHERE id = $1 AND state = 'pending'`, [file.id, found.id]);
      }
      report.completed += 1;
    } catch {
      report.attention.push(file.id);
    }
  }
  return report;
}

/**
 * Reads a ready managed file from the connection it was written to and
 * refuses the bytes unless they match the registry's size and SHA-256 (and,
 * when given, the SHA-256 the caller recorded independently - e.g. an
 * issued document's branding snapshot).
 */
export async function readManagedFile(
  fileId: string,
  expectedSha256: string | null = null,
  deps: ManagedFileDeps = productionDeps,
): Promise<Buffer> {
  const row = await deps.query<{
    connection_id: string | null; remote_id: string | null; state: string; size_bytes: string; sha256: string; provider: string;
  }>(
    `SELECT connection_id, remote_id, state, size_bytes::text AS size_bytes, sha256, provider
       FROM permit.file_registry WHERE id = $1`, [fileId]);
  const file = row.rows[0];
  if (!file || file.provider !== 'dropbox' || file.state !== 'ready' || !file.remote_id || !file.connection_id) {
    throw new ManagedStorageUnavailable('File unavailable');
  }
  if (expectedSha256 !== null && expectedSha256 !== file.sha256) throw new ManagedStorageUnavailable('File integrity mismatch');
  const connection = (await deps.query<StorageConnectionRow>(
    'SELECT * FROM permit.storage_connections WHERE id = $1', [file.connection_id])).rows[0];
  if (!connection) throw new ManagedStorageUnavailable('File unavailable');
  let bytes: Buffer;
  try {
    bytes = await (await deps.client(connection)).download(file.remote_id);
  } catch {
    throw new ManagedStorageUnavailable('File unavailable');
  }
  if (bytes.length !== Number(file.size_bytes) || sha256Hex(bytes) !== file.sha256) {
    throw new ManagedStorageUnavailable('File integrity mismatch');
  }
  return bytes;
}
