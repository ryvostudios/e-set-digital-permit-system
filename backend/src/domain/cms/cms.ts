import type { PoolClient } from 'pg';
import { query, withTransaction, type QueryFn } from '../../db/pool.js';
import { readManagedFile, storeManagedFile, type ManagedFileDeps } from '../../storage/managedFiles.js';
import { validateBrandImage, type ImagePurpose } from '../../storage/images.js';

/**
 * The Permit CMS: organization identity, one piece of application content,
 * the ordered PDF logo set, and the website/PWA artwork. Permit-only - it
 * shares nothing with the ESDMS CMS.
 *
 * AUTHORITY is decided by the route layer (`requireCmsManage`: the CEO, or
 * an individual explicitly granted `permit.cms.manage`). Every write here
 * is revision-checked against `cms_settings.revision`, so two editors can
 * never silently overwrite each other, and every write is audited in
 * `cms_audit_events` (append-only) with a small structured detail - never
 * image bytes, storage paths, tokens or keys.
 *
 * ISSUED DOCUMENTS NEVER FOLLOW THESE SETTINGS. `captureDocumentBranding`
 * is called inside the issuance transaction and its result is frozen into
 * the immutable issued snapshot; what the CMS says tomorrow cannot change
 * what a permit issued today prints.
 */

export const MAX_PDF_LOGOS = 4;
export type DocumentType = 'ISSUED_PERMIT';

export class CmsConflict extends Error {}
export class CmsInvalid extends Error {}

export interface CmsDeps {
  query: QueryFn;
  withTransaction: <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
  files?: ManagedFileDeps;
}

const defaultDeps: CmsDeps = { query, withTransaction };

type AuditEvent =
  | 'SETTING_CHANGED' | 'CONTENT_CHANGED' | 'LOGO_UPLOADED' | 'PDF_BRANDING_CHANGED'
  | 'WEB_LOGO_CHANGED' | 'PWA_ICON_CHANGED';

async function audit(queryFn: QueryFn, actor: string, eventType: AuditEvent, assetId: string | null,
  detail: Record<string, unknown> = {}): Promise<void> {
  await queryFn(
    'INSERT INTO permit.cms_audit_events (actor_user_id, event_type, asset_id, detail) VALUES ($1, $2, $3, $4::jsonb)',
    [actor, eventType, assetId, JSON.stringify(detail)]);
}

interface SettingsRow {
  organization_name: string;
  sign_in_notice: string;
  web_logo_asset_id: string | null;
  pwa_icon_asset_id: string | null;
  revision: number;
}

/** Locks the settings row and refuses a stale revision. */
async function lockSettings(db: PoolClient, revision: number): Promise<SettingsRow> {
  const row = (await db.query<SettingsRow>(
    `SELECT organization_name, sign_in_notice, web_logo_asset_id, pwa_icon_asset_id, revision
       FROM permit.cms_settings WHERE singleton = true FOR UPDATE`)).rows[0];
  if (!row) throw new CmsConflict('CMS settings missing');
  if (row.revision !== revision) throw new CmsConflict('CMS settings changed');
  return row;
}

async function bumpRevision(db: PoolClient, actor: string): Promise<number> {
  const updated = await db.query<{ revision: number }>(
    `UPDATE permit.cms_settings SET revision = revision + 1, updated_by = $1, updated_at = now()
      WHERE singleton = true RETURNING revision`, [actor]);
  return updated.rows[0]!.revision;
}

export interface CmsAsset {
  id: string;
  label: string;
  purpose: ImagePurpose;
  active: boolean;
  displayOrder: number;
  documentTypes: string[];
  createdAt: string;
}

export async function getCmsState(deps: CmsDeps = defaultDeps) {
  const settings = (await deps.query<SettingsRow>(
    `SELECT organization_name, sign_in_notice, web_logo_asset_id, pwa_icon_asset_id, revision
       FROM permit.cms_settings WHERE singleton = true`)).rows[0];
  const assets = await deps.query<{
    id: string; display_label: string; purpose: ImagePurpose; active: boolean; display_order: number;
    applicable_document_types: string[]; created_at: string;
  }>(`SELECT a.id, a.display_label, a.purpose, a.active, a.display_order, a.applicable_document_types, a.created_at
        FROM permit.cms_logo_assets a
        JOIN permit.file_registry f ON f.id = a.file_id AND f.state = 'ready'
       ORDER BY a.purpose, a.active DESC, a.display_order, a.created_at DESC`);
  return {
    revision: settings?.revision ?? 0,
    organizationName: settings?.organization_name ?? '',
    signInNotice: settings?.sign_in_notice ?? '',
    webLogoAssetId: settings?.web_logo_asset_id ?? null,
    pwaIconAssetId: settings?.pwa_icon_asset_id ?? null,
    maxPdfLogos: MAX_PDF_LOGOS,
    assets: assets.rows.map((row): CmsAsset => ({
      id: row.id, label: row.display_label, purpose: row.purpose, active: row.active,
      displayOrder: row.display_order, documentTypes: row.applicable_document_types,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function updateIdentity(
  actor: string,
  input: { revision: number; organizationName: string; signInNotice: string },
  deps: CmsDeps = defaultDeps,
): Promise<{ revision: number }> {
  return deps.withTransaction(async (db) => {
    const current = await lockSettings(db, input.revision);
    await db.query(
      'UPDATE permit.cms_settings SET organization_name = $1, sign_in_notice = $2 WHERE singleton = true',
      [input.organizationName, input.signInNotice]);
    const queryFn = db.query.bind(db) as QueryFn;
    if (current.organization_name !== input.organizationName) {
      await audit(queryFn, actor, 'SETTING_CHANGED', null, { field: 'organization_name' });
    }
    if (current.sign_in_notice !== input.signInNotice) {
      await audit(queryFn, actor, 'CONTENT_CHANGED', null, { field: 'sign_in_notice' });
    }
    return { revision: await bumpRevision(db, actor) };
  });
}

/**
 * Validates untrusted image bytes (decoded, re-encoded; never trusted by
 * name, extension or declared type), stores the canonical PNG in Permit
 * Dropbox, and registers it as an INACTIVE asset. Nothing uses it until an
 * editor selects it.
 */
export async function uploadAsset(
  actor: string,
  input: { purpose: ImagePurpose; label: string; declaredMime: string; bytes: Buffer },
  deps: CmsDeps = defaultDeps,
): Promise<{ id: string }> {
  let image;
  try {
    image = await validateBrandImage(input.bytes, input.declaredMime, input.purpose);
  } catch {
    throw new CmsInvalid('Invalid image');
  }
  const stored = await storeManagedFile({
    category: input.purpose === 'PWA_ICON' ? 'CMS_ASSET' : 'BRANDING',
    bytes: image.bytes, mimeType: 'image/png',
    originalFilename: `${input.purpose.toLowerCase()}.png`, createdBy: actor,
  }, deps.files);
  return deps.withTransaction(async (db) => {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO permit.cms_logo_assets (file_id, display_label, purpose, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`, [stored.id, input.label, input.purpose, actor]);
    const id = inserted.rows[0]!.id;
    await audit(db.query.bind(db) as QueryFn, actor, 'LOGO_UPLOADED', id,
      { purpose: input.purpose, width: image.width, height: image.height, sha256: stored.sha256.slice(0, 12) });
    return { id };
  });
}

/**
 * Replaces the ordered set of PDF logos. `logos` IS the order (slot 0 is
 * the left-most); at most MAX_PDF_LOGOS, each a PDF_LOGO asset, no
 * duplicates. Every other PDF logo becomes inactive. Applies to documents
 * issued from now on only.
 */
export async function setPdfLogos(
  actor: string,
  input: { revision: number; logos: { assetId: string; documentTypes: DocumentType[] }[] },
  deps: CmsDeps = defaultDeps,
): Promise<{ revision: number }> {
  if (input.logos.length > MAX_PDF_LOGOS) throw new CmsInvalid(`At most ${MAX_PDF_LOGOS} PDF logos`);
  const ids = input.logos.map((logo) => logo.assetId);
  if (new Set(ids).size !== ids.length) throw new CmsInvalid('Duplicate logo');
  return deps.withTransaction(async (db) => {
    await lockSettings(db, input.revision);
    const found = await db.query<{ id: string }>(
      `SELECT a.id FROM permit.cms_logo_assets a JOIN permit.file_registry f ON f.id = a.file_id AND f.state = 'ready'
        WHERE a.purpose = 'PDF_LOGO' AND a.id = ANY($1::uuid[]) FOR UPDATE OF a`, [ids]);
    if (found.rows.length !== ids.length) throw new CmsInvalid('Unknown PDF logo');
    // Deactivate first: the active-order uniqueness index is not deferrable.
    await db.query(`UPDATE permit.cms_logo_assets SET active = false WHERE purpose = 'PDF_LOGO' AND active`);
    for (const [order, logo] of input.logos.entries()) {
      await db.query(
        `UPDATE permit.cms_logo_assets SET active = true, display_order = $2, applicable_document_types = $3
          WHERE id = $1`, [logo.assetId, order, logo.documentTypes]);
    }
    await audit(db.query.bind(db) as QueryFn, actor, 'PDF_BRANDING_CHANGED', null,
      { activeAssetIds: ids, documentTypes: input.logos.map((logo) => logo.documentTypes) });
    return { revision: await bumpRevision(db, actor) };
  });
}

/** Selects (or clears, with null) the website/header logo or the favicon/PWA icon. */
export async function setWebArtwork(
  actor: string,
  input: { revision: number; kind: 'WEB_LOGO' | 'PWA_ICON'; assetId: string | null },
  deps: CmsDeps = defaultDeps,
): Promise<{ revision: number }> {
  return deps.withTransaction(async (db) => {
    await lockSettings(db, input.revision);
    if (input.assetId) {
      const found = await db.query(
        `SELECT 1 FROM permit.cms_logo_assets a JOIN permit.file_registry f ON f.id = a.file_id AND f.state = 'ready'
          WHERE a.id = $1 AND a.purpose = $2`, [input.assetId, input.kind]);
      if (found.rows.length !== 1) throw new CmsInvalid('Unknown asset');
    }
    const column = input.kind === 'WEB_LOGO' ? 'web_logo_asset_id' : 'pwa_icon_asset_id';
    await db.query(`UPDATE permit.cms_settings SET ${column} = $1 WHERE singleton = true`, [input.assetId]);
    await audit(db.query.bind(db) as QueryFn, actor, input.kind === 'WEB_LOGO' ? 'WEB_LOGO_CHANGED' : 'PWA_ICON_CHANGED',
      input.assetId, { cleared: input.assetId === null });
    return { revision: await bumpRevision(db, actor) };
  });
}

export async function listCmsAudit(limit: number, deps: CmsDeps = defaultDeps) {
  const rows = await deps.query<{
    id: string; actor_user_id: string; event_type: string; asset_id: string | null; detail: unknown; occurred_at: string;
  }>(`SELECT id, actor_user_id, event_type, asset_id, detail, occurred_at
        FROM permit.cms_audit_events ORDER BY occurred_at DESC, id DESC LIMIT $1`, [limit]);
  return rows.rows.map((row) => ({
    id: row.id, actorUserId: row.actor_user_id, eventType: row.event_type, assetId: row.asset_id,
    detail: row.detail, occurredAt: new Date(row.occurred_at).toISOString(),
  }));
}

/** Preview bytes for a CMS editor (authorized by the route). */
export async function readAssetBytes(assetId: string, deps: CmsDeps = defaultDeps): Promise<Buffer> {
  const row = (await deps.query<{ file_id: string }>(
    'SELECT file_id FROM permit.cms_logo_assets WHERE id = $1', [assetId])).rows[0];
  if (!row) throw new CmsInvalid('Unknown asset');
  return readManagedFile(row.file_id, null, deps.files);
}

// ---------------------------------------------------------------------
// Issuance-time snapshot
// ---------------------------------------------------------------------

export interface DocumentBrandingSnapshot {
  organizationName: string;
  /** Ordered left to right. File ids and hashes are immutable registry facts. */
  logos: { fileId: string; sha256: string; label: string }[];
}

/**
 * The branding an issued permit carries, read inside the issuance
 * transaction and frozen into the immutable snapshot. Only logos whose file
 * is ready and whose applicable document types include ISSUED_PERMIT.
 */
export async function captureDocumentBranding(queryFn: QueryFn): Promise<DocumentBrandingSnapshot> {
  const settings = (await queryFn<{ organization_name: string }>(
    'SELECT organization_name FROM permit.cms_settings WHERE singleton = true')).rows[0];
  const logos = await queryFn<{ file_id: string; sha256: string; display_label: string }>(
    `SELECT a.file_id, f.sha256, a.display_label
       FROM permit.cms_logo_assets a
       JOIN permit.file_registry f ON f.id = a.file_id AND f.state = 'ready'
      WHERE a.purpose = 'PDF_LOGO' AND a.active AND 'ISSUED_PERMIT' = ANY(a.applicable_document_types)
      ORDER BY a.display_order
      LIMIT ${MAX_PDF_LOGOS}`);
  return {
    organizationName: settings?.organization_name ?? '',
    logos: logos.rows.map((row) => ({ fileId: row.file_id, sha256: row.sha256, label: row.display_label })),
  };
}
