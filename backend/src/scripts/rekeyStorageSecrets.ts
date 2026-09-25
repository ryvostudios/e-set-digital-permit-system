import { pathToFileURL } from 'node:url';
import { env } from '../config/env.js';
import { closePool, query } from '../db/pool.js';
import { storageKeyring } from '../storage/crypto.js';
import { reencryptConnections, storageKeyUsage } from '../storage/keyRotation.js';

/**
 * Storage encryption-key rotation (docs/STORAGE_AND_CMS.md §2):
 *
 *   npm run storage:rekey              # dry run: report key usage only
 *   npm run storage:rekey -- --execute # re-seal credentials under the active key
 *
 * Prints versions and counts only. Exit code 2 while any envelope still
 * needs a previous key, or when a referenced key is missing.
 */
async function main(): Promise<void> {
  if (!env.PERMIT_STORAGE_MASTER_KEY) throw new Error('storage encryption is not configured');
  const keyring = storageKeyring(env.PERMIT_STORAGE_KEY_VERSION, env.PERMIT_STORAGE_MASTER_KEY, env.PERMIT_STORAGE_PREVIOUS_KEYS);
  const execute = process.argv.includes('--execute');
  const reencryption = await reencryptConnections(query, keyring, { dryRun: !execute });
  const usage = await storageKeyUsage(query, keyring);
  console.log(JSON.stringify({ dryRun: !execute, reencryption, usage }, null, 2));
  if (usage.missingVersions.length > 0 || usage.pendingReencryption > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch(() => {
      console.error('storage:rekey failed safely');
      process.exitCode = 1;
    })
    .finally(() => void closePool());
}
