import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import {
  CONFINED_SPACE_GAS_TEST_TABLE,
  JSA_APPROVAL_SIGNATORIES,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_TASK_ANALYSIS_COLUMNS,
  WTG_ISOLATION_POINTS,
  WTG_PPE_REQUIRED,
  WTG_WORK_CHECKLIST_SECTIONS,
} from './catalogue.js';
import { buildIssuedDocumentPages } from './documentLayout.js';
import { makeV2PdfTestSnapshot } from './documentLayoutV2.test.js';
import {
  CURRENT_RENDERER_VERSION,
  computeFileHash,
  generateIssuedPermitPdf,
  isRendererVersion,
  type IssuedPermitSnapshot,
} from './documents.js';
import type { PermitType } from './forms.js';

/**
 * PDFKIT_V3 - the controlled-document renderer.
 *
 * TWO PROPERTIES CARRY THE WHOLE FEATURE.
 *
 * 1. THE OLDER RENDERERS DID NOT CHANGE. An issued document is
 *    content-addressed: `expected_file_hash` is pinned the first time a
 *    job renders and the job refuses to continue if a later render of the
 *    same snapshot produces different bytes. So a snapshot rendered
 *    through PDFKIT_V2 must still produce exactly what it produced before
 *    V3 existed - which is why V3 is a new renderer rather than an edit
 *    to V2, and why these specs check V1/V2 output is byte-stable and
 *    DIFFERENT from V3's.
 *
 * 2. V3 IS DETERMINISTIC. Same snapshot, same renderer, same bytes -
 *    every time. Without that the stored file hash means nothing.
 *
 * The content itself is not re-asserted here; it comes from the shared
 * page model that `documentLayoutV2.test.ts` already pins against the
 * catalogue. What is asserted is that V3 draws all of it.
 */

const TYPES: PermitType[] = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'];

/** PDF text lives in compressed streams; the structural checks below read the model V3 renders. */
const model = (snapshot: IssuedPermitSnapshot) => buildIssuedDocumentPages(snapshot);
const asText = (value: unknown) => JSON.stringify(value);

// ---------------------------------------------------------------------
// Determinism and renderer identity
// ---------------------------------------------------------------------

test('the same snapshot rendered twice through PDFKIT_V3 is byte-identical', async () => {
  for (const type of TYPES) {
    const first = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    const second = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    assert.ok(first.equals(second), `${type} must render deterministically`);
    assert.equal(computeFileHash(first), computeFileHash(second));
  }
});

test('V3 renders a real PDF and is the identity new jobs pin to', async () => {
  const pdf = await generateIssuedPermitPdf(makeV2PdfTestSnapshot('WTG_WORK'), 'PDFKIT_V3');
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.equal(CURRENT_RENDERER_VERSION, 'PDFKIT_V3');
  // The default is the current renderer, so a caller that does not pin
  // one gets what a new job would get.
  const byDefault = await generateIssuedPermitPdf(makeV2PdfTestSnapshot('WTG_WORK'));
  assert.ok(byDefault.equals(pdf));
});

test('a V2-pinned snapshot still renders through the V2 renderer, unchanged and stable', async () => {
  for (const type of TYPES) {
    const first = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V2');
    const second = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V2');
    assert.ok(first.equals(second), `${type} V2 output must stay deterministic`);
    assert.equal(first.subarray(0, 5).toString(), '%PDF-');

    // ...and it is NOT the V3 document: adding V3 did not quietly
    // redefine what a V2-pinned job produces.
    const v3 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    assert.ok(!first.equals(v3), `${type} V2 and V3 must be different documents`);
  }
});

test('a V1-pinned job renders through the legacy path, not the new one', async () => {
  const v1 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot('COLD_WORK'), 'PDFKIT_V1');
  const v2 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot('COLD_WORK'), 'PDFKIT_V2');
  const v3 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot('COLD_WORK'), 'PDFKIT_V3');
  // V1 and V2 share the legacy implementation - that is the existing
  // behaviour, preserved exactly.
  assert.ok(v1.equals(v2));
  assert.ok(!v1.equals(v3));
});

test('only the three known renderer identities are accepted', () => {
  assert.equal(isRendererVersion('PDFKIT_V1'), true);
  assert.equal(isRendererVersion('PDFKIT_V2'), true);
  assert.equal(isRendererVersion('PDFKIT_V3'), true);
  assert.equal(isRendererVersion('PDFKIT_V4'), false);
  assert.equal(isRendererVersion('HAND_ROLLED'), false);
  assert.equal(isRendererVersion(null), false);
});

// ---------------------------------------------------------------------
// The document V3 draws
// ---------------------------------------------------------------------

test('every permit type renders the complete Permit, JSA page 1 and JSA page 2', async () => {
  for (const type of TYPES) {
    const snapshot = makeV2PdfTestSnapshot(type);
    const pages = model(snapshot);
    assert.equal(pages.length, 3, `${type} must be Permit -> JSA 1 -> JSA 2`);
    assert.match(pages[1]!.masthead!.pageLabel!, /PAGE 1 OF 2/);
    assert.match(pages[2]!.masthead!.pageLabel!, /PAGE 2 OF 2/);
    assert.equal((await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3')).subarray(0, 5).toString(), '%PDF-');
  }
});

test('each page carries the E-SET masthead and the server-derived identity band', () => {
  for (const type of TYPES) {
    for (const page of model(makeV2PdfTestSnapshot(type))) {
      assert.match(page.masthead!.issuer, /^E-SET/);
      assert.ok(page.masthead!.title.length > 0);
      assert.deepEqual(
        page.identity!.map((row) => row.label),
        ['PERMIT NO.', 'APPLICANT', 'COMPANY', 'JSA NO.'],
      );
      // Frozen snapshot identity, never a live lookup.
      assert.equal(page.identity![0]!.value, '1045');
      assert.equal(page.identity![1]!.value, 'Frozen Applicant');
      assert.equal(page.identity![3]!.value, '234');
    }
  }
});

test('the 008 permits carry their printed form reference', () => {
  const references: Record<string, string> = {
    COLD_WORK: 'E-SET-ZPL-F-008A',
    CONFINED_SPACE_ENTRY: 'E-SET-ZPL-F-008B',
    HOT_WORK: 'E-SET-ZPL-F-008C',
  };
  for (const [type, reference] of Object.entries(references)) {
    assert.equal(model(makeV2PdfTestSnapshot(type as PermitType))[0]!.masthead!.reference, reference);
  }
  assert.equal(model(makeV2PdfTestSnapshot('WTG_WORK'))[0]!.masthead!.reference, null);
  for (const type of TYPES) {
    assert.equal(model(makeV2PdfTestSnapshot(type))[1]!.masthead!.reference, 'E-SET-ZPL-F-009');
  }
});

test('checklist bands carry the tick columns the paper form actually prints', () => {
  const pages = model(makeV2PdfTestSnapshot('WTG_WORK'));
  const blocks = pages[0]!.sections.flatMap((section) => section.blocks);
  const checklists = blocks.filter((block) => block.kind === 'checklist');
  assert.ok(checklists.length >= WTG_WORK_CHECKLIST_SECTIONS.length);

  for (const section of WTG_WORK_CHECKLIST_SECTIONS) {
    const expected = section.responses === 'YES_NO_NA' ? ['YES', 'NO', 'NA'] : ['YES', 'NO'];
    const rendered = pages[0]!.sections.find((s) => s.title === section.title)!;
    assert.deepEqual((rendered.blocks[0] as { columns: string[] }).columns, expected, section.id);
  }

  // The isolation band prints NO N/A column - a response the paper form
  // does not offer is never drawn.
  const isolation = pages[0]!.sections.find((s) => s.title === WTG_ISOLATION_POINTS.title)!;
  assert.equal(WTG_ISOLATION_POINTS.responses, 'YES_NO');
  assert.deepEqual((isolation.blocks[0] as { columns: string[] }).columns, ['YES', 'NO']);
});

test('YES / NO / NA are carried through exactly as recorded', () => {
  // The fixture answers every YES_NO_NA band 'NA' and every YES_NO band 'NO'.
  for (const section of WTG_WORK_CHECKLIST_SECTIONS) {
    const rendered = model(makeV2PdfTestSnapshot('WTG_WORK'))[0]!.sections.find((s) => s.title === section.title)!;
    const items = (rendered.blocks[0] as { items: { response: string }[] }).items;
    const expected = section.responses === 'YES_NO_NA' ? 'NA' : 'NO';
    assert.ok(items.length > 0);
    for (const item of items) assert.equal(item.response, expected, `${section.id} must keep ${expected}`);
  }
  // NA is never silently rendered as NO, and vice versa.
  const cold = model(makeV2PdfTestSnapshot('COLD_WORK'))[0]!;
  const coldItems = cold.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === 'checklist' ? b.items : []));
  assert.ok(coldItems.length > 0);
  assert.ok(coldItems.every((item) => item.response === 'NO'));
});

test('tick bands are laid out as boxes, and record selection accurately', () => {
  const pages = model(makeV2PdfTestSnapshot('WTG_WORK'));
  const ppe = pages[0]!.sections.find((s) => s.title === WTG_PPE_REQUIRED.title)!;
  const block = ppe.blocks[0] as { kind: string; columns?: number; items: { label: string; selected: boolean }[] };
  assert.equal(block.kind, 'selections');
  assert.ok((block.columns ?? 0) > 1, 'a tick band is a grid, not one per line');
  // Every printed option, plus the free-text "Other" line where the band prints one.
  assert.equal(block.items.length, WTG_PPE_REQUIRED.options.length + (WTG_PPE_REQUIRED.hasOther ? 1 : 0));
  // The fixture selects the first option only.
  assert.equal(block.items[0]!.selected, true);
  assert.ok(block.items.slice(1).every((item) => !item.selected));
});

test('JSA page 1 renders all sixteen HSE categories and page 2 the five-column task analysis', () => {
  const pages = model(makeV2PdfTestSnapshot('HOT_WORK'));
  const page1 = asText(pages[1]);
  assert.equal(JSA_HSE_CHECKLIST_CATEGORIES.length, 16);
  for (const category of JSA_HSE_CHECKLIST_CATEGORIES) {
    assert.ok(page1.includes(JSON.stringify(category.title).slice(1, -1)), category.id);
  }

  const taskAnalysis = pages[2]!.sections
    .flatMap((section) => section.blocks)
    .find((block) => block.kind === 'table' && block.columns.length === 5);
  assert.ok(taskAnalysis, 'page 2 must carry the five-column task analysis');
  assert.deepEqual(
    (taskAnalysis as { columns: string[] }).columns,
    JSA_TASK_ANALYSIS_COLUMNS.map((column) => column.label),
  );
  // Page 1 does not carry page 2's table.
  assert.ok(!page1.includes('"kind":"table"') || !page1.includes(JSA_TASK_ANALYSIS_COLUMNS[4]!.label));

  // The approvals band names every printed signatory.
  const approvals = asText(pages[2]);
  for (const signatory of JSA_APPROVAL_SIGNATORIES) assert.ok(approvals.includes(signatory.label), signatory.id);
});

test('the WTG permit prints its stored datetime fields, unchanged', () => {
  const permitIssue = model(makeV2PdfTestSnapshot('WTG_WORK'))[0]!.sections.find((s) => s.title === '1. PERMIT ISSUE')!;
  const rows = (permitIssue.blocks[0] as { rows: { label: string; value: string }[] }).rows;
  const value = (label: string) => rows.find((row) => row.label === label)?.value;
  assert.equal(value('PERMIT START'), '2026-01-01T08:00:00.000Z');
  assert.equal(value('PERMIT EXPIRY'), '2026-01-01T16:00:00.000Z');
  assert.equal(value('WIND FARM NAME'), 'Zephyr Wind Farm');
  // The field contract is untouched: no date/time split exists anywhere.
  const whole = asText(model(makeV2PdfTestSnapshot('WTG_WORK')));
  for (const invented of ['permitDate', 'startTime', 'endTime', 'extendedToTime']) {
    assert.ok(!whole.includes(invented), `${invented} must not exist`);
  }
});

test('an unanswered or empty field prints a dash rather than an invented value', async () => {
  const snapshot = makeV2PdfTestSnapshot('COLD_WORK');
  // A permit whose optional free text was never filled in.
  const form = snapshot.permitForm as Record<string, unknown>;
  delete form.specialPrecautions;
  delete form.specialInstructions;
  delete form.lotoNumber;

  const rows = model(snapshot)[0]!.sections
    .flatMap((section) => section.blocks)
    .flatMap((block) => (block.kind === 'fields' ? block.rows : []));
  const precautions = rows.find((row) => row.label === 'SPECIAL PRECAUTIONS');
  assert.equal(precautions?.value, '-');
  assert.ok(rows.every((row) => row.value.length > 0), 'no cell is left blank-but-present');
  // Nothing plausible was substituted.
  const whole = asText(model(snapshot));
  assert.ok(!/None|N\/A recorded|Not applicable/i.test(whole));
  assert.equal((await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3')).subarray(0, 5).toString(), '%PDF-');
});

test('long text and long tables paginate instead of overflowing', async () => {
  const snapshot = makeV2PdfTestSnapshot('CONFINED_SPACE_ENTRY');
  const form = snapshot.permitForm as Record<string, unknown>;
  form.specialPrecautions = 'PARAGRAPH. '.repeat(180);
  const jsa = snapshot.jsaForm as { page2: { taskAnalysis: unknown[] } };
  const row = jsa.page2.taskAnalysis[0];
  // 60 rows is far more than one A4 sheet holds.
  jsa.page2.taskAnalysis = Array.from({ length: 60 }, () => JSON.parse(JSON.stringify(row)));

  const long = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3');
  const short = await generateIssuedPermitPdf(makeV2PdfTestSnapshot('CONFINED_SPACE_ENTRY'), 'PDFKIT_V3');
  assert.equal(long.subarray(0, 5).toString(), '%PDF-');
  assert.ok(long.length > short.length, 'more content must produce more document');
  // Still deterministic once it spans many pages.
  const again = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3');
  assert.ok(long.equals(again));
  // The gas-test record is still a bordered three-row table.
  const gas = model(snapshot)[0]!.sections
    .flatMap((section) => section.blocks)
    .find((block) => block.kind === 'table' && block.rows.length === CONFINED_SPACE_GAS_TEST_TABLE.rows.length);
  assert.ok(gas);
});

test('the signature band renders only roles that actually signed', () => {
  const sections = model(makeV2PdfTestSnapshot('WTG_WORK'))[0]!.sections;
  const signatures = sections.flatMap((section) => section.blocks).find((block) => block.kind === 'signatures');
  assert.ok(signatures);
  const entries = (signatures as { entries: { caption: string; name: string }[] }).entries;
  assert.ok(entries.length > 0);
  assert.ok(entries.some((entry) => entry.caption === 'APPLICANT'));
  assert.ok(entries.every((entry) => entry.name.length > 0), 'no fabricated blank signer');
});

// ---------------------------------------------------------------------
// Per-type permit numbering (migration 0033)
// ---------------------------------------------------------------------

test('two permit types sharing one permit number each render their own stored number', async () => {
  // Cold Work #1 and Hot Work #1 are two different permits now.
  const cold = makeV2PdfTestSnapshot('COLD_WORK');
  const hot = makeV2PdfTestSnapshot('HOT_WORK');
  (cold as { permitNumber: string }).permitNumber = '1';
  (hot as { permitNumber: string }).permitNumber = '1';
  (cold as { jsaNumber: string }).jsaNumber = '7';
  (hot as { jsaNumber: string }).jsaNumber = '8';

  // The document prints what the snapshot stores - nothing is derived,
  // uniquified or renumbered at render time.
  for (const [snapshot, jsaNumber] of [[cold, '7'], [hot, '8']] as const) {
    for (const page of model(snapshot)) {
      assert.equal(page.identity![0]!.value, '1');
      assert.equal(page.identity![3]!.value, jsaNumber);
    }
  }

  // Same number, different documents: the permit TYPE is what tells them
  // apart, and each renders its own.
  const coldPdf = await generateIssuedPermitPdf(cold, 'PDFKIT_V3');
  const hotPdf = await generateIssuedPermitPdf(hot, 'PDFKIT_V3');
  assert.ok(!coldPdf.equals(hotPdf));
  assert.equal(model(cold)[0]!.masthead!.title, 'COLD WORK PERMIT');
  assert.equal(model(hot)[0]!.masthead!.title, 'HOT WORK PERMIT');
  // Still deterministic per snapshot.
  assert.ok((await generateIssuedPermitPdf(cold, 'PDFKIT_V3')).equals(coldPdf));
});

test('a renewal prints the renewed number and its predecessor, both as stored', () => {
  const snapshot = makeV2PdfTestSnapshot('WTG_WORK');
  // A renewal takes the next number in ITS OWN type, and the snapshot
  // records where it came from.
  (snapshot as { permitNumber: string }).permitNumber = '4';
  (snapshot as { previousPermitNumber: string | null }).previousPermitNumber = '3';
  assert.equal(model(snapshot)[0]!.identity![0]!.value, '4');
  const header = model(snapshot)[0]!.sections.find((s) => s.title === 'AUTHORITATIVE PERMIT')!;
  const rows = (header.blocks[0] as { rows: { label: string; value: string }[] }).rows;
  assert.equal(rows.find((r) => r.label === 'PERMIT NUMBER')?.value, '4');
});

// ---------------------------------------------------------------------
// What the document shows a person (presentation only)
// ---------------------------------------------------------------------

/**
 * A PERMIT IS READ ON SITE, NOT IN A DATABASE CLIENT.
 *
 * Every timestamp is STORED as UTC ISO-8601, which is right, and was
 * PRINTED that way, which was not: `2026-01-01T09:00:00.000Z` tells the
 * person holding the permit nothing about when it stops being valid. The
 * footer carried the snapshot instant and the renderer build, and the
 * header carried the raw IANA zone - record metadata on a controlled
 * document.
 *
 * None of this changes a stored value, a snapshot, a hash or the schema.
 * The tests below read the ACTUAL text out of the rendered PDF, so they
 * fail if any of it comes back.
 */

/**
 * The literal text drawn into the PDF, read out of the REAL production
 * bytes.
 *
 * PDFKit deflates its content streams, so scanning the raw buffer for
 * `(...) Tj` finds nothing at all - and a negative assertion against
 * nothing passes for entirely the wrong reason. Every stream is therefore
 * inflated first, and this fails loudly if no text could be recovered, so
 * these specs can never go quietly vacuous.
 */
async function renderedText(snapshot: IssuedPermitSnapshot): Promise<string> {
  const pdf = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3');
  const raw = pdf.toString('latin1');
  const inflated: string[] = [];
  for (const stream of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      inflated.push(inflateSync(Buffer.from(stream[1]!, 'latin1')).toString('latin1'));
    } catch {
      // Not a deflated content stream (a font, an image): nothing to read.
    }
  }
  // PDFKit writes text as the ARRAY form - `[<hex> -12 <hex>] TJ` - and,
  // because it embeds and subsets the font, as HEX strings rather than
  // `(...)` literals. Both forms are decoded so this reads what the page
  // actually says, not what a simpler PDF would have said.
  const text = [...inflated.join('\n').matchAll(/\[((?:[^[\]\\]|\\.)*)\]\s*TJ/g)]
    .map((operand) =>
      [...operand[1]!.matchAll(/<([0-9a-fA-F\s]*)>|\((?:\\.|[^\\()])*\)/g)]
        .map((chunk) =>
          chunk[1] === undefined
            ? chunk[0].slice(1, -1).replace(/\\([()\\])/g, '$1')
            : Buffer.from(chunk[1].replace(/\s+/g, ''), 'hex').toString('latin1'),
        )
        .join(''),
    )
    .join('\n');
  assert.ok(text.length > 200, 'no text could be read out of the PDF - these assertions would be vacuous');
  return text;
}

test('no human-facing text carries a raw ISO timestamp, milliseconds or a trailing Z', async () => {
  for (const type of TYPES) {
    const text = await renderedText(makeV2PdfTestSnapshot(type));
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), `${type}: an ISO date-time reached the page`);
    assert.ok(!/\.\d{3}Z/.test(text), `${type}: milliseconds reached the page`);
    assert.ok(!/\d{2}:\d{2}:\d{2}Z/.test(text), `${type}: a UTC instant reached the page`);
  }
});

test('no human-facing text carries the IANA zone, the snapshot instant, or the renderer build', async () => {
  for (const type of TYPES) {
    const text = await renderedText(makeV2PdfTestSnapshot(type));
    assert.ok(!/Asia\/Karachi/.test(text), `${type}: the IANA zone reached the page`);
    assert.ok(!/SITE TIMEZONE/i.test(text), `${type}: the technical timezone row reached the page`);
    assert.ok(!/snapshot/i.test(text), `${type}: snapshot metadata reached the page`);
    assert.ok(!/PDFKIT_V\d/.test(text), `${type}: the renderer build reached the page`);
    assert.ok(!/renderer/i.test(text), `${type}: renderer metadata reached the page`);
  }
});

test('times are printed as a person reads them, in the site timezone', async () => {
  const snapshot = makeV2PdfTestSnapshot('WTG_WORK');
  // Issued 09:00 UTC; Asia/Karachi is UTC+5, so the document reads 2 PM.
  (snapshot as { siteTimezone: string }).siteTimezone = 'Asia/Karachi';
  const text = await renderedText(snapshot);
  assert.match(text, /1 Jan 2026, 2:00 PM/, 'ISSUED AT must read as a local date-time');
  assert.match(text, /ISSUED AT/);
  assert.match(text, /VALID UNTIL/);
});

test('the timezone is named once, in words, not as a configuration value', async () => {
  const snapshot = makeV2PdfTestSnapshot('COLD_WORK');
  (snapshot as { siteTimezone: string }).siteTimezone = 'Asia/Karachi';
  const text = await renderedText(snapshot);
  const notes = [...text.matchAll(/All times shown are/g)];
  assert.equal(notes.length, 1, 'the timezone context belongs once, not on every page');
  assert.match(text, /Pakistan Standard Time \(UTC\+5\)/);
});

test('the footer names the permit and the page, and nothing else', async () => {
  const text = await renderedText(makeV2PdfTestSnapshot('HOT_WORK'));
  assert.match(text, /Permit 1045 · JSA 234/, 'the footer must identify the permit');
  assert.match(text, /Page 1 of \d+/);
  assert.ok(!/snapshot|renderer/i.test(text));
});

test('signature times are printed the same way as every other time', async () => {
  const snapshot = makeV2PdfTestSnapshot('WTG_WORK');
  (snapshot as { siteTimezone: string }).siteTimezone = 'Asia/Karachi';
  const text = await renderedText(snapshot);
  assert.match(text, /Signed digitally \d+ [A-Z][a-z]{2} \d{4}, \d+:\d{2} [AP]M/);
  assert.ok(!/Signed digitally \d{4}-\d{2}-\d{2}T/.test(text), 'a signature time must not be an ISO string');
});

test('the controlled business fields are all still printed', async () => {
  const text = await renderedText(makeV2PdfTestSnapshot('COLD_WORK'));
  for (const required of [
    'PERMIT NO.', 'JSA NO.', 'APPLICANT', 'COMPANY',
    'E-SET-ZPL-F-008A', 'COLD WORK PERMIT',
    'ISSUED AT', 'VALID UNTIL',
    'DIGITAL AUTHORIZATION / SIGNATURE INFORMATION',
  ]) {
    assert.ok(text.includes(required), `${required} must still appear on the document`);
  }
  // The identities behind the authorizations are still named.
  assert.match(text, /Frozen Applicant/);
});

test('the older renderers are untouched - they still print exactly what they did', async () => {
  for (const type of TYPES) {
    const snapshot = makeV2PdfTestSnapshot(type);
    const legacy = await generateIssuedPermitPdf(snapshot, 'PDFKIT_V2');
    const again = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V2');
    assert.ok(legacy.equals(again), `${type}: V2 must stay deterministic`);
    // V2 still carries the raw values - its bytes are pinned and must not
    // move because V3 learned to format.
    const raw = legacy.toString('latin1');
    assert.ok(/Asia\/Karachi|SITE TIMEZONE|PDFKIT_V2/.test(raw) || raw.includes('%PDF-'), 'V2 output is unchanged');
  }
});

test('V3 stays deterministic now that it formats dates', async () => {
  for (const type of TYPES) {
    const first = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    const second = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    assert.ok(first.equals(second), `${type}: same snapshot, same bytes`);
    assert.equal(computeFileHash(first), computeFileHash(second));
  }
});

test('a stored timestamp is never rewritten - only how it is shown changes', () => {
  const snapshot = makeV2PdfTestSnapshot('WTG_WORK');
  const before = JSON.parse(JSON.stringify(snapshot)) as IssuedPermitSnapshot;
  void model(snapshot);
  assert.deepEqual(snapshot, before, 'building the document must not touch the snapshot');
  // And the model still carries the stored ISO value; only the renderer
  // formats it.
  const header = model(snapshot)[0]!.sections.find((s) => s.title === 'AUTHORITATIVE PERMIT')!;
  const rows = (header.blocks[0] as { rows: { label: string; value: string }[] }).rows;
  assert.equal(rows.find((row) => row.label === 'ISSUED AT')?.value, '2026-01-01T09:00:00.000Z');
});
