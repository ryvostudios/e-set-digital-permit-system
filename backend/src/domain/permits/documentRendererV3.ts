import PDFDocument from 'pdfkit';
import type { DocumentBlock, DocumentPage, DocumentSection } from './documentLayout.js';
import type { IssuedPermitSnapshot } from './documents.js';

/**
 * PDFKIT_V3 - the authoritative document, drawn as the controlled form it
 * is rather than as a list of sentences.
 *
 * WHY A THIRD RENDERER RATHER THAN A CHANGE TO THE SECOND. The issued PDF
 * is content-addressed: `permit_document_jobs.expected_file_hash` is
 * pinned the first time a job renders, and the job refuses to proceed if
 * a later render of the same snapshot produces different bytes. Editing
 * PDFKIT_V2 in place would therefore not "improve" existing documents -
 * it would permanently break every job already pinned to it. V2 stays
 * exactly as it was and keeps producing exactly what it produced; V3 is a
 * new, separately identified renderer that new jobs use.
 *
 * WHAT IT DRAWS, AND WHAT IT REFUSES TO DRAW. Everything comes from the
 * immutable snapshot by way of the shared page model, so this file holds
 * no safety wording, no question, no option label and no identity of its
 * own - exactly like the on-screen document, and for the same reason:
 * the printed form, the editor and the PDF cannot drift if none of them
 * owns the words. Where the model has no value, `-` is printed. Nothing
 * is inferred, defaulted or filled in.
 *
 * DETERMINISM IS A HARD REQUIREMENT. No clock, no randomness, no locale
 * formatting, no measurement that depends on anything outside the
 * snapshot. The document's own creation and modification dates come from
 * the snapshot's issuance timestamp. The same snapshot therefore renders
 * to byte-identical output every time, which is what makes the stored
 * file hash meaningful.
 */

const PAGE_MARGIN = 42;
const RULE = '#9aa3ad';
const RULE_STRONG = '#4a5560';
const HEAD_FILL = '#eceff3';
const INK = '#111418';
const MUTED = '#5b6672';

/** Body/typographic scale. Print-first: small, but never below 7pt. */
const SIZE = { masthead: 13, issuer: 8, section: 9.5, body: 8.5, small: 7.5, tick: 8 } as const;

const LINE = 11;

interface Cursor {
  doc: PDFKit.PDFDocument;
  width: number;
}

const left = PAGE_MARGIN;

function bottomLimit(doc: PDFKit.PDFDocument): number {
  // Room kept for the printed footer strip.
  return doc.page.height - PAGE_MARGIN - 22;
}

/** Starts a fresh physical page when `needed` points will not fit. */
function ensureRoom({ doc }: Cursor, needed: number): void {
  if (doc.y + needed <= bottomLimit(doc)) return;
  doc.addPage();
}

function textHeight(doc: PDFKit.PDFDocument, value: string, width: number, size: number): number {
  return doc.fontSize(size).heightOfString(value, { width });
}

function box(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, fill?: string): void {
  if (fill) doc.rect(x, y, w, h).fill(fill);
  doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(RULE).stroke();
  doc.fillColor(INK);
}

/** The printed tick box, marked or not. Never a colour-only distinction. */
function tickBox(doc: PDFKit.PDFDocument, x: number, y: number, marked: boolean, size = 7.5): void {
  doc.rect(x, y, size, size).lineWidth(0.6).strokeColor(RULE_STRONG).stroke();
  if (marked) {
    doc.save().lineWidth(1).strokeColor(INK)
      .moveTo(x + 1.4, y + 1.4).lineTo(x + size - 1.4, y + size - 1.4)
      .moveTo(x + size - 1.4, y + 1.4).lineTo(x + 1.4, y + size - 1.4)
      .stroke().restore();
  }
  doc.fillColor(INK);
}

// ---------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------

/** A bordered two-column label/value grid, as the paper form prints its header bands. */
function renderFields(cursor: Cursor, rows: { label: string; value: string }[]): void {
  const { doc, width } = cursor;
  const labelWidth = Math.min(150, width * 0.32);
  const valueWidth = width - labelWidth;
  for (const row of rows) {
    const height = Math.max(
      LINE + 4,
      textHeight(doc, row.value, valueWidth - 8, SIZE.body) + 6,
      textHeight(doc, row.label, labelWidth - 8, SIZE.body) + 6,
    );
    ensureRoom(cursor, height);
    const top = doc.y;
    box(doc, left, top, labelWidth, height, HEAD_FILL);
    box(doc, left + labelWidth, top, valueWidth, height);
    doc.font('Helvetica-Bold').fontSize(SIZE.body).fillColor(INK)
      .text(row.label, left + 4, top + 3, { width: labelWidth - 8 });
    doc.font('Helvetica').fontSize(SIZE.body).fillColor(INK)
      .text(row.value, left + labelWidth + 4, top + 3, { width: valueWidth - 8 });
    doc.x = left;
    doc.y = top + height;
  }
}

/**
 * A printed safety band: one row per question, one column per tick the
 * form actually offers. A YES/NO band gets no N/A column, so a response
 * the paper form cannot express is never drawn.
 */
function renderChecklist(cursor: Cursor, block: Extract<DocumentBlock, { kind: 'checklist' }>): void {
  const { doc, width } = cursor;
  const columns = block.columns ?? ['YES', 'NO'];
  const tickWidth = 34;
  const remarksWidth = block.items.some((item) => item.remarks) ? 110 : 0;
  const questionWidth = width - tickWidth * columns.length - remarksWidth;

  const header = (): void => {
    const top = doc.y;
    const height = LINE + 3;
    box(doc, left, top, questionWidth, height, HEAD_FILL);
    doc.font('Helvetica-Bold').fontSize(SIZE.small).fillColor(INK)
      .text('ITEM', left + 4, top + 3, { width: questionWidth - 8 });
    columns.forEach((column, index) => {
      const x = left + questionWidth + index * tickWidth;
      box(doc, x, top, tickWidth, height, HEAD_FILL);
      doc.font('Helvetica-Bold').fontSize(SIZE.small).fillColor(INK)
        .text(column === 'NA' ? 'N/A' : column, x, top + 3, { width: tickWidth, align: 'center' });
    });
    if (remarksWidth) {
      const x = left + questionWidth + tickWidth * columns.length;
      box(doc, x, top, remarksWidth, height, HEAD_FILL);
      doc.font('Helvetica-Bold').fontSize(SIZE.small).fillColor(INK)
        .text('REMARKS', x + 4, top + 3, { width: remarksWidth - 8 });
    }
    doc.x = left;
    doc.y = top + height;
  };

  ensureRoom(cursor, LINE * 3);
  header();

  for (const item of block.items) {
    const height = Math.max(
      LINE + 4,
      textHeight(doc, item.label, questionWidth - 8, SIZE.body) + 6,
      remarksWidth ? textHeight(doc, item.remarks ?? '', remarksWidth - 8, SIZE.small) + 6 : 0,
    );
    if (doc.y + height > bottomLimit(doc)) {
      doc.addPage();
      // The band continues on the next page, so its columns are named
      // again - a tick under an unlabelled column is not readable.
      header();
    }
    const top = doc.y;
    box(doc, left, top, questionWidth, height);
    doc.font('Helvetica').fontSize(SIZE.body).fillColor(INK)
      .text(item.label, left + 4, top + 3, { width: questionWidth - 8 });
    columns.forEach((column, index) => {
      const x = left + questionWidth + index * tickWidth;
      box(doc, x, top, tickWidth, height);
      tickBox(doc, x + tickWidth / 2 - 3.75, top + height / 2 - 3.75, item.response === column);
    });
    if (remarksWidth) {
      const x = left + questionWidth + tickWidth * columns.length;
      box(doc, x, top, remarksWidth, height);
      doc.font('Helvetica').fontSize(SIZE.small).fillColor(MUTED)
        .text(item.remarks ?? '', x + 4, top + 3, { width: remarksWidth - 8 });
    }
    doc.x = left;
    doc.y = top + height;
  }
  doc.fillColor(INK);
}

/** A printed tick band, laid out in the columns the paper form uses. */
function renderSelections(cursor: Cursor, block: Extract<DocumentBlock, { kind: 'selections' }>): void {
  const { doc, width } = cursor;
  if (block.items.length === 0) {
    ensureRoom(cursor, LINE);
    doc.font('Helvetica-Oblique').fontSize(SIZE.small).fillColor(MUTED).text('No entries recorded.', left);
    doc.fillColor(INK);
    return;
  }
  const columnCount = Math.max(1, block.columns ?? 3);
  const cellWidth = width / columnCount;

  for (let index = 0; index < block.items.length; index += columnCount) {
    const row = block.items.slice(index, index + columnCount);
    const height = Math.max(
      LINE + 3,
      ...row.map((item) => textHeight(doc, item.label, cellWidth - 20, SIZE.tick) + 5),
    );
    ensureRoom(cursor, height);
    const top = doc.y;
    row.forEach((item, column) => {
      const x = left + column * cellWidth;
      box(doc, x, top, cellWidth, height);
      tickBox(doc, x + 4, top + 3.5, item.selected);
      doc.font('Helvetica').fontSize(SIZE.tick).fillColor(INK)
        .text(item.remarks ? `${item.label} — ${item.remarks}` : item.label, x + 15, top + 3, { width: cellWidth - 20 });
    });
    doc.x = left;
    doc.y = top + height;
  }
}

/** A bordered table with a repeated header row. */
function renderTable(cursor: Cursor, block: Extract<DocumentBlock, { kind: 'table' }>): void {
  const { doc, width } = cursor;
  const columnWidth = width / block.columns.length;

  const header = (): void => {
    const height = Math.max(LINE + 3, ...block.columns.map((c) => textHeight(doc, c, columnWidth - 8, SIZE.small) + 5));
    const top = doc.y;
    block.columns.forEach((column, index) => {
      const x = left + index * columnWidth;
      box(doc, x, top, columnWidth, height, HEAD_FILL);
      doc.font('Helvetica-Bold').fontSize(SIZE.small).fillColor(INK)
        .text(column, x + 4, top + 3, { width: columnWidth - 8 });
    });
    doc.x = left;
    doc.y = top + height;
  };

  if (block.rows.length === 0) {
    ensureRoom(cursor, LINE * 2);
    header();
    ensureRoom(cursor, LINE);
    doc.font('Helvetica-Oblique').fontSize(SIZE.small).fillColor(MUTED).text('No entries recorded.', left);
    doc.fillColor(INK);
    return;
  }

  ensureRoom(cursor, LINE * 3);
  header();
  for (const row of block.rows) {
    const height = Math.max(
      LINE + 3,
      ...row.map((cell) => textHeight(doc, cell, columnWidth - 8, SIZE.small) + 5),
    );
    if (doc.y + height > bottomLimit(doc)) {
      doc.addPage();
      header();
    }
    const top = doc.y;
    row.forEach((cell, index) => {
      const x = left + index * columnWidth;
      box(doc, x, top, columnWidth, height);
      doc.font('Helvetica').fontSize(SIZE.small).fillColor(INK)
        .text(cell, x + 4, top + 3, { width: columnWidth - 8 });
    });
    doc.x = left;
    doc.y = top + height;
  }
}

/** The frozen digital authorizations, as bordered signature cards. */
function renderSignatures(cursor: Cursor, block: Extract<DocumentBlock, { kind: 'signatures' }>): void {
  const { doc, width } = cursor;
  if (block.entries.length === 0) {
    ensureRoom(cursor, LINE);
    doc.font('Helvetica-Oblique').fontSize(SIZE.small).fillColor(MUTED)
      .text('No authorizations have been recorded.', left);
    doc.fillColor(INK);
  }
  const cardWidth = width / 2;
  for (let index = 0; index < block.entries.length; index += 2) {
    const row = block.entries.slice(index, index + 2);
    const height = LINE * 4 + 6;
    ensureRoom(cursor, height);
    const top = doc.y;
    row.forEach((entry, column) => {
      const x = left + column * cardWidth;
      box(doc, x, top, cardWidth, height);
      doc.font('Helvetica-Bold').fontSize(SIZE.small).fillColor(INK)
        .text(entry.caption, x + 5, top + 4, { width: cardWidth - 10 });
      doc.font('Helvetica').fontSize(SIZE.body)
        .text(entry.name, x + 5, top + 4 + LINE, { width: cardWidth - 10 });
      doc.fontSize(SIZE.small).fillColor(MUTED)
        .text(entry.designation, x + 5, top + 4 + LINE * 2, { width: cardWidth - 10 })
        .text(`Signed digitally ${entry.signedAt}`, x + 5, top + 4 + LINE * 3, { width: cardWidth - 10 });
      doc.fillColor(INK);
    });
    doc.x = left;
    doc.y = top + height;
  }
  if (block.note) {
    ensureRoom(cursor, LINE * 2);
    doc.font('Helvetica-Oblique').fontSize(SIZE.small).fillColor(MUTED)
      .text(block.note, left, doc.y + 3, { width });
    doc.fillColor(INK);
  }
}

function renderBlock(cursor: Cursor, block: DocumentBlock): void {
  switch (block.kind) {
    case 'fields':
      renderFields(cursor, block.rows);
      break;
    case 'checklist':
      renderChecklist(cursor, block);
      break;
    case 'selections':
      renderSelections(cursor, block);
      break;
    case 'table':
      renderTable(cursor, block);
      break;
    case 'paragraph':
      ensureRoom(cursor, LINE * 2);
      cursor.doc.font('Helvetica').fontSize(SIZE.body).fillColor(INK)
        .text(block.text, left, cursor.doc.y, { width: cursor.width });
      break;
    case 'signatures':
      renderSignatures(cursor, block);
      break;
  }
}

// ---------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------

function renderMasthead(cursor: Cursor, page: DocumentPage): void {
  const { doc, width } = cursor;
  const head = page.masthead;
  const top = doc.y;
  const height = 38;
  box(doc, left, top, width, height);
  if (head) {
    doc.font('Helvetica').fontSize(SIZE.issuer).fillColor(MUTED)
      .text(head.issuer, left + 6, top + 5, { width: width - 160 });
    doc.font('Helvetica-Bold').fontSize(SIZE.masthead).fillColor(INK)
      .text(head.title, left + 6, top + 16, { width: width - 160 });
    const meta = [head.reference, head.pageLabel].filter((value): value is string => Boolean(value));
    if (meta.length > 0) {
      doc.font('Helvetica-Bold').fontSize(SIZE.small).fillColor(MUTED)
        .text(meta.join('  ·  '), left + width - 156, top + 16, { width: 150, align: 'right' });
    }
  } else {
    doc.font('Helvetica-Bold').fontSize(SIZE.masthead).fillColor(INK)
      .text(page.title, left + 6, top + 12, { width: width - 12 });
  }
  doc.x = left;
  doc.y = top + height;
  doc.fillColor(INK);
}

/** The identity band: four server-derived cells across the page. */
function renderIdentity(cursor: Cursor, rows: { label: string; value: string }[]): void {
  const { doc, width } = cursor;
  if (rows.length === 0) return;
  const cellWidth = width / rows.length;
  const top = doc.y;
  const height = LINE * 2 + 4;
  rows.forEach((row, index) => {
    const x = left + index * cellWidth;
    box(doc, x, top, cellWidth, height);
    doc.font('Helvetica-Bold').fontSize(SIZE.small).fillColor(MUTED)
      .text(row.label, x + 5, top + 3, { width: cellWidth - 10 });
    doc.font('Helvetica-Bold').fontSize(SIZE.body).fillColor(INK)
      .text(row.value, x + 5, top + 3 + LINE, { width: cellWidth - 10 });
  });
  doc.x = left;
  doc.y = top + height;
}

function renderSection(cursor: Cursor, section: DocumentSection): void {
  const { doc, width } = cursor;
  // Keep a heading with a meaningful amount of its first block rather
  // than stranding it at the foot of a page.
  ensureRoom(cursor, LINE * 4);
  const top = doc.y + 4;
  const heading = section.number ? `${section.number}.  ${section.title}` : section.title;
  const height = textHeight(doc, heading, width - 10, SIZE.section) + 6;
  doc.rect(left, top, width, height).fill(RULE_STRONG);
  doc.font('Helvetica-Bold').fontSize(SIZE.section).fillColor('#ffffff')
    .text(heading, left + 5, top + 3, { width: width - 10 });
  doc.fillColor(INK);
  doc.x = left;
  doc.y = top + height;
  for (const block of section.blocks) renderBlock(cursor, block);
  doc.y += 6;
}

// ---------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------

/**
 * Renders the combined Permit + JSA document in the confirmed immutable
 * order - Permit page(s), then JSA page 1, then JSA page 2 - from the
 * snapshot alone.
 */
export function renderIssuedPermitPdfV3(
  snapshot: IssuedPermitSnapshot,
  pages: DocumentPage[],
  rendererVersion: string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const authoritativeDate = new Date(snapshot.issuanceOccurredAt);
    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      bufferPages: true,
      info: {
        Title: `Permit ${snapshot.permitNumber}`,
        CreationDate: authoritativeDate,
        ModDate: authoritativeDate,
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - PAGE_MARGIN * 2;
    const cursor: Cursor = { doc, width };

    // The masthead and identity band repeat on every physical page of a
    // logical page, so a sheet that continues a band still says which
    // permit it belongs to.
    let current: DocumentPage | undefined;
    let suppressHeader = false;
    doc.on('pageAdded', () => {
      if (suppressHeader || !current) return;
      doc.x = left;
      doc.y = PAGE_MARGIN;
      renderMasthead(cursor, current);
      if (current.identity) renderIdentity(cursor, current.identity);
      doc.y += 4;
    });

    pages.forEach((page, index) => {
      current = page;
      if (index > 0) {
        suppressHeader = true;
        doc.addPage();
        suppressHeader = false;
        doc.x = left;
        doc.y = PAGE_MARGIN;
      }
      renderMasthead(cursor, page);
      if (page.identity) renderIdentity(cursor, page.identity);
      doc.y += 4;
      for (const section of page.sections) renderSection(cursor, section);
      if (page.footerNote) {
        ensureRoom(cursor, LINE * 2);
        doc.font('Helvetica').fontSize(SIZE.small).fillColor(MUTED)
          .text(page.footerNote, left, doc.y + 4, { width });
        doc.fillColor(INK);
      }
    });

    /*
      The footer strip, stamped once every physical page exists so
      "Page n of m" can be true. `bufferPages` makes this a deterministic
      second pass over pages already laid out - nothing is measured
      against anything outside the snapshot.
    */
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      const y = doc.page.height - PAGE_MARGIN - 12;
      doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.5).strokeColor(RULE).stroke();
      doc.font('Helvetica').fontSize(SIZE.small - 0.5).fillColor(MUTED)
        .text(
          `Permit ${snapshot.permitNumber} · JSA ${snapshot.jsaNumber} · snapshot ${snapshot.snapshotTakenAt} · renderer ${rendererVersion}`,
          left,
          y + 3,
          { width: width - 60 },
        )
        .text(`Page ${index + 1} of ${range.count}`, left + width - 60, y + 3, { width: 60, align: 'right' });
    }
    // Leaves no buffered page selected mid-write.
    doc.flushPages();

    doc.end();
  });
}
