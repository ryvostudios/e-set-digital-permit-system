import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { PoolClient } from 'pg';
import sharp from 'sharp';
import { installedDatabase } from '../../test/permitSchemaFixtures.js';
import type { ManagedFileDeps } from '../../storage/managedFiles.js';
import { computeFileHash, generateIssuedPermitPdf } from '../permits/documents.js';
import { makeV2PdfTestSnapshot } from '../permits/documentLayoutV2.test.js';
import {
  captureDocumentBranding, CmsConflict, CmsInvalid, getCmsState, listCmsAudit, MAX_PDF_LOGOS, setPdfLogos,
  setWebArtwork, updateIdentity, uploadAsset, type CmsDeps,
} from './cms.js';
import { clearPublicBrandingCache, publicBranding, publicIcon, publicManifest, publicWebLogo } from './publicBranding.js';

/**
 * The Permit CMS against the real `permit` schema (baseline + 0039-0042),
 * with Permit Dropbox replaced by an in-memory fake. No network, no real
 * provider, no credentials.
 */

const ACTOR = '61000000-0000-4000-8000-000000000001';
const CONNECTION = '62000000-0000-4000-8000-000000000001';

let db: PGlite;
const remote = new Map<string, Buffer>();
let tamperDownloads = false;

function pgDeps(): CmsDeps {
  const query = ((text: string, params?: unknown[]) => db.query(text, params)) as CmsDeps['query'];
  const withTransaction = (async <T>(work: (client: PoolClient) => Promise<T>) =>
    db.transaction(async (tx) => work({ query: tx.query.bind(tx) } as unknown as PoolClient))) as CmsDeps['withTransaction'];
  const files: ManagedFileDeps = {
    query, withTransaction,
    client: async () => ({
      upload: async (path: string, bytes: Buffer) => {
        const id = `id:${createHash('sha256').update(path).digest('hex').slice(0, 20)}`;
        remote.set(id, Buffer.from(bytes));
        return id;
      },
      download: async (id: string) => {
        const bytes = remote.get(id);
        if (!bytes) throw new Error('missing');
        return tamperDownloads ? Buffer.concat([bytes, Buffer.from('x')]) : bytes;
      },
    }),
  };
  return { query, withTransaction, files };
}

const png = (width: number, height: number, colour = '#1a4f9c') =>
  sharp({ create: { width, height, channels: 4, background: colour } }).png().toBuffer();
const jpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#cc3300' } }).jpeg().toBuffer();

async function revision(): Promise<number> {
  return (await getCmsState(pgDeps())).revision;
}

before(async () => {
  db = await installedDatabase();
  await db.query(`INSERT INTO permit.users (id, email) VALUES ($1, 'cms-editor@example.test')`, [ACTOR]);
  await db.query(
    `INSERT INTO permit.storage_connections (id, provider, status, account_id, account_label, credentials, last_health_at)
     VALUES ($1, 'dropbox', 'connected', 'dbid:synthetic', 'Synthetic', 'sealed-envelope', now())`, [CONNECTION]);
  await db.query('UPDATE permit.storage_selection SET connection_id = $1', [CONNECTION]);
});

after(async () => {
  await db?.close();
});

beforeEach(() => {
  tamperDownloads = false;
  clearPublicBrandingCache();
});

test('identity and application content are revision-checked and audited without values', async () => {
  const start = await revision();
  const saved = await updateIdentity(ACTOR, {
    revision: start, organizationName: 'E-Set Engineering Services (Pvt) Ltd', signInNotice: 'Use your site account.',
  }, pgDeps());
  assert.equal(saved.revision, start + 1);
  await assert.rejects(updateIdentity(ACTOR, { revision: start, organizationName: 'Stale', signInNotice: '' }, pgDeps()), CmsConflict);
  const events = await listCmsAudit(10, pgDeps());
  assert.deepEqual(events.slice(0, 2).map((event) => event.eventType).sort(), ['CONTENT_CHANGED', 'SETTING_CHANGED']);
  assert.doesNotMatch(JSON.stringify(events), /Pvt|site account/, 'audit records which field changed, not its value');
});

test('uploads are decoded and re-encoded: spoofed, oversized, SVG and non-square icons are refused', async () => {
  const bad: [Buffer, string, 'PDF_LOGO' | 'PWA_ICON'][] = [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png', 'PDF_LOGO'],
    [await jpeg(200, 100), 'image/png', 'PDF_LOGO'],
    [await png(16, 16), 'image/png', 'PDF_LOGO'],
    [await png(600, 400), 'image/png', 'PWA_ICON'],
    [await png(256, 256), 'image/png', 'PWA_ICON'],
    [Buffer.alloc(3 * 1024 * 1024, 1), 'image/png', 'PDF_LOGO'],
  ];
  for (const [bytes, declaredMime, purpose] of bad) {
    await assert.rejects(uploadAsset(ACTOR, { purpose, label: 'Bad', declaredMime, bytes }, pgDeps()), CmsInvalid);
  }
  const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM permit.file_registry')).rows[0]!.n;
  assert.equal(before, 0, 'a refused upload stores nothing');
});

test('a valid logo is stored in Permit Dropbox, registered, inactive, and audited without paths', async () => {
  const { id } = await uploadAsset(ACTOR, { purpose: 'PDF_LOGO', label: 'E-SET', declaredMime: 'image/jpeg', bytes: await jpeg(800, 200) }, pgDeps());
  const asset = (await getCmsState(pgDeps())).assets.find((row) => row.id === id)!;
  assert.equal(asset.active, false);
  const file = (await db.query<{ category: string; state: string; mime_type: string; remote_path: string }>(
    `SELECT f.category, f.state, f.mime_type, f.remote_path FROM permit.cms_logo_assets a
       JOIN permit.file_registry f ON f.id = a.file_id WHERE a.id = $1`, [id])).rows[0]!;
  assert.deepEqual([file.category, file.state, file.mime_type], ['BRANDING', 'ready', 'image/png']);
  assert.match(file.remote_path, /^Digital Permit System\/Branding\/[0-9a-f-]{36}\.png$/);
  const audit = (await listCmsAudit(1, pgDeps()))[0]!;
  assert.equal(audit.eventType, 'LOGO_UPLOADED');
  assert.doesNotMatch(JSON.stringify(audit), /Digital Permit System|id:|sealed/);
});

test('PDF logos: an ordered set of at most four, each a PDF logo, captured for issuance in order', async () => {
  const ids: string[] = [];
  for (const [index, colour] of ['#111111', '#222222', '#333333', '#444444', '#555555'].entries()) {
    ids.push((await uploadAsset(ACTOR, {
      purpose: 'PDF_LOGO', label: `Company ${index}`, declaredMime: 'image/png', bytes: await png(300 + index, 100, colour),
    }, pgDeps())).id);
  }
  const all = ids.map((assetId) => ({ assetId, documentTypes: ['ISSUED_PERMIT' as const] }));
  await assert.rejects(setPdfLogos(ACTOR, { revision: await revision(), logos: all }, pgDeps()), CmsInvalid);
  const web = (await uploadAsset(ACTOR, { purpose: 'WEB_LOGO', label: 'Header', declaredMime: 'image/png', bytes: await png(400, 120) }, pgDeps())).id;
  await assert.rejects(setPdfLogos(ACTOR, { revision: await revision(), logos: [{ assetId: web, documentTypes: ['ISSUED_PERMIT'] }] }, pgDeps()), CmsInvalid);

  const chosen = [ids[3]!, ids[0]!, ids[2]!];
  await setPdfLogos(ACTOR, { revision: await revision(), logos: chosen.map((assetId) => ({ assetId, documentTypes: ['ISSUED_PERMIT'] })) }, pgDeps());
  const captured = await captureDocumentBranding(pgDeps().query);
  assert.deepEqual(captured.logos.map((logo) => logo.label), ['Company 3', 'Company 0', 'Company 2']);
  assert.ok(captured.logos.every((logo) => /^[0-9a-f]{64}$/.test(logo.sha256)));
  assert.equal(captured.logos.length <= MAX_PDF_LOGOS, true);
  assert.equal((await listCmsAudit(1, pgDeps()))[0]!.eventType, 'PDF_BRANDING_CHANGED');
});

test('HISTORICAL BRANDING IS IMMUTABLE: a later CMS change never alters an issued document', async () => {
  const deps = pgDeps();
  const frozen = await captureDocumentBranding(deps.query);
  assert.ok(frozen.logos.length > 0);
  const snapshot = { ...makeV2PdfTestSnapshot('WTG_WORK'), branding: frozen };
  const { readManagedFile } = await import('../../storage/managedFiles.js');
  const loadLogos = () => Promise.all(frozen.logos.map((logo) => readManagedFile(logo.fileId, logo.sha256, deps.files)));
  const before = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V4', await loadLogos());

  // Tomorrow: new name, every logo withdrawn, a different one chosen.
  await updateIdentity(ACTOR, { revision: await revision(), organizationName: 'A Different Name', signInNotice: '' }, deps);
  const replacement = (await uploadAsset(ACTOR, { purpose: 'PDF_LOGO', label: 'New', declaredMime: 'image/png', bytes: await png(500, 500, '#00ff00') }, deps)).id;
  await setPdfLogos(ACTOR, { revision: await revision(), logos: [{ assetId: replacement, documentTypes: ['ISSUED_PERMIT'] }] }, deps);

  const afterChange = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V4', await loadLogos());
  assert.equal(computeFileHash(afterChange), computeFileHash(before), 'the issued document is byte-identical');
  assert.notDeepEqual(await captureDocumentBranding(deps.query), frozen, 'only NEW issuance sees the change');
});

test('website logo and PWA icon: purpose-checked selection, public versions, derived icons, and fallbacks', async () => {
  const deps = pgDeps();
  const publicDeps = { query: deps.query, files: deps.files! };
  assert.equal((await publicBranding(publicDeps)).iconVersion, null);
  assert.equal(await publicIcon(192, publicDeps), null, 'no selection: the bundled icon stays');
  assert.match(await publicManifest(publicDeps), /\/branding\/icon-192\.png/);

  const icon = (await uploadAsset(ACTOR, { purpose: 'PWA_ICON', label: 'App icon', declaredMime: 'image/png', bytes: await png(1024, 1024) }, deps)).id;
  const logo = (await uploadAsset(ACTOR, { purpose: 'WEB_LOGO', label: 'Header', declaredMime: 'image/png', bytes: await png(600, 160) }, deps)).id;
  await assert.rejects(setWebArtwork(ACTOR, { revision: await revision(), kind: 'WEB_LOGO', assetId: icon }, deps), CmsInvalid);
  await setWebArtwork(ACTOR, { revision: await revision(), kind: 'PWA_ICON', assetId: icon }, deps);
  await setWebArtwork(ACTOR, { revision: await revision(), kind: 'WEB_LOGO', assetId: logo }, deps);

  const branding = await publicBranding(publicDeps);
  assert.match(branding.iconVersion ?? '', /^[0-9a-f]{64}$/);
  assert.match(branding.webLogoVersion ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(branding).sort(), ['iconVersion', 'organizationName', 'signInNotice', 'webLogoVersion']);
  for (const size of [32, 180, 192, 512] as const) {
    const derived = await publicIcon(size, publicDeps);
    const meta = await sharp(derived!.bytes).metadata();
    assert.deepEqual([meta.format, meta.width, meta.height], ['png', size, size]);
  }
  const manifest = JSON.parse(await publicManifest(publicDeps)) as { icons: { src: string }[] };
  assert.ok(manifest.icons.every((entry) => entry.src.includes(branding.iconVersion!)));
  assert.doesNotMatch(JSON.stringify(manifest), /Digital Permit System\/|dropbox|id:/i);

  // Storage returns tampered bytes: never served; the bundled artwork is used.
  clearPublicBrandingCache();
  tamperDownloads = true;
  assert.equal(await publicWebLogo(publicDeps), null);
  assert.equal(await publicIcon(192, publicDeps), null);

  // CMS/database unavailable: public branding still answers, with no custom artwork.
  const broken = { query: (async () => { throw new Error('down'); }) as unknown as CmsDeps['query'] };
  assert.deepEqual(await publicBranding(broken), { organizationName: null, signInNotice: null, webLogoVersion: null, iconVersion: null });
  assert.match(await publicManifest(broken), /icon-maskable-512\.png/);

  const events = (await listCmsAudit(3, deps)).map((event) => event.eventType);
  assert.deepEqual(events.slice(0, 2), ['WEB_LOGO_CHANGED', 'PWA_ICON_CHANGED']);
});

test('CMS audit rows are append-only', async () => {
  await assert.rejects(db.exec('UPDATE permit.cms_audit_events SET event_type = event_type'));
  await assert.rejects(db.exec('DELETE FROM permit.cms_audit_events'));
});
