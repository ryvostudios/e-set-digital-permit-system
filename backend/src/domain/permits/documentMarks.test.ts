import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { test } from 'node:test';
import { makeV2PdfTestSnapshot } from './documentLayoutV2.test.js';
import { buildIssuedDocumentPages, type DocumentPage } from './documentLayout.js';
import { computeFileHash, generateIssuedPermitPdf } from './documents.js';
import { renderIssuedPermitPdfV3 } from './documentRendererV3.js';
import type { PermitType } from './forms.js';
import { centreOf, extractStrokedPaths, readsAsCheckmark, type StrokedPath } from '../../test/pdfVectors.js';

/**
 * THE SELECTION MARK ON THE ISSUED DOCUMENT.
 *
 * A selected answer used to be drawn as two crossing strokes - an X. On
 * a safety permit that reads as a failure rather than as "this is the
 * answer that was given", and at 7.5pt it was hard to tell from an empty
 * box at all. It is now a checkmark, drawn as vector strokes.
 *
 * THESE ASSERTIONS READ THE DRAWING COMMANDS, NOT THE TEXT. A vector
 * mark is not text: the text extractor cannot see a checkmark, and it
 * could not see the old X either, so "the extracted text contains no X"
 * would have been true of a document that drew nothing whatsoever. Every
 * test below parses the real inflated content stream into the polylines
 * the renderer actually stroked, with the colour and line width that
 * were in force.
 *
 * The geometry is checked rather than trusted: `readsAsCheckmark` insists
 * on three points drawn left to right whose middle point is the lowest,
 * with the second arm longer than the first and rising above where the
 * mark started. An X cannot satisfy that, and neither can a tick drawn
 * backwards.
 */

const TYPES: PermitType[] = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'];

/** The document blue, as `--doc-mark` resolves to it in the design tokens. */
const MARK_COLOR = '#1a4f9c';

const allMarks = (pdf: Buffer): StrokedPath[] =>
  extractStrokedPaths(pdf)
    .flat()
    .filter((path) => readsAsCheckmark(path));

const allStrokes = (pdf: Buffer): StrokedPath[] => extractStrokedPaths(pdf).flat();

/**
 * A page model built here rather than from a permit fixture, so one
 * checklist can hold all four answer states at once - including the
 * unanswered one, which no valid issued permit contains.
 */
function markProbePage(): DocumentPage {
  return {
    title: 'MARK PROBE',
    sections: [
      {
        title: 'RESPONSES',
        blocks: [
          {
            kind: 'checklist',
            columns: ['YES', 'NO', 'NA'],
            items: [
              { label: 'Answered yes', response: 'YES', remarks: null },
              { label: 'Answered no', response: 'NO', remarks: null },
              { label: 'Answered not applicable', response: 'NA', remarks: null },
              { label: 'Never answered', response: '', remarks: null },
            ],
          },
        ],
      },
      {
        title: 'SELECTIONS',
        blocks: [
          {
            kind: 'selections',
            columns: 2,
            items: [
              { label: 'Selected item', selected: true, remarks: null },
              { label: 'Unselected item', selected: false, remarks: null },
            ],
          },
        ],
      },
    ],
  };
}

const probePdf = () => renderIssuedPermitPdfV3(makeV2PdfTestSnapshot('WTG_WORK'), [markProbePage()]);

// ---------------------------------------------------------------------
// The shape itself
// ---------------------------------------------------------------------

test('PDFKIT_V3 draws a recognizable checkmark, in the brand colour, for a selected value', async () => {
  const pdf = await probePdf();
  const marks = allMarks(pdf);

  // One per answered checklist row (3) plus the one selected tick box.
  assert.equal(marks.length, 4, 'exactly the selected values are marked');
  for (const mark of marks) {
    assert.equal(mark.color, MARK_COLOR, 'the mark is drawn in the document blue');
    assert.ok(mark.lineWidth !== null && mark.lineWidth >= 1, 'a hairline would not read on paper');
  }
});

test('PDFKIT_V3 draws NO crossing X strokes anywhere - a cross never means "selected"', async () => {
  const pdf = await probePdf();
  const strokes = allStrokes(pdf);
  assert.ok(strokes.length > 0, 'the page really was drawn');

  // The old mark was TWO two-point diagonals inside one 7.5pt box. Any
  // short two-point diagonal stroke is therefore the shape being ruled
  // out here; the document's other strokes are rules and borders.
  const shortDiagonals = strokes.filter((path) => {
    if (path.points.length !== 2) return false;
    const [a, b] = path.points as [{ x: number; y: number }, { x: number; y: number }];
    return Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5;
  });
  assert.deepEqual(shortDiagonals, [], 'nothing on the document is drawn as a cross');
});

test('the mark is large enough to read and sits clear of its own box', async () => {
  const pdf = await probePdf();
  const mark = allMarks(pdf)[0]!;
  const xs = mark.points.map((point) => point.x);
  const ys = mark.points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);

  // The box is 9pt. The mark spans most of it without reaching the edge:
  // big enough to recognize, never touching the border.
  assert.ok(width > 4.5 && width < 9, `mark width ${width} should fill most of the 9pt box`);
  assert.ok(height > 3.5 && height < 9, `mark height ${height} should fill most of the 9pt box`);
});

// ---------------------------------------------------------------------
// YES / NO / N/A - one mark, in the right column
// ---------------------------------------------------------------------

test('each answered row is marked in ITS OWN response column, and the unanswered row is not marked at all', async () => {
  const pdf = await probePdf();
  const marks = allMarks(pdf);

  // The rows are drawn top to bottom in model order, so sorting by Y
  // recovers YES, NO, N/A, then the selection band's tick.
  const byRow = [...marks].sort((first, second) => centreOf(first).y - centreOf(second).y);
  const [yes, no, na] = byRow.slice(0, 3).map((mark) => centreOf(mark));

  assert.ok(yes && no && na);
  // Three columns of equal width, left to right: YES then NO then N/A.
  assert.ok(yes.x < no.x, 'the YES mark is left of the NO mark');
  assert.ok(no.x < na.x, 'the NO mark is left of the N/A mark');
  // Equally spaced, because they are the same 34pt column pitch apart.
  assert.ok(
    Math.abs((no.x - yes.x) - (na.x - no.x)) < 0.01,
    'the three marks sit on the same column pitch',
  );
  // Each on its own row.
  assert.ok(yes.y < no.y && no.y < na.y, 'one mark per row, in row order');

  // The fourth row answered nothing, so there is no fourth row mark -
  // only the selection band's tick remains, and it is further down the
  // page in its own section.
  assert.equal(byRow.length, 4);
});

test('an unanswered checklist is drawn entirely unmarked - no response is invented', async () => {
  const unanswered: DocumentPage = {
    title: 'MARK PROBE',
    sections: [
      {
        title: 'RESPONSES',
        blocks: [
          {
            kind: 'checklist',
            columns: ['YES', 'NO', 'NA'],
            items: [
              { label: 'Never answered', response: '', remarks: null },
              { label: 'Also never answered', response: '', remarks: null },
            ],
          },
        ],
      },
    ],
  };
  const pdf = await renderIssuedPermitPdfV3(makeV2PdfTestSnapshot('WTG_WORK'), [unanswered]);
  assert.deepEqual(allMarks(pdf), [], 'a blank answer stays blank');
});

test('NO is marked with a checkmark like any other answer - never a cross, never red', async () => {
  const page: DocumentPage = {
    title: 'MARK PROBE',
    sections: [
      {
        title: 'RESPONSES',
        blocks: [
          {
            kind: 'checklist',
            columns: ['YES', 'NO'],
            items: [{ label: 'Answered no', response: 'NO', remarks: null }],
          },
        ],
      },
    ],
  };
  const pdf = await renderIssuedPermitPdfV3(makeV2PdfTestSnapshot('WTG_WORK'), [page]);
  const marks = allMarks(pdf);
  assert.equal(marks.length, 1, 'NO is a selected answer, and gets one mark');
  assert.equal(marks[0]!.color, MARK_COLOR, 'the same document blue as every other mark');
});

// ---------------------------------------------------------------------
// Multi-select bands
// ---------------------------------------------------------------------

test('a selection band marks exactly what is selected and leaves the rest blank', async () => {
  const page: DocumentPage = {
    title: 'MARK PROBE',
    sections: [
      {
        title: 'PPE',
        blocks: [
          {
            kind: 'selections',
            columns: 2,
            items: [
              { label: 'Helmet', selected: true, remarks: null },
              { label: 'Harness', selected: false, remarks: null },
              { label: 'Gloves', selected: true, remarks: null },
              { label: 'Respirator', selected: false, remarks: null },
            ],
          },
        ],
      },
    ],
  };
  const pdf = await renderIssuedPermitPdfV3(makeV2PdfTestSnapshot('WTG_WORK'), [page]);
  const marks = allMarks(pdf);
  assert.equal(marks.length, 2, 'two selected, two blank');
  for (const mark of marks) assert.equal(mark.color, MARK_COLOR);
});

// ---------------------------------------------------------------------
// All four permit types, and the JSA
// ---------------------------------------------------------------------

test('every permit type and the JSA draw their marks as checkmarks in the document blue', async () => {
  for (const type of TYPES) {
    const snapshot = makeV2PdfTestSnapshot(type);
    const pdf = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3');
    const marks = allMarks(pdf);

    // The fixture answers every checklist item and ticks the first option
    // of every selection band, so a real document's worth of marks is
    // drawn for each type - and the JSA pages are part of the same file.
    assert.ok(marks.length > 20, `${type} draws its selections as checkmarks (found ${marks.length})`);
    for (const mark of marks) {
      assert.equal(mark.color, MARK_COLOR, `${type} marks are the document blue`);
    }

    // Nothing anywhere in the document is drawn as a cross.
    const crosses = allStrokes(pdf).filter((path) => {
      if (path.points.length !== 2) return false;
      const [a, b] = path.points as [{ x: number; y: number }, { x: number; y: number }];
      return Math.abs(a.x - b.x) > 0.5 && Math.abs(a.y - b.y) > 0.5;
    });
    assert.deepEqual(crosses, [], `${type} draws no cross marks`);
  }
});

test('the JSA pages carry marks of their own, not only the permit page', async () => {
  const snapshot = makeV2PdfTestSnapshot('WTG_WORK');
  const pages = buildIssuedDocumentPages(snapshot);
  // Page 0 is the permit; pages 1-2 are the JSA.
  const jsaOnly = await renderIssuedPermitPdfV3(snapshot, pages.slice(1));
  const marks = allMarks(jsaOnly);
  assert.ok(marks.length > 10, `the JSA draws its own checkmarks (found ${marks.length})`);
  for (const mark of marks) assert.equal(mark.color, MARK_COLOR);
});

// ---------------------------------------------------------------------
// What must NOT have changed
// ---------------------------------------------------------------------

test('the marks change nothing about the document except how a selection looks', async () => {
  for (const type of TYPES) {
    const snapshot = makeV2PdfTestSnapshot(type);
    const pages = buildIssuedDocumentPages(snapshot);
    // The page MODEL - every stored answer, label and response - is
    // untouched by the renderer. Rendering reads it; it never rewrites it.
    const before = JSON.stringify(pages);
    await renderIssuedPermitPdfV3(snapshot, pages);
    assert.equal(JSON.stringify(pages), before, `${type}: rendering must not mutate the model`);
    assert.deepEqual(buildIssuedDocumentPages(snapshot), pages, `${type}: the model is unchanged`);
  }
});

test('PDFKIT_V3 is still byte-deterministic with the new mark', async () => {
  for (const type of TYPES) {
    const first = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    const second = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    assert.ok(first.equals(second), `${type} must still render deterministically`);
  }
});

/*
  THE OLDER RENDERERS DID NOT MOVE.

  An issued document is content-addressed: `expected_file_hash` is pinned
  the first time a job renders it, and the job refuses to continue if a
  later render of the same snapshot produces different bytes. A
  presentation change that leaked into the legacy path would therefore
  break every already-issued document that is still pinned to it.

  These are LITERAL hashes, captured from the legacy renderer before this
  change and written down here. A self-computed hash would only prove the
  renderer is deterministic; a written-down one proves it produces what it
  has always produced.
*/
const LEGACY_HASHES: Record<PermitType, string> = {
  WTG_WORK: '829ffd1e40551a97bf8f404a52db3373932d258b85e5cfda2ea0e4613c3c4721',
  COLD_WORK: '0f321bf76538d39d502ab0c3bfb5f29e3586d6adbd3d6d5e60329f412eeb6265',
  HOT_WORK: '514eb0333ff94dc8fd58e45e44b699adc22532a687cb462c74ca6b98cb8a4c09',
  CONFINED_SPACE_ENTRY: '1d174f4a9547a5fa9b73b3dbc471ec70753896a3eb679c053ecb9e078c9246f2',
};

/*
  WHAT THE HISTORICAL BYTES DEPEND ON (A06, pre-production audit).

  PDFKit deflates every stream with the zlib linked into Node. Official
  nodejs.org builds bundle Chromium's zlib, and every one tested - 24.2.0,
  24.18.1, 24.19.0 (arm64 and x64) and 26.10.0 - produces the literal hashes
  above. A Node built against a system zlib (Homebrew's node links macOS
  libz 1.2.12) compresses the same content into different bytes. So the
  literal hashes stay the strict check for the supported runtime (official
  Node 24, `.node-version`), and this zlib-independent digest - every stream
  inflated, `/Length` and xref offsets normalized - pins the CONTENT on any
  runtime, telling "the renderer moved" apart from "this Node deflates
  differently". These digests were captured from renders whose bytes
  equal LEGACY_HASHES, so they describe the historical documents.
*/
const LEGACY_CONTENT: Record<PermitType, string> = {
  WTG_WORK: '354be77858932f4fb23a7795a123ee833b1c96d2773cf45f85d014bd0daedd9b',
  COLD_WORK: 'fcb0e68cb0a18f3ed8e47bfd635788c945163fc652d0659e57c6ff2530afa90a',
  HOT_WORK: 'a1a4d8c6f372393f721594495d4bfbb2be4e951365d0c73e7c351ae67f35baa4',
  CONFINED_SPACE_ENTRY: '864209876f3623f684be7c2ceca95e915c13ae5e053fd282f1a3c9e394d56573',
};

function contentDigest(pdf: Buffer): string {
  const hash = createHash('sha256');
  const text = pdf.toString('latin1');
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let at = 0;
  for (let m = streams.exec(text); m; m = streams.exec(text)) {
    const head = text.slice(at, m.index);
    hash.update(head.replace(/\/Length \d+/g, '/Length N'), 'latin1');
    const body = Buffer.from(m[1]!, 'latin1');
    hash.update(head.slice(-300).includes('/FlateDecode') ? inflateSync(body) : body);
    at = m.index + m[0].length;
  }
  hash.update(text.slice(at).replace(/xref[\s\S]*?trailer/, 'xref trailer').replace(/startxref\s+\d+/, 'startxref N'), 'latin1');
  return hash.digest('hex');
}

test('PDFKIT_V1 and PDFKIT_V2 still produce their historical content, on any zlib', async () => {
  for (const type of TYPES) {
    for (const version of ['PDFKIT_V1', 'PDFKIT_V2'] as const) {
      const pdf = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), version);
      assert.equal(contentDigest(pdf), LEGACY_CONTENT[type], `${type}: ${version} content moved`);
    }
  }
});

test('PDFKIT_V1 and PDFKIT_V2 still produce their historical bytes, mark or no mark', async () => {
  for (const type of TYPES) {
    const v1 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V1');
    const v2 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V2');
    const runtime = contentDigest(v1) === LEGACY_CONTENT[type]
      ? ` - the content is unchanged, but this Node (zlib ${process.versions.zlib}) deflates differently from the supported runtime; run the official Node 24 build (.node-version)`
      : '';
    assert.equal(computeFileHash(v1), LEGACY_HASHES[type], `${type}: V1 bytes moved${runtime}`);
    assert.equal(computeFileHash(v2), LEGACY_HASHES[type], `${type}: V2 bytes moved${runtime}`);
    // And they are still a different document from V3, which is the only
    // renderer this change touched.
    const v3 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    assert.notEqual(computeFileHash(v3), LEGACY_HASHES[type]);
  }
});

/*
  The mark is drawn inside a box whose size never contributes to a row's
  height - row heights come from the text they hold - so a bigger, clearer
  mark cannot push content onto another sheet. These are the physical
  sheet counts, written down, so that stays true.
*/
const V3_SHEETS: Record<PermitType, number> = {
  WTG_WORK: 7,
  COLD_WORK: 7,
  HOT_WORK: 8,
  CONFINED_SPACE_ENTRY: 8,
};

test('the new mark changes no page break: V3 still renders the same number of sheets', async () => {
  for (const type of TYPES) {
    const pdf = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    const sheets = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    assert.equal(sheets, V3_SHEETS[type], `${type}: pagination moved`);
  }
});
