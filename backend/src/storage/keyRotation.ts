import type { QueryFn } from '../db/pool.js';
import { envelopeKeyVersion, unsealStorageSecret, type StorageKeyring } from './crypto.js';
import { resealConnection, type StorageConnectionRow } from './connections.js';
import type { DropboxTokens } from './dropbox.js';

/**
 * Which key versions the database's sealed envelopes still need. Counts and
 * version labels only - never envelopes, tokens or key material.
 *
 * A previous key may be removed from PERMIT_STORAGE_PREVIOUS_KEYS only when
 * it appears in `removableVersions`: no connection credential and no
 * unexpired OAuth state references it. Expired OAuth states are dead rows
 * (never decrypted again) and do not hold a key.
 */
export interface KeyUsage {
  activeVersion: string;
  /** [version, envelope count] sorted by version; a Map internally, so no label is special (A02). */
  envelopesByVersion: [string, number][];
  /** Referenced by an envelope but not configured: those envelopes cannot be opened. */
  missingVersions: string[];
  /** Configured previous versions no live envelope references. */
  removableVersions: string[];
  /** Envelopes still sealed under a previous (configured) key. */
  pendingReencryption: number;
}

export async function storageKeyUsage(queryFn: QueryFn, keyring: StorageKeyring): Promise<KeyUsage> {
  const { rows } = await queryFn<{ envelope: string }>(`
    SELECT credentials AS envelope FROM permit.storage_connections WHERE credentials IS NOT NULL
    UNION ALL
    SELECT verifier_envelope FROM permit.storage_oauth_states WHERE expires_at > now()`);
  const counts = new Map<string, number>();
  for (const { envelope } of rows) {
    // An unreadable or malformed label is still a reference to *something*
    // unopenable: it is reported missing and blocks nothing from removal
    // only because no configured version can equal it.
    const version = envelopeKeyVersion(envelope) ?? '(unreadable)';
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  return {
    activeVersion: keyring.active.version,
    envelopesByVersion: [...counts].sort(([a], [b]) => a.localeCompare(b)),
    missingVersions: [...counts.keys()].filter((version) => !keyring.keys.has(version)).sort(),
    removableVersions: [...keyring.keys.keys()]
      .filter((version) => version !== keyring.active.version && !counts.has(version)).sort(),
    pendingReencryption: [...counts]
      .filter(([version]) => version !== keyring.active.version && keyring.keys.has(version))
      .reduce((sum, [, count]) => sum + count, 0),
  };
}

/**
 * Re-seals every connection credential under the active key. Each row is
 * decrypted with the key its envelope names and written back with a
 * compare-and-swap, so a concurrent refresh wins and is simply re-examined
 * on the next run. Nothing is logged but counts.
 */
export async function reencryptConnections(queryFn: QueryFn, keyring: StorageKeyring,
  options: { dryRun: boolean }): Promise<{ examined: number; reencrypted: number; conflicts: number; unreadable: number }> {
  const { rows } = await queryFn<StorageConnectionRow>(
    'SELECT * FROM permit.storage_connections WHERE credentials IS NOT NULL ORDER BY id');
  const result = { examined: rows.length, reencrypted: 0, conflicts: 0, unreadable: 0 };
  for (const row of rows) {
    if (envelopeKeyVersion(row.credentials!) === keyring.active.version) continue;
    let tokens: DropboxTokens;
    try {
      tokens = unsealStorageSecret<DropboxTokens>(row.credentials!, `connection:${row.id}`, keyring);
    } catch {
      result.unreadable += 1;
      continue;
    }
    if (options.dryRun) {
      result.reencrypted += 1;
    } else if (await resealConnection(queryFn, row, tokens, keyring)) {
      result.reencrypted += 1;
    } else {
      result.conflicts += 1;
    }
  }
  return result;
}
