const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
async function check(page, label) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => !loading);
  await page.evaluate(() => contentEditor.setValue('## 长文标题\n\n' + '用于验证滚动时工具栏可用的正文。\n\n'.repeat(180)));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const theme of ['light', 'dark']) {
      if (await page.evaluate(() => isDarkTheme()) !== (theme === 'dark')) await page.locator('#theme-toggle').click();
      for (const mode of ['edit', 'preview']) {
        await page.locator('#' + mode + '-tab').click();
        await page.locator('#editor-pane').evaluate(el => { el.scrollTop = 0; });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.editor-toolbar')).borderTopLeftRadius === '17px');
        for (const scroll of [400, 900, 1500, 'end']) {
          await page.locator('#editor-pane').evaluate((el, scroll) => { el.scrollTop = scroll === 'end' ? el.scrollHeight : scroll; }, scroll);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await page.waitForFunction(() => getComputedStyle(document.querySelector('.editor-toolbar')).borderTopLeftRadius === '0px');
          const pane = await page.locator('#editor-pane').boundingBox();
          const toolbar = await page.locator('.editor-toolbar').boundingBox();
          assert.ok(Math.abs(toolbar.y - pane.y) <= 1, `${label} ${width}px ${theme} ${mode}: toolbar must remain at scrollport top, got ${toolbar.y - pane.y}`);
          assert.equal(await page.locator('#edit-tab').evaluate(el => {
            const r = el.getBoundingClientRect();
            return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }), true, 'Tabs stay above the scrolling content and remain clickable');
        }
        if (theme === 'light' && mode === 'edit') await page.screenshot({ path: `/tmp/online-md-sticky-${label}-${width}.png` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#editor-pane').evaluate(el => { el.scrollTop = 0; });
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.editor-toolbar')).borderTopLeftRadius === '17px');
      }
    }
    await page.locator('#edit-tab').click();
    await page.getByRole('button', { name: '加粗 (Ctrl/⌘ B)', exact: true }).click();
    assert.equal(await page.evaluate(() => contentEditor.getValue().includes('**文本**')), true);
    await page.locator('#editor-pane').evaluate(el => { el.scrollTop = 0; });
    await page.locator('#preview-tab').click();
    assert.equal(await page.locator('#preview-panel strong').count() > 0, true);
    await page.locator('#edit-tab').click();
  }
  assert.deepEqual(errors, []);
  console.log(`PASS: ${label} sticky toolbar in edit/preview, light/dark, desktop/mobile, formatting and unobstructed tabs`);
}
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: process.env.TEST_URL });
    await page.goto('/');
    await check(page, 'web');
  } finally { await browser.close(); }
  const profile = await fs.mkdtemp('/tmp/jianji-sticky-');
  const extension = path.resolve('dist/extension');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto('chrome-extension://' + new URL(worker.url()).host + '/app.html');
    await page.locator('#use-local').click();
    await check(page, 'extension');
  } finally { if (context) await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
