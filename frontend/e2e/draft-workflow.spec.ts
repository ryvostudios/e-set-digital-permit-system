import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { employeeIdentity, hasHorizontalPageOverflow, signInAs } from './harness';

/**
 * THE APPLICANT'S WORKFLOW, IN A REAL BROWSER.
 *
 * These are the behaviours that only exist once there is layout and a
 * navigation stack: that a validation refusal actually brings the missing
 * question INTO VIEW rather than under the sticky header, that leaving
 * with unsaved work is challenged, and that saving clears that state.
 */

const catalogue = JSON.parse(
  readFileSync(new URL('./fixtures/catalogue.json', import.meta.url), 'utf8'),
) as Record<string, never>;

const PERMIT_ID = '00000000-0000-4000-8000-000000000001';

/** The server's itemised refusal, exactly as the backend sends it. */
const UNANSWERED_REFUSAL = {
  error: 'invalid_state',
  reason: 'unanswered_questions',
  message: 'Every safety question must be answered before this permit can be submitted',
  unanswered: {
    permit: [
      {
        sectionId: 'work_at_heights',
        sectionTitle: 'WORK AT HEIGHTS',
        itemId: 'c',
        itemLabel: 'Is Hazard regarding high wind speed known according to task?',
        path: ['sections', 'work_at_heights', 'c', 'response'],
      },
      {
        sectionId: 'isolation_points',
        sectionTitle: 'Detail of Isolation Points',
        itemId: 'a',
        itemLabel: 'Bottom box isolation',
        path: ['isolationPoints', 'a', 'response'],
      },
    ],
    jsa: [
      {
        sectionId: 'emergency_response',
        sectionTitle: 'Emergency Response',
        itemId: 'erp_understood',
        itemLabel: 'Was the Emergency Response Plan understood and agreed prior start working?',
        path: ['page2', 'emergencyQuestions', 'erp_understood'],
      },
    ],
  },
};

interface OpenOptions {
  submitResponse?: { status: number; body: unknown };
  onSave?: (body: unknown) => void;
}

async function openEditor(page: Page, options: OpenOptions = {}): Promise<{ saves: unknown[] }> {
  const saves: unknown[] = [];
  let version = 1;

  await signInAs(page, employeeIdentity, { 'GET /permits/catalogue': catalogue });

  // The two PATCH endpoints and submit, answered locally.
  await page.route(`**/api/v1/permits/${PERMIT_ID}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postDataJSON?.() as { version?: number; form?: unknown } | undefined;

    if (request.method() === 'PATCH') {
      saves.push({ path: url.pathname, form: body?.form, version: body?.version });
      options.onSave?.(body);
      version += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ permit: { id: PERMIT_ID, version }, jsa: { id: 'jsa-1' } }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/submit')) {
      const response = options.submitResponse ?? { status: 422, body: UNANSWERED_REFUSAL };
      await route.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`/__forms-preview?type=WTG_WORK&editor=1&permitId=${PERMIT_ID}`);
  await expect(page.getByTestId('permit-draft-editor')).toBeVisible();
  return { saves };
}

test('the editor is ONE continuous document: permit, JSA page 1, JSA page 2, then the actions', async ({ page }) => {
  await openEditor(page);

  const permit = page.getByTestId('permit-document-WTG_WORK');
  const jsa1 = page.getByTestId('jsa-page-1');
  const jsa2 = page.getByTestId('jsa-page-2');
  const actions = page.getByTestId('editor-actions');

  for (const part of [permit, jsa1, jsa2, actions]) await expect(part).toBeVisible();

  // In that DOCUMENT order, with no tabs to switch between them.
  // Compared in the document, not the viewport: the action bar is
  // `position: sticky; bottom: 0` so it stays reachable on a long form,
  // which makes its viewport coordinate meaningless for ordering.
  const order = await page.evaluate(() => {
    const ids = ['permit-document-WTG_WORK', 'jsa-page-1', 'jsa-page-2', 'editor-actions'];
    const nodes = ids.map((id) => document.querySelector(`[data-testid="${id}"]`));
    return nodes.map((node, index) => {
      const next = nodes[index + 1];
      if (!node || !next) return true;
      // DOCUMENT_POSITION_FOLLOWING === 4
      return (node.compareDocumentPosition(next) & 4) !== 0;
    });
  });
  expect(order, 'permit, then JSA page 1, then page 2, then the actions').toEqual([true, true, true, true]);

  // And the whole thing is one scroll: page 2 really is far below page 1.
  const documentTop = async (testId: string) =>
    page.evaluate(
      (id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top + window.scrollY,
      testId,
    );
  expect(await documentTop('jsa-page-1')).toBeGreaterThan(await documentTop('permit-document-WTG_WORK'));
  expect(await documentTop('jsa-page-2')).toBeGreaterThan(await documentTop('jsa-page-1'));

  await expect(page.getByRole('tab')).toHaveCount(0);
  expect(await hasHorizontalPageOverflow(page)).toBe(false);
});

test('a blank editor starts with nothing answered and nothing to save', async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'false');
  await expect(page.getByTestId('permit-document-WTG_WORK').locator('input[type="radio"]:checked')).toHaveCount(0);
});

test('Save Draft sends both documents, preserving unanswered as null and explicit N/A as NA', async ({ page }) => {
  const { saves } = await openEditor(page);

  // Answer exactly one question as N/A; leave the rest untouched.
  const band = page.getByTestId('checklist-general_work');
  await band.locator('tbody tr').first().locator('input[type="radio"]').nth(2).check();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'true');

  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByTestId('save-state')).toHaveText(/draft saved/i);

  // Both endpoints were called, permit first.
  expect(saves).toHaveLength(2);
  const permitSave = saves[0] as { path: string; form: Record<string, never>; version: number };
  const jsaSave = saves[1] as { path: string; version: number };
  expect(permitSave.path).toBe(`/api/v1/permits/${PERMIT_ID}`);
  expect(jsaSave.path).toBe(`/api/v1/permits/${PERMIT_ID}/jsa`);

  // The JSA save used the version the permit save returned - one document.
  expect(permitSave.version).toBe(1);
  expect(jsaSave.version).toBe(2);

  const sections = (permitSave.form as unknown as { sections: Record<string, Record<string, { response: string | null }>> }).sections;
  expect(sections.general_work!.a!.response, 'the answer the person actually gave').toBe('NA');
  expect(sections.general_work!.b!.response, 'untouched stays UNANSWERED, not NA').toBeNull();
  expect(sections.electrical_work!.a!.response).toBeNull();
});

test('a successful save clears the unsaved-changes state', async ({ page }) => {
  await openEditor(page);
  await page.getByTestId('checklist-general_work').locator('input[type="radio"]').first().check();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'true');

  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'false');
  await expect(page.getByTestId('save-state')).toHaveText(/draft saved/i);
});

test('leaving with unsaved changes is challenged, and is NOT after saving', async ({ page }) => {
  await openEditor(page);

  // Nothing changed yet: no prompt.
  let dialogSeen = false;
  page.on('dialog', (dialog) => { dialogSeen = true; void dialog.accept(); });
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  })).toBe(false);

  // Now make a change - leaving must be challenged.
  await page.getByTestId('checklist-general_work').locator('input[type="radio"]').first().check();
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), 'unsaved work must be protected').toBe(true);

  // After saving, it must not be.
  await page.getByRole('button', { name: 'Save Draft' }).click();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'false');
  expect(await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }), 'a saved document must not nag').toBe(false);
  expect(dialogSeen).toBe(false);
});

test('a stale save is reported as a conflict, and the entered values are kept', async ({ page }) => {
  await signInAs(page, employeeIdentity, { 'GET /permits/catalogue': catalogue });
  await page.route(`**/api/v1/permits/${PERMIT_ID}**`, async (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'conflict', reason: 'stale_version', message: 'Permit has changed' }),
    }),
  );
  await page.goto(`/__forms-preview?type=WTG_WORK&editor=1&permitId=${PERMIT_ID}`);
  await expect(page.getByTestId('permit-draft-editor')).toBeVisible();

  const first = page.getByTestId('checklist-general_work').locator('input[type="radio"]').first();
  await first.check();
  await page.getByRole('button', { name: 'Save Draft' }).click();

  await expect(page.getByText(/changed elsewhere/i)).toBeVisible();
  // The work is still on screen.
  await expect(first).toBeChecked();
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-dirty', 'true');
});

test('submitting an incomplete permit highlights exactly what the SERVER said is missing', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Submit' }).click();

  const summary = page.getByTestId('unanswered-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('3 questions still need an answer');
  // The printed question text, from the server.
  await expect(summary).toContainText('Is Hazard regarding high wind speed known according to task?');

  // Exactly the three the server named are marked - not a whole band.
  await expect(page.locator('[data-unanswered="true"]')).toHaveCount(3);
  await expect(page.locator('#fld-sections-work_at_heights-c-response')).toHaveAttribute('data-unanswered', 'true');
  await expect(page.locator('#fld-isolationPoints-a-response')).toHaveAttribute('data-unanswered', 'true');
  await expect(page.locator('#fld-page2-emergencyQuestions-erp_understood')).toHaveAttribute('data-unanswered', 'true');
});

test('the first unanswered question is brought INTO VIEW, clear of the sticky header', async ({ page }) => {
  await openEditor(page);
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('unanswered-summary')).toBeVisible();

  await page.getByRole('button', { name: /go to the first one/i }).click();
  const target = page.locator('#fld-sections-work_at_heights-c-response');
  await expect(target).toBeInViewport();

  // The decisive check: it is BELOW the sticky header, not underneath it.
  const headerBottom = await page.evaluate(() => {
    const header = document.querySelector('.shell__header');
    return header ? header.getBoundingClientRect().bottom : 0;
  });
  const box = (await target.boundingBox())!;
  expect(box.y, 'the question must not sit under the sticky header').toBeGreaterThanOrEqual(headerBottom - 1);
});

test('a validation refusal preserves every value already entered', async ({ page }) => {
  await openEditor(page);
  const answered = page.getByTestId('checklist-general_work').locator('tbody tr').first().locator('input[type="radio"]').first();
  await answered.check();

  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('unanswered-summary')).toBeVisible();

  await expect(answered, 'the form must not be cleared by a refusal').toBeChecked();
});

test('a successful submit reports no validation problems', async ({ page }) => {
  await openEditor(page, { submitResponse: { status: 200, body: { permit: { id: PERMIT_ID, version: 2 } } } });
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByTestId('unanswered-summary')).toHaveCount(0);
});
