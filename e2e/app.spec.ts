import { expect, test } from '@playwright/test';

import { chooseTool, collectPageErrors, openApp } from './helpers';

test('core tools load and navigation remains keyboard accessible', async ({ page }, testInfo) => {
  const errors = collectPageErrors(page);
  await openApp(page);
  await expect(page.getByRole('heading', { name: '2D 函数图像' })).toBeVisible();
  await expect(page.locator('#graph-summary')).toContainText('sin(x)');

  const visibleGraphTab = page.locator('[data-tool="graph"]:visible');
  await visibleGraphTab.focus();
  await visibleGraphTab.press('ArrowRight');
  await expect(page.locator('#panel-curve')).toBeVisible();
  await expect(page.locator('[data-tool="curve"]:visible')).toHaveAttribute(
    'aria-selected',
    'true',
  );

  if (testInfo.project.name.startsWith('chromium')) {
    await expect(page.locator('#curve-canvas')).toHaveAttribute('data-point-count', '1001');
  } else {
    await expect(page.locator('#curve-summary')).not.toBeEmpty();
  }
  await chooseTool(page, 'vector');
  await expect(page.locator('#vector-result')).toContainText('(4, 5, 3)');
  expect(errors).toEqual([]);
});

test('2D expressions, limits, ranges and keyboard controls are robust', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  const errors = collectPageErrors(page);
  await openApp(page);

  const first = page.locator('.function-input').first();
  await first.fill('x*sin(1/x)');
  await expect(page.locator('.function-row').first()).not.toHaveClass(/has-error/);
  await expect(page.locator('#graph-summary')).toContainText('x*sin(1/x)');
  await first.fill('sin(1/x)');
  await expect(page.locator('.function-row').first()).not.toHaveClass(/has-error/);
  await expect(page.locator('#graph-summary')).toContainText('sin(1/x)');
  await first.fill('sin(100/x)');
  await expect(page.locator('.function-row').first()).not.toHaveClass(/has-error/);
  await expect(page.locator('#graph-summary')).toContainText('sin(100/x)');
  expect(
    Number(await page.locator('#graph-canvas').getAttribute('data-envelope-count')),
  ).toBeGreaterThan(0);
  await first.fill('asin(0.5)+sinh(x)');
  await expect(page.locator('.function-row').first()).not.toHaveClass(/has-error/);
  await expect(page.locator('#graph-summary')).toContainText('asin(0.5)+sinh(x)');

  await page.getByRole('button', { name: '＋ 添加' }).click();
  const second = page.locator('.function-input').nth(1);
  await second.fill('(x+1)(x-1)');
  await first.focus();
  await expect(page.locator('.function-row').first()).toHaveClass(/is-selected/);
  await second.focus();
  await expect(page.locator('.function-row').nth(1)).toHaveClass(/is-selected/);

  await page.getByRole('button', { name: '＋ 添加' }).click();
  await page.locator('.function-input').nth(2).fill('cos(x)');
  await expect(page.locator('#graph-summary')).toContainText('当前绘制 3 条函数');
  await expect(page.locator('#graph-summary')).toContainText('cos(x)');
  const renderMs = Number(await page.locator('#graph-canvas').getAttribute('data-render-ms'));
  expect(renderMs).toBeLessThan(120);

  const xMin = page.locator('#range-x-min');
  const xMax = page.locator('#range-x-max');
  const yMin = page.locator('#range-y-min');
  const yMax = page.locator('#range-y-max');
  await xMin.fill('0');
  await xMax.fill('10');
  await yMin.fill('0');
  await yMax.fill('10');
  await yMax.press('Tab');
  await expect(page.locator('#range-error')).toBeEmpty();
  await expect(page.locator('#graph-summary')).toContainText('X 范围 0 至 10');

  const stableSummary = await page.locator('#graph-summary').textContent();
  await xMin.fill('20');
  await xMin.press('Tab');
  await expect(page.locator('#range-error')).toContainText('最大值必须大于最小值');
  await expect(page.locator('#graph-summary')).toHaveText(stableSummary ?? '');

  await xMin.fill('');
  await xMin.press('Tab');
  await expect(page.locator('#range-error')).toContainText('有限数字');

  const canvas = page.locator('#graph-canvas');
  await canvas.focus();
  await canvas.press('Home');
  await expect(page.locator('#graph-summary')).toContainText('X 范围 -10 至 10');
  await canvas.press('+');
  await expect(page.locator('#graph-summary')).not.toContainText('X 范围 -10 至 10');

  await first.fill('<img src=x onerror="window.pwned=1">');
  await expect(page.locator('.function-row').first()).toHaveClass(/has-error/);
  await expect(page.locator('#function-list img')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.has(window, 'pwned'))).toBe(false);
  for (let index = 0; index < 6; index += 1) {
    await page.getByRole('button', { name: '＋ 添加' }).click();
  }
  await expect(page.locator('.function-row')).toHaveCount(8);
  await expect(page.locator('#function-limit')).toContainText('最多同时绘制 8 条函数');
  expect(errors).toEqual([]);
});

test('3D scenes render only on demand and invalid curve ranges stay safe', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  const errors = collectPageErrors(page);
  await openApp(page);
  await chooseTool(page, 'curve');
  await expect(page.locator('#curve-canvas')).toHaveAttribute('data-point-count', '1001');
  const count = await page.locator('#curve-canvas').getAttribute('data-render-count');
  await page.waitForTimeout(400);
  await expect(page.locator('#curve-canvas')).toHaveAttribute('data-render-count', count ?? '');

  await page.locator('#curve-t-min').fill('10');
  await page.locator('#curve-t-max').fill('0');
  await page.getByRole('button', { name: '绘制曲线' }).click();
  await expect(page.locator('#curve-error')).toContainText('结束值必须大于起始值');
  await expect(page.locator('#curve-canvas')).toHaveAttribute('data-point-count', '1001');

  await page.locator('#curve-t-min').fill('0');
  await page.locator('#curve-t-max').fill('2');
  await page.locator('#curve-z').fill('1/(t-1)');
  await page.getByRole('button', { name: '绘制曲线' }).click();
  await expect(page.locator('#curve-error')).toContainText('非有限值');

  await chooseTool(page, 'graph');
  await page.waitForTimeout(400);
  await expect(page.locator('#curve-canvas')).toHaveAttribute('data-render-count', count ?? '');
  expect(errors).toEqual([]);
});

test('all vector operations, zero vectors and subtraction helper are correct', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  const errors = collectPageErrors(page);
  await openApp(page);
  await chooseTool(page, 'vector');
  await expect(page.locator('#vector-result')).toContainText('(4, 5, 3)');

  await page.getByRole('button', { name: 'A − B', exact: true }).click();
  await expect(page.locator('#vector-result')).toContainText('(2, -1, -1)');
  await expect(page.locator('#vector-result')).toContainText('(-1, -3, -2)');
  await page.getByRole('button', { name: 'A · B', exact: true }).click();
  await expect(page.locator('#vector-result')).toContainText('= 11');
  await page.getByRole('button', { name: 'A × B', exact: true }).click();
  await expect(page.locator('#vector-result')).toContainText('(1, -5, 7)');

  await page.locator('#vector-ax').fill('1000000');
  await expect(page.locator('#vector-status')).toContainText('数值较大');

  for (const id of ['vector-ax', 'vector-ay', 'vector-az']) {
    await page.locator(`#${id}`).fill('0');
  }
  await expect(page.locator('#vector-status')).toContainText('零向量');
  await page.getByRole('button', { name: 'A · B', exact: true }).click();
  await expect(page.locator('#vector-result')).toContainText('没有确定的夹角');
  await page.locator('#vector-ax').fill('');
  await expect(page.locator('#vector-error')).toContainText('有限数字');
  expect(errors).toEqual([]);
});

test('tablet control panels can collapse without losing their state', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  await page.setViewportSize({ width: 900, height: 800 });
  await openApp(page);
  const card = page.locator('#panel-graph .control-card');
  const toggle = card.locator('.tablet-control-toggle');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(card).toHaveClass(/is-collapsed/);
  await expect(card.locator('.function-input')).toBeHidden();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.function-input')).toHaveValue('sin(x)');
});

test('calculations remain available when WebGL cannot initialize', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  const errors = collectPageErrors(page);
  await page.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value(this: HTMLCanvasElement, type: string, ...args: unknown[]) {
        if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') return null;
        return Reflect.apply(originalGetContext, this, [type, ...args]);
      },
    });
  });
  await openApp(page);

  await chooseTool(page, 'vector');
  await expect(page.locator('#vector-result')).toContainText('(4, 5, 3)');
  await expect(page.locator('#vector-status')).toContainText('WebGL 不可用');
  await expect(page.locator('#vector-stage .scene-fallback')).toBeVisible();

  await chooseTool(page, 'curve');
  await expect(page.locator('#curve-canvas')).toHaveAttribute('data-point-count', '1001');
  await expect(page.locator('#curve-status')).toContainText('WebGL 不可用');
  expect(errors).toEqual([]);
});
