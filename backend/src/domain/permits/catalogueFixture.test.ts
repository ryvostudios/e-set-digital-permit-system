import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildFormCatalogue } from './catalogueApi.js';

/**
 * The Playwright visual specs render against a committed snapshot of the
 * catalogue (`frontend/e2e/fixtures/catalogue.json`) rather than a live
 * backend, so they need no credentials and no running server.
 *
 * A snapshot can go stale, and a stale one would mean the screenshots
 * being inspected are of wording the application no longer serves. This
 * test makes that impossible to miss: if the catalogue changes and the
 * fixture is not regenerated, it fails.
 *
 * Regenerate with the catalogue itself as the source - never by editing
 * the JSON by hand.
 */

const fixturePath = new URL('../../../../frontend/e2e/fixtures/catalogue.json', import.meta.url);

test('the Playwright catalogue fixture matches what the API actually serves', async () => {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
  assert.deepEqual(
    fixture,
    JSON.parse(JSON.stringify(buildFormCatalogue())),
    'frontend/e2e/fixtures/catalogue.json is stale - regenerate it from buildFormCatalogue()',
  );
});

test('the fixture carries the full printed content the visual specs assert on', async () => {
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as ReturnType<typeof buildFormCatalogue>;
  assert.deepEqual(Object.keys(fixture.permits).sort(), [
    'COLD_WORK', 'CONFINED_SPACE_ENTRY', 'HOT_WORK', 'WTG_WORK',
  ]);
  assert.equal(fixture.jsa.page1.hseChecklistCategories.length, 16);
  assert.equal(
    fixture.jsa.page1.hseChecklistCategories.reduce((total, category) => total + category.options.length, 0),
    115,
  );
  assert.equal(fixture.jsa.page2.taskAnalysisColumns.length, 5);
  assert.equal(fixture.jsa.page1.requiredPermits.options.length, 8);
});
