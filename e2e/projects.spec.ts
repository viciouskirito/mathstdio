import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { openApp } from './helpers';

test('projects survive refresh, restore earlier work, and export reproducible files', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('chromium'));
  await openApp(page);
  await page.locator('#project-name').fill('极点研究');
  const expression = page.locator('.function-input').first();
  await expression.fill('1/x');
  await page.locator('#project-save').click();
  await expect(page.locator('#project-status')).toContainText('已保存版本');
  await expression.fill('sin(100/x)');
  await expect(page.locator('#graph-quality-status')).toContainText('密集区域');
  await page.locator('#graph-quality').selectOption('precise');
  await expect(page.locator('#project-status')).toContainText('自动保存');
  await page.reload();
  await expect(expression).toHaveValue('sin(100/x)');
  await expect(page.locator('#graph-quality')).toHaveValue('precise');
  await expect(page.locator('#project-name')).toHaveValue('极点研究');
  await page.locator('#project-restore').click();
  await expect(expression).toHaveValue('1/x');
  await expect(page.locator('#project-versions option')).toHaveCount(2);

  const jsonDownload = page.waitForEvent('download');
  await page.locator('#project-export').click();
  const jsonFile = await (await jsonDownload).path();
  const contents = JSON.parse(await readFile(jsonFile!, 'utf8')) as {
    functions: Array<{ expression: string }>;
    schemaVersion: number;
  };
  expect(contents.schemaVersion).toBe(1);
  expect(contents.functions[0]?.expression).toBe('1/x');

  const csvDownload = page.waitForEvent('download');
  await page.locator('#graph-export-csv').click();
  const csv = await readFile((await (await csvDownload).path())!, 'utf8');
  expect(csv).toContain('0,,undefined_or_overflow');
  expect(csv.split('\r\n')).toHaveLength(1002);

  const pngDownload = page.waitForEvent('download');
  await page.locator('#graph-export-png').click();
  const png = await readFile((await (await pngDownload).path())!);
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.byteLength).toBeGreaterThan(5000);

  await expression.fill('cos(x)');
  await page.locator('#project-file').setInputFiles({
    name: 'study.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(contents)),
  });
  await expect(expression).toHaveValue('1/x');
  await page.locator('#project-file').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":99}'),
  });
  await expect(page.locator('#project-status')).toContainText('不支持');
  await expect(expression).toHaveValue('1/x');
});

test('damaged storage preserves the stored bytes and still permits editing and export', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await page.addInitScript(() => localStorage.setItem('math-studio.projects-v1', '{broken'));
  await openApp(page);
  await expect(page.locator('#project-status')).toContainText('内容损坏');
  await page.locator('.function-input').first().fill('x^2');
  await expect(page.locator('#graph-summary')).toContainText('x^2');
  expect(await page.evaluate(() => localStorage.getItem('math-studio.projects-v1'))).toBe(
    '{broken',
  );
  const download = page.waitForEvent('download');
  await page.locator('#project-export').click();
  expect((await download).suggestedFilename()).toContain('.json');
});

test('cross-tab changes pause saving instead of overwriting newer work', async ({
  page,
  context,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await openApp(page);
  const second = await context.newPage();
  await openApp(second);
  await second.locator('.function-input').first().fill('cos(x)');
  await expect(second.locator('#project-status')).toContainText('自动保存');
  await expect(page.locator('#project-status')).toContainText('其他标签页');
  await page.locator('.function-input').first().fill('x^2');
  await expect(page.locator('#graph-summary')).toContainText('x^2');
  const stored = await page.evaluate(() => localStorage.getItem('math-studio.projects-v1'));
  expect(stored).toContain('cos(x)');
  expect(stored).not.toContain('x^2');
});
