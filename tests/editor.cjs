const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function pasteImage(page) {
  await page.evaluate(() => contentEditor.focus());
  await page.locator('.cm-content').evaluate(el => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.locator('#preview-tab').click();
  await page.waitForFunction(() => { const img = document.querySelector('#content img'); return img?.src.startsWith('blob:') && img.complete && img.naturalWidth === 1; });
}
async function getSource(page) { return page.evaluate(() => contentEditor.getValue()); }
async function setSource(page, text) {
  await page.locator('#edit-tab').click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  if (text) await page.keyboard.insertText(text);
  else await page.keyboard.press('Backspace');
  await page.locator('#preview-tab').click();
}
async function save(page) {
  await page.locator('#save-note').click();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存' && document.querySelector('#save-note').disabled);
}
function diskImages() {
  if (!process.env.TEST_DATA_DIR) return null;
  return fs.readdirSync(process.env.TEST_DATA_DIR).flatMap(dir => {
    const assets = path.join(process.env.TEST_DATA_DIR, dir, 'assets');
    return fs.existsSync(assets) ? fs.readdirSync(assets) : [];
  });
}
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ baseURL: process.env.TEST_URL || 'http://localhost:10778' });
  const errors = [];
  const writes = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() !== 'GET' && /\/api\/notes/.test(r.url())) writes.push(r.url()); });
  try {
    await page.goto(process.env.TEST_URL || 'http://localhost:10778');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '草稿');
    await page.locator('#title').fill('浏览器回归测试');
    const markdown = '## 测试标题\n\n**加粗**\n\n- 列表项\n\n| A | B |\n|---|---|\n| 1 | 2 |';
    await setSource(page, markdown);
    await page.locator('#content h2').waitFor();
    assert.equal(await page.locator('#content strong').textContent(), '加粗');
    assert.equal(await page.locator('#content table').count(), 1);
    assert.equal(await page.locator('.topbar button:visible').count(), 4);
    assert.equal(await page.locator('.editor-toolbar').count(), 1);
    await page.locator('#edit-tab').click();
    assert.equal(await getSource(page), markdown);
    await page.locator('.cm-content').click();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.insertText('缩进');
    assert.match(await getSource(page), /\n\s+缩进$/);
    await page.keyboard.press('Shift+Tab');
    assert.match(await getSource(page), /\n缩进$/);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText('快捷键');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+b');
    assert.equal(await getSource(page), '**快捷键**');
    await page.keyboard.press('ControlOrMeta+z');
    assert.equal(await getSource(page), '快捷键');
    await page.keyboard.press('ControlOrMeta+Shift+p');
    assert.equal(await page.locator('#preview-tab').getAttribute('aria-selected'), 'true');
    await setSource(page, '```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```');
    await page.locator('.diagram-canvas svg').waitFor();
    const originalWidth = await page.locator('.diagram-canvas svg').evaluate(el => el.getBoundingClientRect().width);
    await page.getByRole('button', {name:'放大图表',exact:true}).click();
    assert.equal(await page.locator('.diagram output').textContent(), '125%');
    assert.ok(await page.locator('.diagram-canvas svg').evaluate(el => el.getBoundingClientRect().width) > originalWidth);
    await page.getByRole('button', {name:'重置图表缩放',exact:true}).click();
    assert.equal(await page.locator('.diagram output').textContent(), '100%');
    await setSource(page, '```mermaid\nnot a valid diagram\n```');
    await page.waitForFunction(() => document.querySelector('.diagram-status')?.textContent.includes('无法渲染'));
    await setSource(page, markdown);

    await pasteImage(page);
    assert.match(await page.locator('#content img').getAttribute('src'), /^blob:/);
    assert.equal(writes.length, 0, 'pasting must not create a note or upload an image');
    assert.deepEqual(await (await page.request.get('/api/notes')).json(), []);
    if (process.env.TEST_DATA_DIR) assert.deepEqual(fs.readdirSync(process.env.TEST_DATA_DIR), []);
    await save(page);
    assert.equal(await page.locator('#save-note').textContent(), '✓');
    const savedSource = await getSource(page);
    assert.match(savedSource, /!\[图片\]\(assets\/[a-f0-9]{32}\.png\)/);
    assert.ok(!savedSource.includes('pending/'));
    // A slow authenticated image must not be mistaken for the 1×1 loading placeholder.
    await page.route('**/api/notes/*/assets/*', async route => { await new Promise(resolve => setTimeout(resolve, 1000)); await route.continue(); }, { times: 1 });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => document.querySelector('#content img')?.src.startsWith('blob:') && document.querySelector('#content img').naturalWidth === 1);
    assert.equal(await getSource(page), savedSource);
    assert.match(await page.locator('#content img').getAttribute('src'), /^blob:/);
    const imageURL = '/api/notes/' + await page.evaluate(() => state.current) + '/' + savedSource.match(/assets\/[a-f0-9]{32}\.png/)[0];
    if (diskImages()) assert.equal(diskImages().length, 1);

    // Removing one of two references must keep the shared file.
    const imageRef = savedSource.match(/!\[图片\]\(assets\/[a-f0-9]{32}\.png\)/)[0];
    await setSource(page, savedSource + '\n' + imageRef);
    await save(page);
    await setSource(page, savedSource);
    await save(page);
    assert.equal((await page.request.get(imageURL)).status(), 200);

    // Deleting the last reference only removes the server file after saving.
    await setSource(page, markdown);
    assert.equal((await page.request.get(imageURL)).status(), 200);
    await save(page);
    assert.equal((await page.request.get(imageURL)).status(), 404);
    if (diskImages()) assert.deepEqual(diskImages(), []);

    // Existing note + paste + discard produces no upload and preserves saved text.
    const beforeDiscard = writes.length;
    await pasteImage(page);
    assert.equal(writes.length, beforeDiscard);
    await page.locator('#new-note').click();
    await page.locator('#discard-changes').click();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '草稿');
    assert.equal(writes.length, beforeDiscard);
    if (diskImages()) assert.deepEqual(diskImages(), []);

    // An image removed before the first save must never reach the server.
    await pasteImage(page);
    await setSource(page, '图片已在保存前移除');
    const beforeSave = writes.length;
    await save(page);
    assert.ok(writes.slice(beforeSave).every(url => !url.endsWith('/assets')));
    if (diskImages()) assert.deepEqual(diskImages(), []);

    // Failed final save leaves local preview intact; discarding that image on a
    // retry must also remove the upload from the failed attempt.
    await pasteImage(page);
    await page.route('**/api/notes/*', route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"模拟保存失败"}' }) : route.continue());
    await page.locator('#save-note').click();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '保存失败');
    assert.match(await getSource(page), /assets\/pending\//);
    if (diskImages()) assert.equal(diskImages().length, 1);
    await page.unroute('**/api/notes/*');
    await setSource(page, '失败后删除图片并重试保存');
    await save(page);
    if (diskImages()) assert.deepEqual(diskImages(), []);

    assert.equal(await page.locator('.editor-toolbar').count(), 1);
    assert.equal(await page.locator('.topbar button:visible').count(), 4);
    assert.equal(await page.locator('#notice').isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('PASS: edit/preview tabs, Tab indentation, formatting shortcuts, undo, Mermaid zoom and errors, save feedback, local-only paste, reload, image cleanup, discard, failed-save retry, mobile layout');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
