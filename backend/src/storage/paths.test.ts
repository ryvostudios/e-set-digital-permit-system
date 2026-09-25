import assert from 'node:assert/strict';
import test from 'node:test';
import { filePath, safePathSegment } from './paths.js';

test('Permit Dropbox paths are deterministic, structured and traversal-safe', () => {
  const value = filePath({category:'ISSUED_PDF',year:2026,permitNumber:'WTG-0001',identity:'7e1d8f81-aaaa-4444-9999-123456789abc',extension:'pdf'});
  assert.equal(value,'Digital Permit System/Permits/2026/WTG-0001/Issued/7e1d8f81-aaaa-4444-9999-123456789abc.pdf');
  assert.equal(value,filePath({category:'ISSUED_PDF',year:2026,permitNumber:'WTG-0001',identity:'7e1d8f81-aaaa-4444-9999-123456789abc',extension:'pdf'}));
  assert.equal(filePath({category:'JSA',year:2026,identity:'JSA-42',extension:'pdf'}),'Digital Permit System/JSA/2026/JSA-42.pdf');
  assert.equal(filePath({category:'BRANDING',identity:'asset-1',extension:'png'}),'Digital Permit System/Branding/asset-1.png');
  assert.match(safePathSegment('permit/../../evil'), /^[A-Za-z0-9 _-]+$/);
  assert.throws(()=>safePathSegment('..'));
  assert.throws(()=>filePath({category:'ISSUED_PDF',year:2026,permitNumber:'..',identity:'x',extension:'pdf'}));
});
