const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: process.env.TEST_URL, viewport: { width: 1280, height: 900 } });
    await page.request.post('/api/folders', { data: { name: '汇总目录' } });
    const first = await (await page.request.post('/api/notes', { data: { title: '第一篇', content: '正文' } })).json();
    const second = await (await page.request.post('/api/notes', { data: { title: '第二篇', content: '正文' } })).json();
    await page.goto('/'); await page.waitForFunction(() => !loading);
    await page.evaluate(() => { window.originalList = document.querySelector('#note-list'); });
    await page.locator('#sidebar-toggle').click();
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('.sidebar-rail button').evaluateAll(buttons => buttons.map(button => button.id)), ['rail-new', 'rail-search', 'rail-directory', 'rail-expand']);
    await page.locator('#rail-directory').hover();
    await page.locator('#sidebar').waitFor({ state: 'visible' });
    await page.mouse.move(1100, 600);
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    await page.locator('#rail-directory').click();
    await page.mouse.move(1100, 600);
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#sidebar').isVisible(), true, 'Click keeps directory open after pointer leaves');
    await page.locator('#note-list').getByRole('button', { name: /展开文件夹 汇总目录/ }).click();
    assert.equal(await page.locator('#sidebar').isVisible(), true);
    await page.locator(`[data-note-id="${first.id}"]`).click();
    await page.waitForFunction(id => !loading && state.current === id, first.id);
    assert.equal(await page.locator('#title').inputValue(), '第一篇');
    assert.equal(await page.locator('#sidebar').isVisible(), true);
    await page.evaluate(({ second, first }) => saveSidebarSort('note', second, first), { second: second.id, first: first.id });
    assert.equal(await page.locator('#note-list > .note-item').first().getAttribute('data-note-id'), second.id);
    assert.equal(await page.evaluate(() => window.originalList === document.querySelector('#note-list')), true);
    await page.locator('#title').click();
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    await page.locator('#rail-directory').click();
    await page.keyboard.press('Escape');
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    await page.locator('#rail-search').click();
    assert.equal(await page.locator('#note-search').evaluate(el => document.activeElement === el), true);

    for (let i = 0; i < 20; i++) {
      const response = await page.request.post('/api/notes', { data: { title: '滚动笔记 ' + i, content: '正文' } });
      assert.ok(response.ok());
    }
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.reload();
    await page.waitForFunction(() => !loading);
    await page.locator('#rail-directory').click();
    const list = page.locator('#note-list');
    assert.ok(await list.evaluate(el => el.clientHeight > 0 && el.scrollHeight > el.clientHeight), 'The collapsed directory has a scrollable list in a short window');
    await list.hover();
    await page.mouse.wheel(0, 2000);
    await page.waitForFunction(() => {
      const list = document.querySelector('#note-list');
      return list.scrollTop > 0 && list.lastElementChild.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1;
    });
    const lastNote = list.locator('.note-item').last();
    const lastNoteId = await lastNote.getAttribute('data-note-id');
    await lastNote.click();
    await page.waitForFunction(id => !loading && state.current === id, lastNoteId);
    await page.setViewportSize({ width: 1280, height: 900 });
    await list.evaluate(el => { el.scrollTop = 0; });
    const rootNotes = list.locator(':scope > .note-item');
    const source = await rootNotes.first().boundingBox();
    const target = await rootNotes.nth(2).boundingBox();
    const sourceId = await rootNotes.first().getAttribute('data-note-id');
    await page.mouse.move(source.x + 30, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 30, target.y + target.height * .75, { steps: 12 });
    await page.mouse.move(target.x + 31, target.y + target.height * .75);
    await page.waitForFunction(() => document.querySelectorAll('#note-list > .note-item')[2]?.classList.contains('sort-source'));
    await page.mouse.up();
    await page.waitForFunction(id => !folderState.busy && document.querySelectorAll('#note-list > .note-item')[2]?.dataset.noteId === id, sourceId);
    assert.equal(await list.locator('.sort-source').count(), 0);
    await page.reload();
    await page.waitForFunction(() => !loading);
    assert.equal(await rootNotes.nth(2).getAttribute('data-note-id'), sourceId);

    await page.locator('#rail-directory').click();
    const listBox = await list.boundingBox();
    const folderRow = list.locator('.folder-row');
    assert.ok((await folderRow.boundingBox()).y >= listBox.y + listBox.height, 'The destination starts below the visible list');
    const draggedNote = await rootNotes.first().getAttribute('data-note-id');
    const dragBox = await rootNotes.first().boundingBox();
    await page.mouse.move(dragBox.x + 30, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(listBox.x + 30, listBox.y + listBox.height - 4, { steps: 12 });
    await page.waitForFunction(() => {
      const list = document.querySelector('#note-list');
      return list.querySelector('.folder-row').getBoundingClientRect().bottom < list.getBoundingClientRect().bottom;
    });
    const destination = await folderRow.boundingBox();
    await page.mouse.move(destination.x + 30, destination.y + destination.height / 2);
    await page.mouse.up();
    await page.waitForFunction(id => !folderState.busy && state.notes.find(note => note.id === id)?.folder === '汇总目录', draggedNote);
    console.log('PASS: directory interactions, short-window scrolling, live drag reorder, persisted order, and edge scrolling to an offscreen folder');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
