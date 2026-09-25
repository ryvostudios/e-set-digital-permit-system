import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { validateBrandImage } from './images.js';

test('PDF logo validation decodes raster and preserves a bounded aspect ratio', async () => {
  const source = await sharp({ create: { width: 600, height: 200, channels: 4, background: '#ffffff' } }).png().toBuffer();
  const logo = await validateBrandImage(source, 'image/png', 'PDF_LOGO');
  assert.equal(logo.mimeType, 'image/png');
  assert.equal(logo.width, 600);
  assert.equal(logo.height, 200);
});

test('PWA source must be square and at least 512 pixels, then becomes canonical PNG', async () => {
  const square = await sharp({ create: { width: 768, height: 768, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  const icon = await validateBrandImage(square, 'image/jpeg', 'PWA_ICON');
  assert.equal(icon.width, 512);
  assert.equal(icon.height, 512);
  assert.equal((await sharp(icon.bytes).metadata()).format, 'png');
  const rectangular = await sharp({ create: { width: 768, height: 700, channels: 3, background: '#123456' } }).png().toBuffer();
  await assert.rejects(validateBrandImage(rectangular, 'image/png', 'PWA_ICON'));
});

test('MIME spoofing, SVG, invalid bytes, oversize and image bombs fail closed', async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(validateBrandImage(png, 'image/jpeg', 'WEB_LOGO'));
  await assert.rejects(validateBrandImage(Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml', 'WEB_LOGO'));
  await assert.rejects(validateBrandImage(Buffer.alloc(2 * 1024 * 1024 + 1), 'image/png', 'WEB_LOGO'));
  await assert.rejects(validateBrandImage(Buffer.from('invalid image content'), 'image/png', 'WEB_LOGO'));
  const huge = await sharp({ create: { width: 4097, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(validateBrandImage(huge, 'image/png', 'WEB_LOGO'));
});

test('a transparent PDF logo is flattened onto white at upload; website artwork keeps its transparency', async () => {
  const transparent = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 200, g: 0, b: 0, alpha: 0.25 } } }).png().toBuffer();
  const pdfLogo = await validateBrandImage(transparent, 'image/png', 'PDF_LOGO');
  const pdfMeta = await sharp(pdfLogo.bytes).metadata();
  assert.equal(pdfMeta.hasAlpha, false, 'no alpha reaches the PDF renderer');
  const { data } = await sharp(pdfLogo.bytes).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0]! > 200 && data[1]! > 150, 'composited onto white, not black');
  assert.deepEqual(await validateBrandImage(transparent, 'image/png', 'PDF_LOGO'), pdfLogo, 'normalization is deterministic');
  const webLogo = await validateBrandImage(transparent, 'image/png', 'WEB_LOGO');
  assert.equal((await sharp(webLogo.bytes).metadata()).hasAlpha, true);
});
