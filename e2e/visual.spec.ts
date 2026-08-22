import { expect, test } from '@playwright/test';

import { openApp } from './helpers';

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} theme visual snapshot`, async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith('chromium'));
    await page.addInitScript((preference) => {
      localStorage.setItem('math-studio.theme-v3', preference);
    }, theme);
    await openApp(page);
    await expect(page).toHaveScreenshot(`home-${testInfo.project.name}-${theme}.png`, {
      fullPage: true,
    });
  });
}
