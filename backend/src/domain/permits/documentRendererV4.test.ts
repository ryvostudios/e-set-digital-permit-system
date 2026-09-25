import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { computeFileHash, generateIssuedPermitPdf, type IssuedPermitSnapshot } from './documents.js';
import { makeV2PdfTestSnapshot } from './documentLayoutV2.test.js';
import { MAX_BAND_LOGOS } from './documentRendererV3.js';
import { extractPdfText, inflatePdfStreams } from '../../test/pdfText.js';

/**
 * PDFKIT_V4 - the V3 document plus the CMS branding band frozen in the
 * issued snapshot. These specs pin the layout contract: up to four logos,
 * each scaled to fit its own slot (aspect ratio kept, never cropped), no
 * overlap, nothing outside the band; a long organization name never
 * spills; the same snapshot + logo bytes always produce the same file.
 */

const A4_WIDTH = 595.28;
const MARGIN = 42;
const CONTENT = A4_WIDTH - MARGIN * 2;
const SLOT = CONTENT / MAX_BAND_LOGOS;
const BAND_LOGO_HEIGHT = 26;

const png = (width: number, height: number, colour = '#2255aa') =>
  sharp({ create: { width, height, channels: 3, background: colour } }).png().toBuffer();

function branded(logos: Buffer[], organizationName = 'E-Set Engineering Services'): IssuedPermitSnapshot {
  return {
    ...makeV2PdfTestSnapshot('WTG_WORK'),
    branding: {
      organizationName,
      logos: logos.map((bytes, index) => ({ fileId: `9${index}000000-0000-4000-8000-000000000001`, sha256: computeFileHash(bytes), label: `Logo ${index}` })),
    },
  };
}

/** Every image placement on the first page: [width, height, x]. */
function placements(pdf: Buffer): { w: number; h: number; x: number }[] {
  for (const stream of inflatePdfStreams(pdf)) {
    const found = [...stream.matchAll(/q\s+([\d.]+) 0 0 -([\d.]+) ([\d.]+) ([\d.]+) cm\s+\/I\d+ Do/g)]
      .map((m) => ({ w: Number(m[1]), h: Number(m[2]), x: Number(m[3]) }));
    if (found.length > 0) return found;
  }
  return [];
}

test('no custom logo: V4 prints exactly the V3 document for a snapshot without branding', async () => {
  const snapshot = makeV2PdfTestSnapshot('WTG_WORK');
  const v3 = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3');
  const v4 = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V4');
  assert.ok(v3.equals(v4));
  assert.deepEqual(placements(v4), []);
});

test('one, two and the maximum four logos each fit inside their own slot, without overlap', async () => {
  const shapes = [[900, 150], [150, 900], [400, 400], [1200, 300]] as const;
  const sources = await Promise.all(shapes.map(([w, h], index) => png(w, h, ['#aa2233', '#22aa33', '#2233aa', '#999922'][index])));
  for (const count of [1, 2, MAX_BAND_LOGOS]) {
    const logos = sources.slice(0, count);
    const pdf = await generateIssuedPermitPdf(branded(logos), 'PDFKIT_V4', logos);
    const boxes = placements(pdf);
    assert.equal(boxes.length, count, `${count} logos placed on the first page`);
    const start = MARGIN + (CONTENT - SLOT * count) / 2;
    boxes.forEach((box, index) => {
      const slotLeft = start + index * SLOT;
      assert.ok(box.h <= BAND_LOGO_HEIGHT + 0.01, 'never taller than the band');
      assert.ok(box.x >= slotLeft - 0.01 && box.x + box.w <= slotLeft + SLOT + 0.01, `logo ${index} stays in slot ${index}`);
      // Aspect ratio is preserved (fit, never stretched).
      const [w, h] = shapes[index]!;
      assert.ok(Math.abs(box.w / box.h - w / h) < 0.02, `logo ${index} keeps its aspect ratio`);
      if (index > 0) {
        const previous = boxes[index - 1]!;
        assert.ok(previous.x + previous.w <= box.x, 'logos never overlap');
      }
    });
  }
});

test('a snapshot can never smuggle in a fifth logo', async () => {
  const logos = await Promise.all([1, 2, 3, 4, 5].map(() => png(200, 100)));
  const pdf = await generateIssuedPermitPdf(branded(logos), 'PDFKIT_V4', logos);
  assert.equal(placements(pdf).length, MAX_BAND_LOGOS);
});

test('the logo bytes must match the snapshot: missing logos refuse to render rather than print a different document', async () => {
  const logos = [await png(300, 100)];
  await assert.rejects(generateIssuedPermitPdf(branded(logos), 'PDFKIT_V4', []));
});

test('a logo with an alpha channel is refused: pdfkit alpha embedding is not byte-stable', async () => {
  const withAlpha = await sharp({ create: { width: 300, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  await assert.rejects(generateIssuedPermitPdf(branded([withAlpha]), 'PDFKIT_V4', [withAlpha]));
});

test('a long organization name stays on one line and never pushes into the title', async () => {
  const logos = [await png(300, 100)];
  const short = await generateIssuedPermitPdf(branded(logos, 'E-Set'), 'PDFKIT_V4', logos);
  const long = await generateIssuedPermitPdf(branded(logos, 'Engineering Services '.repeat(6).trim()), 'PDFKIT_V4', logos);
  const pageCount = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g)?.length ?? 0;
  assert.equal(pageCount(long), pageCount(short), 'a long name does not change the layout');
  assert.match(extractPdfText(long), /Engineering Services/);
  assert.match(extractPdfText(short), /E-Set/);
});

test('the same snapshot and logo bytes render byte-identically every time', async () => {
  const logos = [await png(640, 160), await png(256, 256)];
  const first = await generateIssuedPermitPdf(branded(logos), 'PDFKIT_V4', logos);
  const second = await generateIssuedPermitPdf(branded(logos), 'PDFKIT_V4', logos);
  assert.ok(first.equals(second));
});
