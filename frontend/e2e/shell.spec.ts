import { expect, test } from '@playwright/test';
import { employeeIdentity, hasHorizontalPageOverflow, signInAs } from './harness';

/**
 * Proves the visual-QA harness itself works against the REAL built app in
 * a REAL browser, at all three viewports, before the permit and JSA
 * document specs are written on top of it.
 *
 * These are the checks jsdom structurally cannot make: that a page has
 * actual layout, that it does not scroll sideways on a phone, and that
 * what renders can be captured for comparison against the printed forms
 * in docs/reference-forms/.
 */

test('the login screen renders with real layout and no sideways scroll', async ({ page }, testInfo) => {
  await page.goto('/');

  // A real layout engine: the heading has non-zero box dimensions, which
  // is the thing jsdom can never tell us.
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  const box = await heading.boundingBox();
  expect(box, 'the heading must have a real layout box').not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);

  expect(await hasHorizontalPageOverflow(page), 'the page must not scroll sideways').toBe(false);

  await testInfo.attach(`login-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

test('an authenticated screen renders from stubbed routes only', async ({ page }, testInfo) => {
  await signInAs(page, employeeIdentity);
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 1, name: /good day, ali khan/i })).toBeVisible();
  expect(await hasHorizontalPageOverflow(page)).toBe(false);

  // The harness must never leak a credential into a screenshot: assert the
  // placeholder token is nowhere in the rendered document.
  const body = await page.locator('body').innerText();
  expect(body).not.toContain('e2e-not-a-real-token');

  await testInfo.attach(`home-${testInfo.project.name}`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});
