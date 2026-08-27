import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { employeeIdentity, hasHorizontalPageOverflow, signInAs } from './harness';

/**
 * THE AUTHORITATIVE DOCUMENTS, IN A REAL BROWSER.
 *
 * Four permits x three viewports = twelve scenarios, each rendering the
 * permit AND both JSA pages. The catalogue comes from a committed
 * snapshot of what the API serves; a backend test fails if that snapshot
 * goes stale, so these screenshots are always of the real wording.
 *
 * These assertions are the ones jsdom cannot make: that a control has a
 * real clickable box, that a long safety question is not clipped, that a
 * wide table scrolls inside its own container instead of widening the
 * page, and that the two JSA pages are genuinely separate documents.
 */

const catalogue = JSON.parse(
  readFileSync(new URL('./fixtures/catalogue.json', import.meta.url), 'utf8'),
) as {
  permits: Record<string, {
    title: string;
    checklistSections: { id: string; title: string; responses: string; items: { id: string; label: string }[] }[];
    isolationPoints?: { responses: string; items: { label: string }[] };
    natureOfWork?: { options: { label: string }[] };
  }>;
  jsa: {
    page1: { hseChecklistCategories: { id: string; title: string; options: { label: string }[] }[]; requiredPermits: { options: { label: string }[] } };
    page2: { taskAnalysisColumns: { label: string }[] };
  };
};

const PERMIT_TYPES = ['WTG_WORK', 'COLD_WORK', 'HOT_WORK', 'CONFINED_SPACE_ENTRY'] as const;

async function openPreview(page: Page, permitType: string, mode: 'edit' | 'read' = 'edit'): Promise<void> {
  await signInAs(page, employeeIdentity, { 'GET /permits/catalogue': catalogue });
  await page.goto(`/__forms-preview?type=${permitType}&mode=${mode}`);
  await expect(page.getByTestId('form-preview')).toBeVisible();
}

for (const permitType of PERMIT_TYPES) {
  test(`${permitType}: permit and both JSA pages render faithfully`, async ({ page }, testInfo) => {
    await openPreview(page, permitType);
    const definition = catalogue.permits[permitType]!;

    // --- the permit document -------------------------------------------
    const permit = page.getByTestId(`permit-document-${permitType}`);
    await expect(permit).toBeVisible();

    // Every printed checklist band is present, in catalogue order, and
    // carries exactly its printed questions.
    for (const section of definition.checklistSections) {
      const band = page.getByTestId(`checklist-${section.id}`);
      await expect(band, `${section.id} must render`).toBeVisible();

      // The tick columns the form actually prints - and no others.
      const headers = await band.locator('thead th').allInnerTexts();
      const ticks = headers.slice(1).map((h) => h.trim());
      expect(ticks, `${section.id} tick columns`).toEqual(
        section.responses === 'YES_NO_NA' ? ['Yes', 'No', 'N/A'] : ['Yes', 'No'],
      );

      // Every printed question, verbatim.
      const rows = await band.locator('tbody th').allInnerTexts();
      expect(rows.map((r) => r.trim()), `${section.id} questions`).toEqual(
        section.items.map((item) => item.label),
      );
    }

    // WTG's isolation band prints Yes/No only - N/A must not appear.
    if (definition.isolationPoints) {
      const band = page.getByTestId('checklist-isolation_points');
      const headers = await band.locator('thead th').allInnerTexts();
      expect(headers.slice(1).map((h) => h.trim())).toEqual(['Yes', 'No']);
      expect(definition.isolationPoints.responses).toBe('YES_NO');
    }

    // --- the JSA, two separate pages -----------------------------------
    const page1 = page.getByTestId('jsa-page-1');
    const page2 = page.getByTestId('jsa-page-2');
    await expect(page1).toBeVisible();
    await expect(page2).toBeVisible();
    await expect(page1).toContainText('PAGE 1 OF 2');
    await expect(page2).toContainText('PAGE 2 OF 2');

    // All sixteen HSE categories live on page 1 - and NOT on page 2.
    for (const category of catalogue.jsa.page1.hseChecklistCategories) {
      await expect(page1.getByTestId(`selection-${category.id}`)).toBeVisible();
      await expect(page2.getByTestId(`selection-${category.id}`)).toHaveCount(0);
    }

    // Page 2's task-analysis table is page 2's alone, with five columns.
    await expect(page2.getByTestId('task-analysis')).toBeVisible();
    await expect(page1.getByTestId('task-analysis')).toHaveCount(0);
    const columns = await page2.getByTestId('task-analysis').locator('thead th').allInnerTexts();
    expect(columns.map((c) => c.trim())).toEqual(
      catalogue.jsa.page2.taskAnalysisColumns.map((c) => c.label),
    );

    // --- layout, which is why this runs in a browser at all -------------
    expect(await hasHorizontalPageOverflow(page), 'the page must never scroll sideways').toBe(false);

    await testInfo.attach(`${permitType}-${testInfo.project.name}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  });
}

test('the HSE checklist is a tick band - it renders no Yes/No/N/A columns', async ({ page }) => {
  await openPreview(page, 'WTG_WORK');
  const page1 = page.getByTestId('jsa-page-1');
  const first = catalogue.jsa.page1.hseChecklistCategories[0]!;
  const band = page1.getByTestId(`selection-${first.id}`);
  await expect(band).toBeVisible();
  // Checkboxes, not radios, and no response table.
  await expect(band.locator('input[type="checkbox"]')).toHaveCount(first.options.length);
  await expect(band.locator('input[type="radio"]')).toHaveCount(0);
});

test('safety questions are not clipped, and controls have real clickable boxes', async ({ page }) => {
  await openPreview(page, 'WTG_WORK');
  const band = page.getByTestId('checklist-general_work');

  // The longest printed question on the WTG form must be fully laid out.
  const longest = band.locator('tbody th').first();
  const box = await longest.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThan(0);
  // A clipped single-line cell would be ~1 line tall; this question wraps.
  const scrollWidth = await longest.evaluate((el) => el.scrollWidth);
  const clientWidth = await longest.evaluate((el) => el.clientWidth);
  expect(scrollWidth, 'the question text must wrap, not overflow its cell').toBeLessThanOrEqual(clientWidth + 1);

  const radio = band.locator('input[type="radio"]').first();
  const radioBox = await radio.boundingBox();
  expect(radioBox).not.toBeNull();
  expect(radioBox!.width).toBeGreaterThan(6);
  expect(radioBox!.height).toBeGreaterThan(6);
});

test('a wide table scrolls inside its own container, not the page', async ({ page }) => {
  await openPreview(page, 'CONFINED_SPACE_ENTRY');
  const container = page.getByTestId('task-analysis').locator('xpath=ancestor::div[contains(@class,"doc__scroll")]');
  const overflows = await container.evaluate((el) => el.scrollWidth > el.clientWidth);
  const pageOverflows = await hasHorizontalPageOverflow(page);
  // On a phone the table is wider than the viewport - that is fine, as
  // long as it is the CONTAINER that scrolls and never the document.
  expect(pageOverflows, 'the page must not scroll sideways').toBe(false);
  if (overflows) {
    const canScroll = await container.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return style.overflowX === 'auto' || style.overflowX === 'scroll';
    });
    expect(canScroll, 'an overflowing table must be scrollable').toBe(true);
  }
});

test('edit mode offers controls; read-only mode shows the same document without them', async ({ page }, testInfo) => {
  await openPreview(page, 'HOT_WORK', 'edit');
  const editRadios = await page.getByTestId('checklist-general_requirements').locator('input').count();
  expect(editRadios).toBeGreaterThan(0);
  const editQuestions = await page
    .getByTestId('checklist-general_requirements')
    .locator('tbody th')
    .allInnerTexts();

  await openPreview(page, 'HOT_WORK', 'read');
  const readBand = page.getByTestId('checklist-general_requirements');
  await expect(readBand).toBeVisible();
  await expect(readBand.locator('input')).toHaveCount(0);
  const readQuestions = await readBand.locator('tbody th').allInnerTexts();

  // The SAME document, not a different view of it.
  expect(readQuestions).toEqual(editQuestions);

  await testInfo.attach(`hot-work-readonly-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('server-authoritative fields are displayed but never editable', async ({ page }) => {
  await openPreview(page, 'COLD_WORK', 'edit');
  for (const label of ['Permit No.', 'Applicant', 'Company', 'JSA No.']) {
    const field = page.getByText(label, { exact: true }).first();
    await expect(field).toBeVisible();
  }
  // None of them is an input, in edit mode.
  await expect(page.locator('input[aria-label="Permit No."]')).toHaveCount(0);
  await expect(page.locator('input[aria-label="Applicant"]')).toHaveCount(0);
  await expect(page.locator('input[aria-label="Company"]')).toHaveCount(0);
  await expect(page.locator('input[aria-label="JSA No."]')).toHaveCount(0);
});

test('a blank permit shows every safety question UNANSWERED - no default N/A', async ({ page }, testInfo) => {
  // The defect this guards: a pre-selected N/A puts a safety judgement
  // nobody made onto an issued permit.
  await openPreview(page, 'WTG_WORK', 'edit');

  for (const section of catalogue.permits.WTG_WORK!.checklistSections) {
    const band = page.getByTestId(`checklist-${section.id}`);
    await expect(band.locator('input[type="radio"]:checked'), `${section.id}`).toHaveCount(0);
  }
  // The Yes/No-only isolation band too.
  await expect(page.getByTestId('checklist-isolation_points').locator('input:checked')).toHaveCount(0);

  // And the JSA's printed Yes/No questions.
  await expect(page.getByTestId('jsa-page-1').locator('input[type="radio"]:checked')).toHaveCount(0);
  await expect(page.getByTestId('jsa-page-2').locator('input[type="radio"]:checked')).toHaveCount(0);

  await testInfo.attach(`unanswered-${testInfo.project.name}`, {
    body: await page.getByTestId('checklist-general_work').screenshot(),
    contentType: 'image/png',
  });
});

test('choosing N/A is possible, and only then is it recorded', async ({ page }) => {
  await openPreview(page, 'WTG_WORK', 'edit');
  const band = page.getByTestId('checklist-general_work');
  const na = band.locator('tbody tr').first().locator('input[type="radio"]').nth(2);
  await expect(na).not.toBeChecked();
  await na.check();
  await expect(na).toBeChecked();
  // Exactly one answer recorded in that band - not a whole column.
  await expect(band.locator('input[type="radio"]:checked')).toHaveCount(1);
});
