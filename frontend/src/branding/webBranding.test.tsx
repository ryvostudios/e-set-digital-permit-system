import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandLogo } from './BrandLogo';
import {
  applyShellBranding, BUNDLED_LOGO, loadPublicBranding, parsePublicBranding, resetPublicBrandingForTests,
} from './webBranding';

const DIGEST = 'a'.repeat(64);

function shell(): Document {
  const doc = document.implementation.createHTMLDocument('shell');
  for (const [rel, sizes, href] of [
    ['icon', '32x32', '/branding/favicon-32.png'],
    ['icon', '192x192', '/branding/icon-192.png'],
    ['apple-touch-icon', '180x180', '/branding/apple-touch-icon.png'],
    ['manifest', '', '/manifest.webmanifest'],
  ] as const) {
    const link = doc.createElement('link');
    link.setAttribute('rel', rel);
    if (sizes) link.setAttribute('sizes', sizes);
    link.setAttribute('href', href);
    doc.head.appendChild(link);
  }
  return doc;
}

afterEach(() => {
  resetPublicBrandingForTests();
  vi.unstubAllGlobals();
});

describe('public web branding', () => {
  it('accepts only well-formed public values; anything else means "no custom branding"', () => {
    expect(parsePublicBranding({ organizationName: 'E-Set', signInNotice: 'Hello', webLogoVersion: DIGEST, iconVersion: DIGEST }))
      .toEqual({ organizationName: 'E-Set', signInNotice: 'Hello', webLogoVersion: DIGEST, iconVersion: DIGEST });
    expect(parsePublicBranding({ webLogoVersion: 'javascript:alert(1)', iconVersion: '../../etc' }))
      .toEqual({ organizationName: null, signInNotice: null, webLogoVersion: null, iconVersion: null });
    expect(parsePublicBranding('nonsense').iconVersion).toBeNull();
  });

  it('keeps every static icon and the manifest when no CMS icon is published', () => {
    const doc = shell();
    applyShellBranding(parsePublicBranding({ iconVersion: null }), doc);
    expect(doc.querySelector('link[rel="manifest"]')?.getAttribute('href')).toBe('/manifest.webmanifest');
    expect(doc.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href')).toBe('/branding/apple-touch-icon.png');
  });

  it('points the favicon, touch icon and manifest at versioned public URLs when an icon is published', () => {
    const doc = shell();
    applyShellBranding(parsePublicBranding({ iconVersion: DIGEST }), doc);
    const hrefs = Array.from(doc.querySelectorAll('link')).map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.every((href) => href.includes(`v=${DIGEST}`))).toBe(true);
    for (const size of [32, 192, 180]) {
      expect(hrefs.some((href) => href.endsWith(`/api/v1/branding/icon/${size}?v=${DIGEST}`))).toBe(true);
    }
  });

  it('an unavailable CMS resolves to the bundled branding and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    await expect(loadPublicBranding()).resolves.toEqual({ organizationName: null, signInNotice: null, webLogoVersion: null, iconVersion: null });
  });

  it('the logo uses the CMS website logo and falls back to the bundled logo if it fails to load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ webLogoVersion: DIGEST }), { status: 200, headers: { 'content-type': 'application/json' } })));
    render(<BrandLogo data-testid="logo" />);
    const logo = screen.getByTestId('logo');
    expect(logo).toHaveAttribute('src', BUNDLED_LOGO);
    await waitFor(() => expect(logo.getAttribute('src')).toContain(`/api/v1/branding/web-logo?v=${DIGEST}`));
    fireEvent.error(logo);
    expect(logo).toHaveAttribute('src', BUNDLED_LOGO);
  });
});
