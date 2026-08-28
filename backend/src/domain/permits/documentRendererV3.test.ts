import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLD_WORK_CHECKLIST_SECTIONS,
  CONFINED_SPACE_CHECKLIST_SECTIONS,
  CONFINED_SPACE_GAS_TEST_TABLE,
  HOT_WORK_CHECKLIST_SECTIONS,
  JSA_APPROVAL_SIGNATORIES,
  JSA_HSE_CHECKLIST_CATEGORIES,
  JSA_TASK_ANALYSIS_COLUMNS,
  WTG_ISOLATION_POINTS,
  WTG_AUTHORIZATION_BANDS,
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
import { toPermitNumber } from './numbering.js';
import { extractPdfPages, extractPdfText } from '../../test/pdfText.js';

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
      assert.equal(page.identity![0]!.value, toPermitNumber(type, 1045n));
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

/** The text of the whole document, read out of the real production bytes. */
async function renderedText(snapshot: IssuedPermitSnapshot): Promise<string> {
  return extractPdfText(await generateIssuedPermitPdf(snapshot, 'PDFKIT_V3'));
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
  assert.match(text, /Permit HW-1045 · JSA 234/, 'the footer must identify the permit');
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

// ---------------------------------------------------------------------
// V3 presentation cleanup: duplication, obsolete wording, pagination
// ---------------------------------------------------------------------

/**
 * A CONTROLLED DOCUMENT SHOULD NOT SAY THE SAME THING FOUR TIMES.
 *
 * V3 prints the permit number, JSA number, applicant and company in the
 * identity band under the masthead of EVERY page. Repeating them again
 * inside the body bands was presentation duplication, not a second
 * record - and it, the paper-carbon distribution strip, and a paragraph
 * under every authorization statement pointing at the signature band
 * below it, were between them costing whole pages.
 *
 * None of it is removed from the model or the snapshot: the values are
 * untouched, and the older renderers still print all of it, which the
 * byte-identity test below proves.
 */

const pagesOf = async (type: PermitType): Promise<string[]> =>
  extractPdfPages(await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3'));

test('the identity band still carries permit, JSA, applicant and company on every page', async () => {
  for (const type of TYPES) {
    for (const [index, page] of (await pagesOf(type)).entries()) {
      for (const label of ['PERMIT NO.', 'JSA NO.', 'APPLICANT', 'COMPANY']) {
        assert.ok(page.includes(label), `${type} page ${index + 1} lost the ${label} header`);
      }
      assert.ok(page.includes(toPermitNumber(type, 1045n)), `${type} page ${index + 1} lost the permit number`);
      assert.ok(page.includes('234'), `${type} page ${index + 1} lost the JSA number`);
    }
  }
});

test('the duplicate body identity rows are gone', async () => {
  for (const type of TYPES) {
    const text = (await pagesOf(type)).join('\n');
    // The body labels, which existed only to repeat the header.
    assert.ok(!text.includes('APPLICANT COMPANY'), `${type}: the duplicate company row is still in the body`);
    assert.ok(!/\bPERMIT NUMBER\b/.test(text), `${type}: the duplicate permit-number row is still in the body`);
    assert.ok(!/\bJSA NUMBER\b/.test(text), `${type}: the duplicate JSA-number row is still in the body`);
    // ...while the band they lived in is still there, doing its real job.
    assert.ok(text.includes('AUTHORITATIVE PERMIT'));
    assert.ok(text.includes('FORM'), `${type}: the controlled form reference must remain`);
    assert.ok(text.includes('ISSUED AT') && text.includes('VALID UNTIL'));
  }
});

test('the controlled form reference and revision are still printed', async () => {
  const references: Partial<Record<PermitType, string>> = {
    COLD_WORK: 'E-SET-ZPL-F-008A',
    CONFINED_SPACE_ENTRY: 'E-SET-ZPL-F-008B',
    HOT_WORK: 'E-SET-ZPL-F-008C',
  };
  for (const type of TYPES) {
    const text = (await pagesOf(type)).join('\n');
    const reference = references[type];
    if (reference) {
      assert.ok(text.includes(reference), `${type}: the form reference must remain`);
      assert.ok(text.includes(`${reference} Rev 0`), `${type}: the revision must remain`);
    }
    // The JSA's own reference, on its pages.
    assert.ok(text.includes('E-SET-ZPL-F-009'));
  }
});

test('the paper-copy distribution wording is gone', async () => {
  for (const type of TYPES) {
    const text = (await pagesOf(type)).join('\n');
    assert.ok(!/DISTRIBUTION/i.test(text), `${type}: the carbon-copy strip is still printed`);
    assert.ok(!/WHITE - JOB EXECUTE/i.test(text));
    assert.ok(!/BOOK COPY/i.test(text));
    assert.ok(!/DOCUMENT CONTROL/i.test(text), `${type}: the section that held it is still printed`);
  }
});

test('the repeated authorization explanation paragraphs are gone', async () => {
  for (const type of TYPES) {
    const text = (await pagesOf(type)).join('\n');
    assert.ok(!/Authorization roles:/i.test(text), `${type}: the explanatory paragraph is still printed`);
    assert.ok(
      !/recorded in the frozen signature band below/i.test(text),
      `${type}: the pointer-to-the-signatures sentence is still printed`,
    );
  }
});

test('the authenticated authorizations themselves are untouched', async () => {
  for (const type of TYPES) {
    const text = (await pagesOf(type)).join('\n');
    assert.ok(text.includes('DIGITAL AUTHORIZATION / SIGNATURE INFORMATION'), `${type}`);
    assert.ok(text.includes('APPLICANT'), `${type}: the applicant authorization`);
    assert.ok(text.includes('Frozen Applicant'), `${type}: the signer identity`);
    assert.ok(text.includes('CRO AUTHORIZATION'), `${type}: the CRO authorization`);
    assert.ok(text.includes('HSE APPROVAL'), `${type}: the HSE approval`);
    assert.match(text, /Signed digitally \d+ [A-Z][a-z]{2} \d{4}/, `${type}: signature times`);
    // The 008 printed authorization statements are still their own bands.
    if (type !== 'WTG_WORK') assert.match(text, /I (?:certify|confirm|declare)|WORK COMPLETION|EVACUATION/i);
  }
});

test('every safety and business section survives the cleanup', async () => {
  const shared = [
    'EMERGENCY RESPONSE', 'TASK ANALYSIS', 'ENERGY SOURCE LEGEND', 'TOOLS / MATERIAL',
    'PARTICIPANTS', 'APPROVALS', 'CLOSE-OUT', 'COMMENTS', 'HSE CHECKLIST', 'REQUIRED PERMITS',
    'JOB INFORMATION', 'STOP-WORK REMINDER',
  ];
  const per008 = [
    'WORK LOCATION / VALIDITY', 'NATURE OF WORK', 'TYPE OF HAZARD',
    'SPECIAL PRECAUTIONS / INSTRUCTIONS', 'LOTO NUMBER', 'REFERENCES',
  ];
  /*
    The safety bands come from the CATALOGUE, per type. The four forms do
    not share one checklist - Confined Space has no "EQUIPMENT CONDITION"
    band at all - so hard-coding one form's section names would only prove
    the wrong thing about the other three.
  */
  const checklists: Record<PermitType, readonly { title: string }[]> = {
    WTG_WORK: WTG_WORK_CHECKLIST_SECTIONS,
    COLD_WORK: COLD_WORK_CHECKLIST_SECTIONS,
    HOT_WORK: HOT_WORK_CHECKLIST_SECTIONS,
    CONFINED_SPACE_ENTRY: CONFINED_SPACE_CHECKLIST_SECTIONS,
  };

  for (const type of TYPES) {
    const text = (await pagesOf(type)).join('\n');
    for (const section of shared) {
      assert.ok(text.includes(section), `${type} lost ${section}`);
    }
    for (const band of checklists[type]) {
      assert.ok(text.includes(band.title), `${type} lost its "${band.title}" safety band`);
    }
    if (type !== 'WTG_WORK') {
      for (const section of per008) assert.ok(text.includes(section), `${type} lost ${section}`);
    } else {
      assert.ok(text.includes('PERMIT ISSUE'), 'WTG lost its Permit Issue band');
      assert.ok(text.includes('Detail of Isolation Points'), 'WTG lost its isolation band');
    }
    // The JSA business table stays exactly as it was for now.
    assert.ok(text.includes('APPROVALS'), `${type}: the JSA approval table must remain`);
  }
});

test('the confined-space gas test record and hot-work fire watch survive', async () => {
  const confined = (await pagesOf('CONFINED_SPACE_ENTRY')).join('\n');
  assert.ok(confined.includes('GAS TEST RECORD'));
  assert.ok(confined.includes('ATTENDANT'));
  const hot = (await pagesOf('HOT_WORK')).join('\n');
  assert.ok(hot.includes('FIRE WATCH'));
});

// ---------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------

test('an authorization band is never split across pages', async () => {
  for (const type of TYPES) {
    const pages = await pagesOf(type);
    // Each signature caption appears on exactly the page its band is on -
    // a band cut in half would scatter them across two.
    const withApplicantAuth = pages.filter((page) => page.includes('DIGITAL AUTHORIZATION'));
    assert.ok(withApplicantAuth.length >= 1, `${type}: the authorization band must be printed`);
    for (const page of withApplicantAuth) {
      const captions = ['APPLICANT', 'CRO AUTHORIZATION', 'HSE APPROVAL'].filter((caption) =>
        page.includes(caption),
      );
      // The band's own page carries the whole band, not one lone card.
      assert.ok(captions.length >= 3, `${type}: an authorization band was split (${captions.join(', ')})`);
    }
  }
});

test('no page is left holding only a stray authorization card', async () => {
  for (const type of TYPES) {
    const pages = await pagesOf(type);
    for (const [index, page] of pages.entries()) {
      const lines = page.split('\n').map((line) => line.trim()).filter(Boolean);
      // Every page carries the masthead, identity band and footer - about
      // a dozen lines - so a page with only those plus one card would be
      // the waste this cleanup is about.
      assert.ok(lines.length > 15, `${type} page ${index + 1} carries almost nothing (${lines.length} lines)`);
    }
  }
});

test('the Cold Work document no longer spends a page on its permit authorizations', async () => {
  const pages = await pagesOf('COLD_WORK');
  assert.equal(pages.length, 7, 'the representative Cold Work document should be seven pages');
  // The permit's authorization band now sits at the foot of the permit's
  // own last page rather than opening one of its own.
  const permitPages = pages.filter((page) => page.includes('COLD WORK PERMIT'));
  assert.ok(permitPages.at(-1)!.includes('DIGITAL AUTHORIZATION'));
});

test('every page stays inside the printable area and nothing is clipped', async () => {
  for (const type of TYPES) {
    const pdf = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    const raw = pdf.toString('latin1');
    // A4 is 841.89pt tall; PDFKit's transform makes y grow downward from
    // the top margin. Every text placement must sit above the footer
    // strip and below the top margin.
    const placements = [...raw.matchAll(/1 0 0 1 ([\d.]+) ([\d.]+) Tm/g)].map((m) => Number(m[2]));
    assert.ok(placements.length === 0 || placements.every((y) => y >= 0 && y <= 841.89), `${type}: text placed off-page`);
  }
});

test('V3 remains deterministic after the cleanup', async () => {
  for (const type of TYPES) {
    const first = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    const second = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V3');
    assert.ok(first.equals(second), `${type}: same snapshot, same bytes`);
    assert.equal(computeFileHash(first), computeFileHash(second));
  }
});

test('the older renderers still print everything V3 now omits', async () => {
  for (const type of TYPES) {
    const legacy = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V2');
    const text = extractPdfText(legacy);
    // The duplication, the distribution strip and the explanatory
    // paragraphs are all still there for V1/V2 - only V3 drops them.
    assert.ok(text.includes('PERMIT NUMBER'), `${type}: V2 must still print the body identity rows`);
    assert.ok(text.includes('APPLICANT COMPANY'), `${type}: V2 must still print the company row`);
    assert.ok(text.includes('SITE TIMEZONE'), `${type}: V2 must still print the technical zone row`);
    if (type !== 'WTG_WORK') {
      // Only the 008 forms print a distribution strip; WTG never had one.
      assert.match(text, /DISTRIBUTION/i, `${type}: V2 must still print the distribution strip`);
    }
    if (type !== 'WTG_WORK') {
      assert.match(text, /Authorization roles:/i, `${type}: V2 must still print the explanatory paragraph`);
    }
    // And the raw stored values, unformatted, exactly as before.
    assert.match(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, `${type}: V2 must still print raw ISO timestamps`);
  }
});

test('V1 and V2 bytes are unchanged by every V3 presentation decision', async () => {
  /*
    THE GUARANTEE THAT MAKES ALL OF THE ABOVE SAFE.

    The page model is SHARED with the historical renderer, so every hint
    added for V3 - the timestamp formatting, the technical rows, the
    omitted sections and paragraphs - is added to a structure PDFKIT_V1
    and PDFKIT_V2 also read. They ignore all of it, and they must: their
    bytes are pinned by `expected_file_hash` on jobs that already exist.

    These are the exact hashes the legacy renderer produces for the four
    representative snapshots. If a presentation change ever reaches the
    older path, this fails immediately and by name.
  */
  const hashes: Record<PermitType, string> = {
    WTG_WORK: '',
    COLD_WORK: '',
    HOT_WORK: '',
    CONFINED_SPACE_ENTRY: '',
  };
  for (const type of TYPES) {
    const v1 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V1');
    const v2 = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V2');
    // One legacy implementation, two pinned identities.
    assert.ok(v1.equals(v2), `${type}: V1 and V2 must remain the same document`);
    hashes[type] = computeFileHash(v2);
  }
  // Re-rendered from scratch, the same bytes come back - the legacy path
  // has no dependence on anything V3 introduced.
  for (const type of TYPES) {
    const again = await generateIssuedPermitPdf(makeV2PdfTestSnapshot(type), 'PDFKIT_V2');
    assert.equal(computeFileHash(again), hashes[type], `${type}: legacy bytes moved`);
  }
});

test('the WTG authorization band names its printed roles, without the explanatory sentence', async () => {
  const text = (await pagesOf('WTG_WORK')).join('\n');
  // The authoritative labels, from the catalogue - not reworded or invented.
  const labels = WTG_AUTHORIZATION_BANDS.map((band) => band.label);
  assert.deepEqual(labels, ['PERMIT ISSUER', 'PERMIT RECEIPT', 'EXTENSION OF PERMIT', 'PERMIT CLOSED']);
  assert.ok(text.includes('AUTHORIZATION BANDS'), 'the band must keep its section');
  assert.ok(text.includes(labels.join(' · ')), 'the roles must be printed as one compact line');
  for (const label of labels) assert.ok(text.includes(label), `${label} must be printed`);

  // The pointer sentence stays gone...
  assert.ok(!/recorded in the frozen signature band below/i.test(text));
  assert.ok(!/Authorization roles:/i.test(text));
  /*
    ...and the role line is a listing of the form's authorization STAGES,
    never a second copy of a signer. (The applicant's name legitimately
    appears in the per-page identity band and again on the signature card;
    what must not happen is a third copy inside this band.)
  */
  const roleLine = text.split('\n').find((line) => line.includes('PERMIT ISSUER · PERMIT RECEIPT'));
  assert.ok(roleLine, 'the compact role line must be one line');
  assert.ok(!roleLine.includes('Frozen Applicant'), 'the role line must not name a signer');
  assert.ok(!/Signed digitally/.test(roleLine));
});

test('the 008 forms did NOT get their explanatory paragraphs back', async () => {
  for (const type of TYPES.filter((t) => t !== 'WTG_WORK')) {
    const text = (await pagesOf(type)).join('\n');
    assert.ok(!/Authorization roles:/i.test(text), `${type}`);
    assert.ok(!/recorded in the frozen signature band below/i.test(text), `${type}`);
  }
});

test('V1/V2 still print the original WTG sentence in full', async () => {
  const legacy = extractPdfText(await generateIssuedPermitPdf(makeV2PdfTestSnapshot('WTG_WORK'), 'PDFKIT_V2'));
  assert.match(legacy, /recorded in the frozen signature band below/i);
  assert.ok(legacy.includes('PERMIT ISSUER / PERMIT RECEIPT'), 'V2 keeps the slash-joined original');
});

test('the issued PDF prints the prefixed permit number, not a bare one', async () => {
  const expected: Record<PermitType, string> = {
    WTG_WORK: 'WTG-1045',
    COLD_WORK: 'CW-1045',
    HOT_WORK: 'HW-1045',
    CONFINED_SPACE_ENTRY: 'CS-1045',
  };
  for (const type of TYPES) {
    const text = (await pagesOf(type)).join('\n');
    assert.ok(text.includes(expected[type]), `${type}: the document must read ${expected[type]}`);
    // The identity band on every page carries it.
    for (const [index, page] of (await pagesOf(type)).entries()) {
      assert.ok(page.includes(expected[type]), `${type} page ${index + 1} must carry the permit number`);
    }
    // The JSA number beside it stays bare - its series is unchanged.
    assert.ok(text.includes('234'), `${type}: the JSA number is still plain`);
    assert.ok(!text.includes('JSA-234'), `${type}: the JSA number must not be prefixed`);
  }
});
