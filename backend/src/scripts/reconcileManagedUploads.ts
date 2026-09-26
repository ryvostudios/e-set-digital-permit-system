import { pathToFileURL } from 'node:url';
import { closePool } from '../db/pool.js';
import { productionReconcileDeps, reconcileStaleManagedFiles } from '../storage/managedFiles.js';

/**
 * Settles CMS upload reservations abandoned in `pending` (A03,
 * docs/STORAGE_AND_CMS.md §6). Operator-run or scheduled; never deletes
 * remote data. Prints counts and registry ids only.
 *
 *   npm run storage:reconcile-uploads              # dry run (default)
 *   npm run storage:reconcile-uploads -- --execute
 */
async function main(): Promise<void> {
  const report = await reconcileStaleManagedFiles(
    { olderThanMinutes: 60, dryRun: !process.argv.includes('--execute') }, productionReconcileDeps);
  console.log(JSON.stringify(report, null, 2));
  if (report.attention.length > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .catch(() => {
      console.error('storage:reconcile-uploads failed safely');
      process.exitCode = 1;
    })
    .finally(() => void closePool());
}
