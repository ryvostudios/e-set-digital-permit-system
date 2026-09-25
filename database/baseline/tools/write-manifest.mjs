// Writes database/baseline/manifest.json: the exact historical migration
// files (0001-0038) the baseline represents and the baseline files
// themselves. The Permit migration runner refuses to install the baseline
// unless every hash still matches, which ties the shared-database
// installation back to the audited history.
//
// Hashes are over content with CRLF normalized to LF so a Windows checkout
// verifies identically.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const baselineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.resolve(baselineDir, '../migrations');

const sha256 = (file) =>
  createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

const historical = readdirSync(migrationsDir)
  .filter((name) => /^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 38)
  .sort();
if (historical.length !== 38 || !historical.at(-1).startsWith('0038_')) {
  throw new Error(`Expected migrations 0001-0038, found ${historical.length}`);
}

const manifest = {
  baseline: 'permit_0038_v2',
  representsThrough: historical.at(-1),
  historicalMigrations: historical.map((name) => ({ name, sha256: sha256(path.join(migrationsDir, name)) })),
  files: Object.fromEntries(
    ['0038_permit_schema.sql', '0038_permit_reference_data.sql', '0038_permit_privileges.sql']
      .map((name) => [name, sha256(path.join(baselineDir, name))]),
  ),
};

writeFileSync(path.join(baselineDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
