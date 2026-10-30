const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  try {
    const setup = await browser.newPage({ baseURL: process.env.TEST_URL });
    const target = await (await setup.request.post('/api/notes', { data: { title: '移动端目标', content: '原正文' } })).json();
    for (let i = 0; i < 24; i++) await setup.request.post('/api/notes', { data: { title: '滚动笔记 ' + i, content: '列表滚动测试' } });
    await setup.request.post('/api/folders', { data: { name: '手机目录' } });
    await setup.close();
    for (const [width, height] of [[320,568], [375,667], [390,844], [430,932], [768,1024]]) {
      const page = await browser.newPage({ baseURL: process.env.TEST_URL, viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'light' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('/'); await page.waitForFunction(() => !loading);
      if (width <= 760) {
        assert.equal(await page.locator('#sidebar').isVisible(), false);
        await page.locator('#mobile-menu').tap();
        await page.locator('#sidebar').waitFor({ state: 'visible' });
        await page.reload(); await page.waitForFunction(() => !loading);
        assert.equal(await page.locator('#sidebar').isVisible(), true, 'Touch drawer preference survives reload');
      }
      await page.locator(`[data-note-id="${target.id}"]`).tap();
      await page.waitForFunction(id => !loading && state.current === id, target.id);
      if (width <= 760) await page.locator('#sidebar').waitFor({ state: 'hidden' });
      await page.locator('#title').fill('手机保存 ' + width);
      await page.locator('.cm-content').tap();
      await page.keyboard.press('ControlOrMeta+a');
      await page.keyboard.insertText('手机正文 ' + width + '\n\n```\n' + 'long_code_'.repeat(30) + '\n```');
      await page.locator('#save-note').tap();
      await page.waitForFunction(() => !state.saving && !state.dirty);
      await page.reload(); await page.waitForFunction(() => !loading);
      assert.equal(await page.locator('#title').inputValue(), '手机保存 ' + width);
      assert.equal(await page.evaluate(() => contentEditor.getValue().startsWith('手机正文')), true);
      await page.locator('#preview-tab').tap();
      for (const theme of ['light','dark']) {
        if (await page.evaluate(() => isDarkTheme()) !== (theme === 'dark')) await page.locator('#theme-toggle').tap();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow: ${width}px ${theme}`);
        for (const id of ['theme-toggle', 'save-note', ...(width <= 760 ? ['mobile-menu'] : ['sidebar-toggle'])]) {
          const rect = await page.locator('#' + id).boundingBox();
          assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width, `${id} fits ${width}px`);
        }
        if (width <= 760) {
          await page.locator('#mobile-menu').tap();
          assert.equal(await page.locator('#note-list').evaluate(el => el.scrollHeight > el.clientHeight), true, 'Long directory scrolls inside drawer');
          await page.touchscreen.tap(width - 8, 120);
          await page.locator('#sidebar').waitFor({ state: 'hidden' });
        }
      }
      assert.deepEqual(errors, []);
      console.log(`PASS: touch ${width}x${height}, light/dark, scrolling, persistence, note switch/edit/save/reload, no overflow or page errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
