import { useState, type ImgHTMLAttributes } from 'react';
import { BUNDLED_LOGO, usePublicBranding, webLogoSource } from './webBranding';

/**
 * The organization logo: the CMS website logo when one is published,
 * otherwise - or if it fails to load for any reason - the bundled E-SET
 * logo. Decorative by default (the name is written beside it).
 */
export function BrandLogo(props: Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const branding = usePublicBranding();
  const [failed, setFailed] = useState(false);
  const src = failed ? BUNDLED_LOGO : webLogoSource(branding);
  return <img alt="" {...props} src={src} onError={() => setFailed(true)} />;
}
