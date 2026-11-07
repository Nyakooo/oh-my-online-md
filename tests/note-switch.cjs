const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL: process.env.TEST_URL });
    const page = await context.newPage();
    const first = await (await page.request.post('/api/notes', { data: { title: '切换目标', content: '目标正文' } })).json();
    const second = await (await page.request.post('/api/notes', { data: { title: '当前笔记', content: '当前正文' } })).json();
    await page.goto('/'); await page.waitForFunction(() => !loading);
    // Make the start deterministic if creation timestamps tie.
    await page.evaluate(id => openNote(id), second.id);
    await page.evaluate(() => { window.sidebarNodes = [...document.querySelector('#note-list').children]; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/notes/' + first.id, async route => { await gate; await route.continue(); });
    const requested = page.waitForRequest('**/api/notes/' + first.id);
    await page.locator(`[data-note-id="${first.id}"]`).click(); await requested;
    assert.equal(await page.locator('#new-note').isVisible(), true, 'New-note button must stay visible while switching');
    assert.equal(await page.locator('#note-list').evaluate(el => getComputedStyle(el).opacity), '1', 'Directory must not dim');
    assert.equal(await page.locator('#new-note').isDisabled(), false, 'Do not restyle sidebar buttons during navigation');
    assert.equal(await page.locator('#sidebar').evaluate(el => el.inert), true, 'Keep navigation guarded while request is pending');
    release();
    await page.waitForFunction(id => !loading && state.current === id, first.id);
    assert.equal(await page.locator('#title').inputValue(), '切换目标');
    assert.equal(await page.evaluate(() => window.sidebarNodes.every((node, i) => node === document.querySelector('#note-list').children[i])), true, 'Reuse directory rows when selection changes');
    assert.equal(await page.locator('.note-item.active').getAttribute('data-note-id'), first.id);
    await page.unroute('**/api/notes/' + first.id);
    const defaultID = await page.evaluate(() => state.notes[0].id);
    const last = defaultID === first.id ? second : first;
    await page.locator(`[data-note-id="${last.id}"]`).click();
    await page.waitForFunction(id => !loading && state.current === id, last.id);
    const reopened = await context.newPage();
    await reopened.goto('/');
    await reopened.waitForFunction(() => !loading);
    assert.equal(await reopened.evaluate(() => state.current), last.id, 'Opening the site in a new tab restores the last visited note');
    assert.ok((await page.request.delete('/api/notes/' + last.id)).ok());
    await reopened.reload();
    await reopened.waitForFunction(() => !loading);
    assert.equal(await reopened.evaluate(() => state.current), defaultID, 'A deleted note falls back to the available note');
    console.log('PASS: note switching preserves sidebar state, and reopening restores the last available note');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
