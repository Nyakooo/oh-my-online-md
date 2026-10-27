const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch();
  const baseURL = process.env.TEST_URL || 'http://localhost:10778';
  const owner = await browser.newContext({ baseURL, permissions: ['clipboard-read', 'clipboard-write'], colorScheme: 'light' });
  const visitor = await browser.newContext({ baseURL });
  const page = await owner.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const writes = [];
  page.on('request', request => { if (request.method() !== 'GET' && request.url().includes('/api/notes')) writes.push(request.url()); });
  try {
    await page.goto('/');
    assert.equal(new URL(page.url()).pathname, '/login');
    assert.equal(await page.locator('input').count(), 1);
    await page.screenshot({ path: '/tmp/online-md-password-login.png' });
    await page.getByLabel('访问密码').fill('wrong-password');
    await page.getByRole('button', { name: '进入笔记' }).click();
    await page.getByRole('alert').filter({ hasText: '密码错误' }).waitFor();
    await page.getByLabel('访问密码').fill('test-password');
    await page.getByRole('button', { name: '进入笔记' }).click();
    await page.waitForURL(baseURL + '/');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '草稿');
    await page.locator('#title').fill('分享测试');
    await page.locator('.cm-content').click();
    await page.keyboard.insertText('## 分享的正文\n\n**跨端分享**\n');
    await page.locator('.cm-content').evaluate(el => {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const clipboard = new DataTransfer(); clipboard.items.add(new File([png], 'image.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    });
    await page.getByRole('button', { name: '分享笔记', exact: true }).click();
    await page.locator('#create-share:not([disabled])').waitFor();
    assert.equal(writes.length, 0, 'opening the dialog must not save or upload');
    assert.deepEqual(await page.locator('#share-days option').evaluateAll(options => options.map(option => option.value)), ['1','2','3','4','5','6','7']);
    await page.locator('#share-days').selectOption('7');
    assert.equal(await page.locator('#create-share').textContent(), '保存并生成链接');
    await page.locator('#create-share').click();
    await page.locator('#share-result:not([hidden])').waitFor();
    const firstLink = await page.locator('#share-link').inputValue();
    assert.match(firstLink, /\/s\/[a-f0-9]{32}\/$/);
    await page.locator('#copy-share').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstLink);
    const reader = await visitor.newPage();
    await reader.goto(firstLink);
    assert.equal(await reader.locator('h1').textContent(), '分享测试');
    assert.equal(await reader.locator('h2').textContent(), '分享的正文');
    await reader.waitForFunction(() => document.querySelector('img')?.naturalWidth === 1);
    const snapshotImage = new URL(await reader.locator('img').getAttribute('src'), firstLink).href;
    assert.equal(await reader.locator('textarea,[contenteditable],.markdown button').count(), 0);
    assert.equal(await reader.locator('#share-theme-toggle').count(), 1);
    assert.equal((await visitor.request.get('/api/notes')).status(), 401);
    await page.getByRole('button', { name: '关闭分享' }).click();
    await page.locator('.cm-content').click(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('后续私密修改');
    await page.locator('#save-note').click();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    await reader.reload();
    assert.equal(await reader.locator('h2').textContent(), '分享的正文');
    assert.equal((await visitor.request.get(snapshotImage)).status(), 200, 'snapshot image must survive original-image cleanup');
    await page.getByRole('button', { name: '切换到黑夜模式', exact: true }).click();
    await page.getByRole('button', { name: '分享笔记', exact: true }).click();
    await page.locator('#create-share:not([disabled])').waitFor();
    const palette = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return ['--page','--sidebar','--paper','--text','--body-text','--muted','--line','--hover','--accent','--accent-soft','--accent-text','--danger','--plus-ink','--mark'].map(name => [name, style.getPropertyValue(name).trim()]);
    });
    for (const [name,color] of palette) { const hex=color.slice(1); assert.equal(hex.slice(0,2),hex.slice(2,4),name); assert.equal(hex.slice(2,4),hex.slice(4,6),name); }
    await page.screenshot({ path: '/tmp/online-md-share-dark.png' });
    await page.locator('#share-days').selectOption('1');
    await page.locator('#create-share').click();
    await page.waitForFunction(old => document.querySelector('#share-link').value !== old, firstLink);
    const secondLink = await page.locator('#share-link').inputValue();
    assert.equal((await visitor.request.get(firstLink)).status(), 404);
    assert.equal((await visitor.request.get(secondLink)).status(), 200);
    await page.locator('#revoke-share').click();
    await page.locator('#share-result[hidden]').waitFor({ state: 'attached' });
    assert.equal((await visitor.request.get(secondLink)).status(), 404);
    // Expiry is tested without sleeping or changing the server's clock.
    if (process.env.TEST_DATA_DIR) {
      await page.locator('#create-share').click();
      await page.locator('#share-result:not([hidden])').waitFor();
      const expiredLink = await page.locator('#share-link').inputValue();
      const notes = fs.readdirSync(process.env.TEST_DATA_DIR);
      const metadata = notes.map(name => path.join(process.env.TEST_DATA_DIR, name, 'share.json')).find(filename => fs.existsSync(filename));
      const record = JSON.parse(fs.readFileSync(metadata)); record.expiresAt = new Date(Date.now() - 1000).toISOString();
      fs.writeFileSync(metadata, JSON.stringify(record));
      assert.equal((await visitor.request.get(expiredLink)).status(), 404);
    }
    await page.setViewportSize({ width:390, height:844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: 1–7-day dialog, explicit save-and-share, clipboard, anonymous read-only content/images, immutable snapshot, regeneration, revocation, expiry, grayscale dark palette, mobile layout');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
