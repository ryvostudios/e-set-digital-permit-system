import { useEffect, useState } from 'react';
import { publicApiUrl, publicRequest } from '../api/client';

/**
 * CMS-controlled website branding: the header/sign-in logo, the favicon
 * and the installed-app (PWA) icon, plus the public sign-in notice.
 *
 * THE BUNDLED ARTWORK IS ALWAYS THE FALLBACK. `index.html` and the static
 * manifest keep pointing at `/branding/*`; only a successful, well-formed
 * public response replaces them. The CMS, the database or Permit Dropbox
 * being unavailable therefore never blocks sign-in or leaves a broken
 * image - the app simply looks as it did before the CMS existed.
 *
 * Nothing here is private: `/branding/public` returns only an
 * organization name, a notice and content digests used as versions.
 * No credential is sent.
 */

export const BUNDLED_LOGO = '/branding/eset-logo.png';

export interface PublicBranding {
  organizationName: string | null;
  signInNotice: string | null;
  webLogoVersion: string | null;
  iconVersion: string | null;
}

const EMPTY: PublicBranding = { organizationName: null, signInNotice: null, webLogoVersion: null, iconVersion: null };
const DIGEST = /^[a-f0-9]{64}$/;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/** Only well-formed values survive; anything else is treated as "no custom branding". */
export function parsePublicBranding(value: unknown): PublicBranding {
  if (!value || typeof value !== 'object') return EMPTY;
  const raw = value as Record<string, unknown>;
  const version = (entry: unknown) => (typeof entry === 'string' && DIGEST.test(entry) ? entry : null);
  return {
    organizationName: text(raw.organizationName, 120),
    signInNotice: text(raw.signInNotice, 500),
    webLogoVersion: version(raw.webLogoVersion),
    iconVersion: version(raw.iconVersion),
  };
}

let pending: Promise<PublicBranding> | null = null;

export function loadPublicBranding(): Promise<PublicBranding> {
  pending ??= publicRequest('/branding/public').then(parsePublicBranding, () => EMPTY);
  return pending;
}

/** Test hook. */
export function resetPublicBrandingForTests(): void {
  pending = null;
}

export function webLogoSource(branding: PublicBranding): string {
  return branding.webLogoVersion
    ? publicApiUrl(`/branding/web-logo?v=${branding.webLogoVersion}`)
    : BUNDLED_LOGO;
}

/** Points the favicon, touch icon and manifest at the CMS icon - only when one is published. */
export function applyShellBranding(branding: PublicBranding, root: Document = document): void {
  if (!branding.iconVersion) return;
  const version = branding.iconVersion;
  root.querySelectorAll<HTMLLinkElement>('link[rel="icon"]').forEach((link) => {
    const size = link.getAttribute('sizes') === '192x192' ? 192 : 32;
    link.href = publicApiUrl(`/branding/icon/${size}?v=${version}`);
    link.type = 'image/png';
  });
  root.querySelectorAll<HTMLLinkElement>('link[rel="apple-touch-icon"]').forEach((link) => {
    link.href = publicApiUrl(`/branding/icon/180?v=${version}`);
  });
  root.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]').forEach((link) => {
    link.href = publicApiUrl(`/branding/manifest.webmanifest?v=${version}`);
  });
}

/** The branding for components; starts as the bundled fallback and never throws. */
export function usePublicBranding(): PublicBranding {
  const [branding, setBranding] = useState<PublicBranding>(EMPTY);
  useEffect(() => {
    let active = true;
    void loadPublicBranding().then((value) => { if (active) setBranding(value); });
    return () => { active = false; };
  }, []);
  return branding;
}
