import type { Page } from '@playwright/test';

export function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('html[data-app-ready="true"]').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

export async function chooseTool(page: Page, tool: 'graph' | 'curve' | 'vector'): Promise<void> {
  await page.locator(`[data-tool="${tool}"]:visible`).click();
  await page.locator(`[data-page="${tool}"]`).waitFor({ state: 'visible' });
}
