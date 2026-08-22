import { expect, test } from '@playwright/test';

import { collectPageErrors, openApp } from './helpers';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

test('AI connection selects v4 Flash and sanitizes Markdown', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  const errors = collectPageErrors(page);
  await page.route('https://api.deepseek.com/models', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        data: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-v4-flash' },
          { id: 'unexpected-model' },
          { id: 'deepseek-v4-pro' },
        ],
      }),
    });
  });
  await page.route('https://api.deepseek.com/chat/completions', async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    expect((await route.request().allHeaders()).authorization).toBe('Bearer test-runtime-key');
    expect((await route.request().postDataJSON()).model).toBe('deepseek-v4-pro');
    await route.fulfill({
      contentType: 'application/json',
      headers: corsHeaders,
      body: JSON.stringify({
        choices: [
          {
            message: {
              content:
                '# 分析结论\n<img src=x onerror="window.aiPwned=1"><script>window.aiPwned=2</script>函数是周期函数。',
            },
          },
        ],
      }),
    });
  });

  await openApp(page);
  await page.getByRole('button', { name: '打开 AI 设置' }).click();
  await expect(page.locator('#api-dialog')).toBeVisible();
  await expect(page.locator('#app-version')).toHaveText('v3.0.0');
  await page.locator('#api-key').fill('test-runtime-key');
  await page.getByRole('button', { name: '验证连接' }).click();
  await expect(page.locator('#api-status')).toContainText('已连接');
  await expect(page.locator('#api-model')).toHaveValue('deepseek-v4-flash');
  await expect(page.locator('.model-option')).toHaveCount(2);
  await expect(page.locator('[data-model="deepseek-v4-pro"]')).toBeEnabled();
  await expect(page.locator('[data-model="unexpected-model"]')).toHaveCount(0);
  await expect(page.locator('.select-chevron')).toHaveCount(0);
  const indicator = page.locator('.model-selector-indicator');
  const flashPosition = await indicator.boundingBox();
  await page.locator('[data-model="deepseek-v4-pro"]').click();
  await expect(page.locator('#api-model')).toHaveValue('deepseek-v4-pro');
  await expect(page.locator('#api-model-selector')).toHaveAttribute('data-selected', 'pro');
  await expect(page.locator('[data-model="deepseek-v4-pro"]')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.waitForTimeout(280);
  const proPosition = await indicator.boundingBox();
  expect(proPosition?.x ?? 0).toBeGreaterThan(flashPosition?.x ?? 0);
  expect(await page.evaluate(() => Object.values(localStorage).join('|'))).not.toContain(
    'test-runtime-key',
  );
  await page.locator('.dialog-footer button').click();

  await page.getByRole('button', { name: '分析选中' }).click();
  await expect(page.locator('#graph-ai-result')).toContainText('分析结论');
  await expect(page.locator('#graph-ai-result script')).toHaveCount(0);
  await expect(page.locator('#graph-ai-result [onerror]')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.has(window, 'aiPwned'))).toBe(false);
  expect(errors).toEqual([]);
});

for (const [status, message] of [
  [401, 'API Key 无效'],
  [429, '请求过于频繁'],
  [500, '服务暂时不可用'],
] as const) {
  test(`AI connection safely reports HTTP ${status}`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'chromium-desktop');
    await page.route('https://api.deepseek.com/models', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      await route.fulfill({
        status,
        contentType: 'application/json',
        headers: corsHeaders,
        body: '{"secret":"not shown"}',
      });
    });
    await openApp(page);
    await page.getByRole('button', { name: '打开 AI 设置' }).click();
    await page.locator('#api-key').fill('bad-key');
    await page.getByRole('button', { name: '验证连接' }).click();
    await expect(page.locator('#api-status')).toContainText(message);
    await expect(page.locator('#api-status')).not.toContainText('not shown');
  });
}

test('mobile users can reach API settings and every bottom tab', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  const errors = collectPageErrors(page);
  await openApp(page);
  const bottomTabs = page.locator('.mobile-tabs');
  await expect(bottomTabs).toBeVisible();
  await expect(bottomTabs.getByRole('tab')).toHaveCount(3);
  await page.getByRole('button', { name: '打开 AI 设置' }).click();
  const dialog = page.locator('#api-dialog');
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(390);
  expect(box?.height).toBeLessThanOrEqual(844);
  await page.locator('.dialog-close').click();
  await page.locator('.mobile-tab[data-tool="curve"]').click();
  await expect(page.locator('#panel-curve')).toBeVisible();
  await page.locator('.mobile-tab[data-tool="vector"]').click();
  await expect(page.locator('#panel-vector')).toBeVisible();
  expect(errors).toEqual([]);
});
