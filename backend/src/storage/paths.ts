import { createHash } from 'node:crypto';

export const PERMIT_DROPBOX_ROOT = 'Digital Permit System';

/** A bounded, deterministic Dropbox path component; no slash or dot segment survives. */
export function safePathSegment(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid storage path component');
  const normalized = value.normalize('NFKC');
  const clean = normalized.replace(/[^A-Za-z0-9 _-]/g, '_').trim().replace(/\s+/g, ' ').slice(0, 64);
  if (!clean || /^_+$/.test(clean)) throw new Error('Invalid storage path component');
  const suffix = clean === normalized ? '' : `-${createHash('sha256').update(value).digest('hex').slice(0, 8)}`;
  return `${clean}${suffix}`;
}

export type StorageCategory = 'ISSUED_PDF' | 'CLOSED_PDF' | 'JSA' | 'EVIDENCE' |
  'ATTACHMENT' | 'REPORT' | 'EXPORT' | 'BRANDING' | 'CMS_ASSET';

export function filePath(input: {
  category: StorageCategory;
  year?: number;
  permitNumber?: string;
  identity: string;
  extension: 'pdf' | 'png' | 'jpg' | 'webp';
}): string {
  const { category, extension } = input;
  const id = safePathSegment(input.identity);
  if (!/^[a-z0-9_-]{1,200}$/.test(extension)) throw new Error('Invalid storage extension');
  const name = `${id}.${extension}`;
  const year = input.year;
  if (['ISSUED_PDF','CLOSED_PDF','EVIDENCE','ATTACHMENT','JSA'].includes(category)) {
    if (year === undefined || !Number.isInteger(year) || year < 2000 || year > 9999) throw new Error('Invalid storage year');
  }
  if (['ISSUED_PDF','CLOSED_PDF','EVIDENCE','ATTACHMENT'].includes(category)) {
    const number = safePathSegment(input.permitNumber || '');
    const folder = category === 'ISSUED_PDF' ? 'Issued' : category === 'CLOSED_PDF' ? 'Closed'
      : category === 'EVIDENCE' ? 'Evidence' : 'Attachments';
    return `${PERMIT_DROPBOX_ROOT}/Permits/${year}/${number}/${folder}/${name}`;
  }
  if (category === 'JSA') return `${PERMIT_DROPBOX_ROOT}/JSA/${year}/${name}`;
  if (category === 'REPORT') return `${PERMIT_DROPBOX_ROOT}/Reports/${name}`;
  if (category === 'EXPORT') return `${PERMIT_DROPBOX_ROOT}/Exports/${name}`;
  if (category === 'BRANDING') return `${PERMIT_DROPBOX_ROOT}/Branding/${name}`;
  if (category === 'CMS_ASSET') return `${PERMIT_DROPBOX_ROOT}/CMS Assets/${name}`;
  throw new Error('Unsupported storage category');
}
