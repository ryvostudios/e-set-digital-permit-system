import sharp from 'sharp';
import { query, type QueryFn } from '../../db/pool.js';
import { readManagedFile, type ManagedFileDeps } from '../../storage/managedFiles.js';

/**
 * PUBLIC, UNAUTHENTICATED branding: the organization name, the sign-in
 * notice, and the selected website logo and favicon/PWA icon.
 *
 * NEVER BLOCKS SIGN-IN. Every function here degrades to the bundled
 * artwork: a missing selection, an unavailable database, a disconnected
 * Dropbox or a failed integrity check all yield "no custom asset", and
 * the frontend keeps its static files. Nothing here reveals a storage
 * path, provider, account, file id or token - only a content digest used
 * as a cache-busting version.
 *
 * Bytes are served only after their SHA-256 matches the registry, and are
 * cached in memory keyed by that digest (bounded: one logo, four icon
 * sizes), so a busy sign-in page does not become Dropbox traffic.
 */

export const ICON_SIZES = [32, 180, 192, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];

const DEFAULT_NAME = 'E-SET Digital Permit System';

interface Selection {
  organizationName: string;
  signInNotice: string;
  webLogo: { fileId: string; sha256: string } | null;
  pwaIcon: { fileId: string; sha256: string } | null;
}

async function loadSelection(queryFn: QueryFn): Promise<Selection> {
  const row = (await queryFn<{
    organization_name: string; sign_in_notice: string;
    web_file: string | null; web_sha: string | null; web_state: string | null;
    icon_file: string | null; icon_sha: string | null; icon_state: string | null;
  }>(`SELECT s.organization_name, s.sign_in_notice,
             wf.id AS web_file, wf.sha256 AS web_sha, wf.state AS web_state,
             pf.id AS icon_file, pf.sha256 AS icon_sha, pf.state AS icon_state
        FROM permit.cms_settings s
        LEFT JOIN permit.cms_logo_assets wa ON wa.id = s.web_logo_asset_id AND wa.purpose = 'WEB_LOGO'
        LEFT JOIN permit.file_registry wf ON wf.id = wa.file_id
        LEFT JOIN permit.cms_logo_assets pa ON pa.id = s.pwa_icon_asset_id AND pa.purpose = 'PWA_ICON'
        LEFT JOIN permit.file_registry pf ON pf.id = pa.file_id
       WHERE s.singleton = true`)).rows[0];
  if (!row) return { organizationName: '', signInNotice: '', webLogo: null, pwaIcon: null };
  return {
    organizationName: row.organization_name,
    signInNotice: row.sign_in_notice,
    webLogo: row.web_file && row.web_sha && row.web_state === 'ready' ? { fileId: row.web_file, sha256: row.web_sha } : null,
    pwaIcon: row.icon_file && row.icon_sha && row.icon_state === 'ready' ? { fileId: row.icon_file, sha256: row.icon_sha } : null,
  };
}

export interface PublicBrandingDeps {
  query: QueryFn;
  files?: ManagedFileDeps;
}

const defaultDeps: PublicBrandingDeps = { query };

export async function publicBranding(deps: PublicBrandingDeps = defaultDeps) {
  try {
    const selection = await loadSelection(deps.query);
    return {
      organizationName: selection.organizationName || null,
      signInNotice: selection.signInNotice || null,
      webLogoVersion: selection.webLogo?.sha256 ?? null,
      iconVersion: selection.pwaIcon?.sha256 ?? null,
    };
  } catch {
    return { organizationName: null, signInNotice: null, webLogoVersion: null, iconVersion: null };
  }
}

const byteCache = new Map<string, Buffer>();

function remember(key: string, bytes: Buffer): Buffer {
  if (byteCache.size >= 16) byteCache.clear();
  byteCache.set(key, bytes);
  return bytes;
}

async function verifiedBytes(file: { fileId: string; sha256: string }, files?: ManagedFileDeps): Promise<Buffer> {
  const key = `file:${file.sha256}`;
  return byteCache.get(key) ?? remember(key, await readManagedFile(file.fileId, file.sha256, files));
}

/** The selected website logo as `{ bytes, version }`, or null for the bundled fallback. */
export async function publicWebLogo(deps: PublicBrandingDeps = defaultDeps) {
  try {
    const selection = await loadSelection(deps.query);
    if (!selection.webLogo) return null;
    return { bytes: await verifiedBytes(selection.webLogo, deps.files), version: selection.webLogo.sha256 };
  } catch {
    return null;
  }
}

/** A square PNG derivative of the selected icon, or null for the bundled fallback. */
export async function publicIcon(size: IconSize, deps: PublicBrandingDeps = defaultDeps) {
  try {
    const selection = await loadSelection(deps.query);
    if (!selection.pwaIcon) return null;
    const key = `icon:${selection.pwaIcon.sha256}:${size}`;
    const cached = byteCache.get(key);
    if (cached) return { bytes: cached, version: selection.pwaIcon.sha256 };
    const source = await verifiedBytes(selection.pwaIcon, deps.files);
    // The source is already a validated 512x512 PNG we encoded ourselves;
    // the derivative is bounded and deterministic.
    const bytes = size === 512 ? source : await sharp(source, { limitInputPixels: 512 * 512, failOn: 'warning' })
      .resize(size, size).png().toBuffer();
    return { bytes: remember(key, bytes), version: selection.pwaIcon.sha256 };
  } catch {
    return null;
  }
}

/** The web app manifest: public fields only; custom icons when selected, bundled icons otherwise. */
export async function publicManifest(deps: PublicBrandingDeps = defaultDeps): Promise<string> {
  const branding = await publicBranding(deps);
  const icons = branding.iconVersion
    ? [192, 512].map((size) => ({
        src: `/api/v1/branding/icon/${size}?v=${branding.iconVersion}`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any',
      }))
    : [
        { src: '/branding/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/branding/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/branding/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ];
  return JSON.stringify({
    name: DEFAULT_NAME,
    short_name: 'E-SET Permits',
    description: 'Permit to Work for E-SET site operations.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0e2a33',
    theme_color: '#0d4f5c',
    icons,
  });
}

/** Test hook: forget cached bytes. */
export function clearPublicBrandingCache(): void {
  byteCache.clear();
}
