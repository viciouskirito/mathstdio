import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { openApp } from './helpers';

test('home and API dialog have no WCAG A/AA violations', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('chromium'));
  await openApp(page);
  const homeResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(homeResults.violations).toEqual([]);

  await page.getByRole('button', { name: '打开 AI 设置' }).click();
  const dialogResults = await new AxeBuilder({ page })
    .include('#api-dialog')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(dialogResults.violations).toEqual([]);

  await page.locator('.dialog-close').click();
  await page.locator('#theme-toggle').click();
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(350);
  const darkResults = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(darkResults.violations).toEqual([]);
});
