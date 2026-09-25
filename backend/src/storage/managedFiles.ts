import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction, type QueryFn } from '../db/pool.js';
import { connectionClient, type StorageConnectionRow } from './connections.js';
import { sha256Hex } from './crypto.js';
import type { DropboxProvider } from './dropbox.js';
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

/** Stores new bytes on the active Permit Dropbox connection and returns the ready registry row. */
export async function storeManagedFile(
  input: {
    category: ManagedCategory;
    bytes: Buffer;
    mimeType: 'image/png';
    originalFilename: string;
    createdBy: string;
  },
  deps: ManagedFileDeps = productionDeps,
): Promise<StoredFile> {
  if (input.bytes.length === 0 || input.bytes.length > 2 * 1024 * 1024) throw new ManagedStorageUnavailable('Invalid file');
  const sha256 = sha256Hex(input.bytes);
  const identity = randomUUID();
  const remotePath = filePath({ category: input.category, identity, extension: 'png' });
  const reserved = await deps.withTransaction(async (db) => {
    const selected = await db.query<StorageConnectionRow>(
      `SELECT c.* FROM permit.storage_selection s
         JOIN permit.storage_connections c ON c.id = s.connection_id
        WHERE s.singleton = true FOR UPDATE OF c`);
    const connection = selected.rows[0];
    if (!connection || connection.status !== 'connected' || !connection.credentials) return null;
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO permit.file_registry
         (provider, connection_id, logical_key, remote_path, category, original_filename, mime_type,
          size_bytes, sha256, created_by)
       VALUES ('dropbox', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [connection.id, `cms/${identity}.png`, remotePath, input.category,
        input.originalFilename.slice(0, 200) || 'image.png', input.mimeType, input.bytes.length, sha256, input.createdBy]);
    return { fileId: inserted.rows[0]!.id, connection };
  });
  if (!reserved) throw new ManagedStorageUnavailable('Permit storage is not connected');
  try {
    const client = await deps.client(reserved.connection);
    const remoteId = await client.upload(remotePath, input.bytes);
    await deps.query(
      `UPDATE permit.file_registry SET remote_id = $2, state = 'ready' WHERE id = $1 AND state = 'pending'`,
      [reserved.fileId, remoteId]);
  } catch {
    // The reservation stays `pending`: it points at a deterministic path on a
    // pinned connection, so nothing is orphaned and nothing references it.
    throw new ManagedStorageUnavailable('Permit storage upload failed');
  }
  return { id: reserved.fileId, sha256, sizeBytes: input.bytes.length };
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
