const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: process.env.TEST_URL || 'http://localhost:10778' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    const created = [];
    for (const data of [
      { title: '全局查找 Alpha', content: '这是一份普通记录' },
      { title: '正文命中', content: '前文\n\n全局查找 alpha 中文测试\n\na+b [test] <img src=x onerror=alert(1)>' },
      { title: '不匹配的笔记', content: '单独的记录' }
    ]) {
      const response = await page.request.post('/api/notes', { data });
      assert.equal(response.status(), 201); created.push(await response.json());
    }
    await page.goto('/');
    await page.locator('#save-note[data-state="saved"]').waitFor();
    await page.keyboard.press('ControlOrMeta+k');
    const search = page.getByRole('searchbox', { name: '搜索全部笔记' });
    await search.fill('全局查找 ALPHA');
    await page.waitForFunction(() => document.querySelector('#list-label').textContent === '搜索结果 · 2');
    assert.equal(await page.locator('.note-item mark').count(), 2);
    await page.locator('.note-item').filter({ hasText: '正文命中' }).click();
    await page.waitForFunction(() => document.querySelector('#title').value === '正文命中');
    await page.locator('#title').fill('尚未保存的标题');
    await search.fill('a+b [test]');
    await page.waitForFunction(() => document.querySelector('#list-label').textContent === '搜索结果 · 1');
    assert.equal(await page.locator('.note-snippet mark').textContent(), 'a+b [test]');
    assert.equal(await page.locator('.note-snippet img').count(), 0, 'excerpts must be escaped');
    assert.equal(await page.locator('#title').inputValue(), '尚未保存的标题');
    await search.fill('完全没有匹配的内容');
    await page.getByText('没有找到匹配的笔记。', { exact: true }).waitFor();
    await search.press('Escape');
    await page.waitForFunction(() => document.querySelector('#list-label').textContent === '我的笔记');
    assert.ok(await page.locator('.note-item').count() >= 3);
    await page.locator('.note-item').filter({ hasText: '全局查找 Alpha' }).click();
    await page.locator('#unsaved-dialog[open]').waitFor();
    await page.locator('#cancel-navigation').click();
    assert.equal(await page.locator('#title').inputValue(), '尚未保存的标题');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '笔记列表', exact: true }).click();
    await search.fill('中文测试');
    await page.waitForFunction(() => document.querySelector('#list-label').textContent === '搜索结果 · 1');
    assert.ok(await search.isVisible());
    assert.deepEqual(errors, []);
    console.log('PASS: global title/body search, case-insensitive Chinese text, literal symbols, safe highlighted excerpts, empty/clear, keyboard shortcut, unsaved protection and mobile search');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
