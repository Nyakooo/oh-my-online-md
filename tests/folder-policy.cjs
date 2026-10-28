const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: process.env.TEST_URL });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  try {
    const roots = [], children = [];
    for (const name of ['外层 A', '外层 B', '外层 C']) roots.push(await (await page.request.post('/api/notes', { data: { title: name, content: '独立笔记' } })).json());
    for (const name of ['受保护', '资料']) assert.equal((await page.request.post('/api/folders', { data: { name } })).status(), 201);
    for (const name of ['内部 A', '内部 B']) {
      const note = await (await page.request.post('/api/notes', { data: { title: name, content: '私密正文' } })).json(); children.push(note);
      assert.equal((await page.request.put('/api/notes/' + note.id + '/folder', { data: { folder: '受保护' } })).status(), 200);
    }
    assert.equal((await page.request.put('/api/folders/' + encodeURIComponent('受保护'), { data: { name: '受保护', password: 'p' } })).status(), 200);
    await page.clock.install();
    await page.goto('/'); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    const order = () => page.locator('#note-list').evaluate(el => [...el.children].map(e => e.dataset.noteId || e.dataset.folder));
    const initial = await order(); assert.deepEqual(initial.slice(-2).sort(), ['受保护', '资料'].sort());
    const rootRow = id => page.locator(`#note-list > [data-note-id="${id}"]`);
    await rootRow(roots[0].id).dragTo(rootRow(roots[2].id), { targetPosition: { x: 30, y: 3 } });
    await page.waitForFunction(id => !folderState.busy && document.querySelector('#note-list').firstElementChild.dataset.noteId === id, roots[0].id);
    const groups = page.locator('.folder-group');
    await groups.nth(1).locator('.folder-row').dragTo(groups.nth(0).locator('.folder-row'), { targetPosition: { x: 40, y: 3 } });
    await page.waitForFunction(() => !folderState.busy && document.querySelector('.folder-group').dataset.folder === '资料');
    const sorted = await order();
    await page.reload(); await page.locator('#loading-panel').waitFor({ state: 'hidden' }); assert.deepEqual(await order(), sorted);
    async function unlock() {
      await page.getByRole('button', { name: '解锁文件夹 受保护', exact: true }).click();
      await page.locator('#folder-password').fill('p'); await page.locator('#folder-confirm').click();
      await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    }
    await unlock();
    const privateGroup = page.locator('.folder-group[data-folder="受保护"]');
    const childRow = id => privateGroup.locator(`[data-note-id="${id}"]`);
    await childRow(children[0].id).dragTo(childRow(children[1].id), { targetPosition: { x: 30, y: 3 } });
    await page.waitForFunction(id => !folderState.busy && document.querySelector('.folder-group[data-folder="受保护"] .note-item').dataset.noteId === id, children[0].id);
    await childRow(children[0].id).click(); await page.waitForFunction(id => !loading && state.current === id, children[0].id);
    await childRow(children[1].id).click(); await page.waitForFunction(id => !loading && state.current === id, children[1].id);
    assert.equal(await page.locator('#folder-dialog').isVisible(), false, 'same-folder navigation stays unlocked');
    await page.reload(); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await privateGroup.locator('.note-item').count(), 0, 'refresh must relock');
    const currentRead = async () => page.request.get('/api/notes/' + children[0].id, { headers: { 'X-Note-Window': await page.evaluate(() => folderSession.windowID) } });
    assert.equal((await currentRead()).status(), 403);
    await unlock(); await childRow(children[0].id).click(); await page.waitForFunction(() => !loading);
    await page.locator('#title').fill('自动锁定前未保存');
    await page.locator('.cm-content').evaluate(el => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([bytes], 'draft.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const draft = await page.evaluate(() => contentEditor.getValue());
    await page.getByRole('button', { name: '图片尺寸', exact: true }).click();
    await page.locator('.media-dialog [name=src]').fill('https://private.example/image.png');
    await page.clock.fastForward(300001);
    assert.equal(await page.locator('.media-dialog').isVisible(), false);
    assert.equal(await page.locator('.media-dialog [name=src]').inputValue(), '');
    await page.locator('#folder-locked-panel').waitFor(); await page.waitForFunction(() => !folderSession.busy);
    assert.equal(await page.locator('#title').inputValue(), '');
    assert.equal(await page.evaluate(() => pendingImages.size), 0);
    assert.equal((await currentRead()).status(), 403);
    const writes = []; page.on('request', r => { if (r.method() === 'POST' && /\/api\/notes$/.test(r.url())) writes.push(r.url()); });
    await page.keyboard.press('ControlOrMeta+s'); assert.equal(writes.length, 0, 'locked editor cannot save an empty draft');
    await page.locator('#unlock-active-folder').click(); await page.locator('#folder-password').fill('p'); await page.locator('#folder-confirm').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#title').inputValue(), '自动锁定前未保存');
    assert.equal(await page.evaluate(() => contentEditor.getValue()), draft);
    assert.equal(await page.evaluate(() => pendingImages.size), 1);
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => document.querySelector('#preview-panel img')?.naturalWidth === 1);
    await rootRow(roots[0].id).click(); await page.locator('#unsaved-dialog[open]').waitFor(); await page.locator('#cancel-navigation').click();
    assert.equal(await page.locator('#title').inputValue(), '自动锁定前未保存');
    await rootRow(roots[0].id).click(); await page.locator('#discard-changes').click();
    await page.waitForFunction(id => !loading && state.current === id, roots[0].id);
    assert.equal((await currentRead()).status(), 403, 'leaving a protected folder revokes access');
    await page.getByRole('button', { name: '解锁文件夹 受保护', exact: true }).waitFor();
    await unlock();
    await page.getByRole('button', { name: '收起文件夹 受保护', exact: true }).click();
    await page.getByRole('button', { name: '解锁文件夹 受保护', exact: true }).waitFor();
    assert.equal((await currentRead()).status(), 403, 'collapsing a protected folder revokes access');
    await unlock(); await childRow(children[0].id).click(); await page.waitForFunction(() => !loading);
    // Navigating away must conceal cached private DOM before any network response.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    assert.equal(await page.locator('#title').inputValue(), '');
    assert.equal(await page.evaluate(() => contentEditor.getValue()), '');
    await page.waitForFunction(() => !folderSession.busy);
    await page.locator('#unlock-active-folder').click(); await page.locator('#folder-password').fill('p'); await page.locator('#folder-confirm').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    const image = await page.evaluate(async () => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const uploaded = await api(`/api/notes/${state.current}/assets`, { method: 'POST', body: bytes });
      contentEditor.setValue(`![私密图片](${uploaded.path})\n[下载图片](${uploaded.path})`); markDirty();
      return uploaded.path;
    });
    await page.locator('#save-note').click(); await page.waitForFunction(() => !state.saving && !state.dirty);
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => document.querySelector('#preview-panel img')?.src.startsWith('blob:') && document.querySelector('#preview-panel img').naturalWidth === 1);
    const download = page.waitForEvent('download'); await page.getByRole('link', { name: '下载图片', exact: true }).click();
    assert.equal((await download).suggestedFilename(), image.split('/').pop());
    await page.locator('#move-note').click(); await page.locator('#folder-destination').selectOption(''); await page.locator('#folder-confirm').click();
    await page.waitForFunction(() => !folderState.busy && !loading && state.folder === '');
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => document.querySelector('#preview-panel img')?.src.startsWith('blob:') && document.querySelector('#preview-panel img').naturalWidth === 1);
    await unlock(); await childRow(children[1].id).click(); await page.waitForFunction(() => !loading);
    await page.evaluate(() => {
      const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      insertImages([new File([bytes], 'race.png', { type: 'image/png' })]);
    });
    let releaseUpload, uploaded;
    const uploadReady = new Promise(resolve => { uploaded = resolve; });
    const uploadGate = new Promise(resolve => { releaseUpload = resolve; });
    await page.route('**/api/notes/*/assets', async route => {
      const response = await route.fetch(); uploaded(); await uploadGate; await route.fulfill({ response });
    });
    const rootWrites = []; page.on('request', r => { if (r.method() === 'POST' && /\/api\/notes$/.test(r.url())) rootWrites.push(r.url()); });
    await page.locator('#save-note').click(); await uploadReady;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    releaseUpload(); await page.waitForFunction(() => !state.saving && !folderSession.busy);
    assert.equal(await page.evaluate(() => state.current), null);
    assert.equal(await page.evaluate(() => contentEditor.getValue()), '');
    assert.deepEqual(rootWrites, [], 'a save interrupted by locking cannot create an unprotected note');
    assert.deepEqual(errors, []);
    console.log('PASS: root notes above folders, note/folder/child drag ordering persists, refresh relocks, idle locks, draft/image restore and leave/collapse revocation');
  } finally { await context.close(); await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
