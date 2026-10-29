const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const server = process.env.TEST_URL, second = process.env.SECOND_TEST_URL;
  const work = await fs.mkdtemp('/tmp/jianji-import-');
  const extension = path.join(work, 'extension');
  await fs.cp(path.resolve('dist/extension'), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const profile = path.join(work, 'profile');
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  let context = await launch();
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const base = 'chrome-extension://' + new URL(worker.url()).host;
    const setup = await context.newPage(); await setup.goto(base + '/options.html');
    // Real upgrade from the first-stage IndexedDB schema, including a saved image.
    await setup.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('jianji-local', 1);
        request.onupgradeneeded = () => { request.result.createObjectStore('notes', { keyPath: 'id' }); request.result.createObjectStore('folders', { keyPath: 'name' }); request.result.createObjectStore('assets', { keyPath: 'key' }); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const tx = db.transaction(['notes','folders','assets'], 'readwrite');
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const htmlLiteral = `<div data-example="<img src='assets/${'f'.repeat(32)}.png'>">保留示例</div>`;
      tx.objectStore('notes').put({ id: 'a'.repeat(32), title: '带图片的笔记', content: htmlLiteral + '\n\n' + '![图片](assets/' + 'b'.repeat(32) + '.png)\n\n`assets/' + 'b'.repeat(32) + '.png`\n\n```text\n/api/notes/' + 'a'.repeat(32) + '/assets/' + 'b'.repeat(32) + '.png\n```\n\n示例文字 assets/' + 'b'.repeat(32) + '.png\n\n<img alt="example src=\'assets/' + 'f'.repeat(32) + '.png\'" src="assets&#47;' + 'b'.repeat(32) + '.png" data-src="assets/' + 'b'.repeat(32) + '.png">\n\n[图片引用][local]\n\n[local]: <assets/' + 'b'.repeat(32) + '.png>\n\n<!-- <img src="assets/' + 'f'.repeat(32) + '.png"> -->', folder: '导入目录', version: 'c'.repeat(32), updatedAt: new Date().toISOString() });
      tx.objectStore('notes').put({ id: 'd'.repeat(32), title: '不应选中的笔记', content: '保留本地', folder: '', version: 'e'.repeat(32), updatedAt: new Date().toISOString() });
      tx.objectStore('folders').put({ name: '导入目录', protected: false, locked: false });
      tx.objectStore('assets').put({ key: 'a'.repeat(32) + '/' + 'b'.repeat(32) + '.png', blob: new Blob([png], { type: 'image/png' }) });
      await new Promise((resolve,reject) => { tx.oncomplete=resolve; tx.onabort=() => reject(tx.error); }); db.close();
      await chrome.storage.local.set({ workspaceMode: 'local' });
    });
    let page = await context.newPage(); await page.goto(base + '/app.html');
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => state.notes.length), 2);
    await page.locator('#connection-settings').click(); await page.locator('#server-url').fill(server);
    await page.locator('#server-password').fill(process.env.TEST_PASSWORD); await page.locator('#connect-server').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' }); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => state.notes.length), 0, 'switch must not auto-upload');
    await page.locator('#connection-settings').click(); await page.locator('#open-server-import').click();
    await page.locator('#server-import-list input').first().waitFor();
    assert.equal(await page.locator('#confirm-server-import').isDisabled(), true, 'selection must be explicit');
    await page.locator('#server-import-list input[value="' + 'a'.repeat(32) + '"]').check();
    // The server commits, but the client never receives its successful response.
    let lostID;
    await page.route(server + '/api/import/notes/*', async route => {
      const response = await route.fetch(); assert.equal(response.status(), 201);
      lostID = (await response.json()).id;
      await route.abort();
    });
    await page.locator('#confirm-server-import').click();
    await page.waitForFunction(() => document.querySelector('#server-import-status').textContent.includes('再次点击可重试'));
    const session = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
    const headers = { Authorization: 'Bearer ' + session.token };
    const remoteNotes = async () => (await fetch(server + '/api/notes', { headers })).json();
    assert.equal((await remoteNotes()).length, 1, 'server committed despite lost response');
    await context.close(); context = await launch();
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    page = await context.newPage(); await page.goto(base + '/app.html'); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    await page.locator('#connection-settings').click(); await page.locator('#open-server-import').click();
    await page.locator('#server-import-list input[value="' + 'a'.repeat(32) + '"]').check();
    await page.locator('#confirm-server-import').click();
    await page.waitForFunction(() => document.querySelector('#server-import-status').textContent.startsWith('已完成 1/1 篇'));
    const notes = await remoteNotes(); assert.equal(notes.length, 1); assert.equal(notes[0].id, lostID); assert.equal(notes[0].folder, '导入目录');
    const note = await (await fetch(server + '/api/notes/' + lostID, { headers })).json();
    const image = note.content.match(/!\[图片\]\(assets\/([a-f0-9]{32}\.png)\)/)[1];
    assert.ok(note.content.includes(`<div data-example="<img src='assets/${'f'.repeat(32)}.png'>">保留示例</div>`), 'generic HTML quoted attributes remain literal');
    assert.ok(note.content.includes('`assets/' + 'b'.repeat(32) + '.png`'), 'inline code remains literal');
    assert.ok(note.content.includes('```text\n/api/notes/' + 'a'.repeat(32) + '/assets/' + 'b'.repeat(32) + '.png\n```'), 'fenced code remains literal');
    assert.ok(note.content.includes('示例文字 assets/' + 'b'.repeat(32) + '.png'), 'prose remains literal');
    assert.ok(note.content.includes('data-src="assets/' + 'b'.repeat(32) + '.png"'), 'non-destination attributes remain literal');
    assert.ok(note.content.includes('src="assets/' + image + '"'), 'HTML image destination is rewritten');
    assert.ok(note.content.includes('alt="example src=\'assets/' + 'f'.repeat(32) + '.png\'"'), 'attribute contents remain literal');
    assert.ok(note.content.includes('[local]: <assets/' + image + '>'), 'reference destination is rewritten');

    const response = await fetch(server + '/api/notes/' + lostID + '/assets/' + image, { headers });
    assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, 68);
    await page.locator('#confirm-server-import').click();
    await page.waitForFunction(() => !document.querySelector('#confirm-server-import').disabled);
    assert.equal((await remoteNotes()).length, 1, 'completed import must be skipped');
    await page.locator('#close-server-import').click(); await page.locator('#back-to-notes').click();
    await page.locator('.note-item').click(); await page.locator('#preview-tab').click();
    await page.waitForFunction(() => document.querySelector('#preview-panel img')?.naturalWidth === 1);
    await page.locator('#connection-settings').click(); await page.locator('#use-local').click(); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => state.notes.length), 2, 'local originals remain');
    // A distinct server gets its own identity and progress.
    await page.locator('#connection-settings').click(); await page.locator('#server-url').fill(second); await page.locator('#server-password').fill(process.env.TEST_PASSWORD); await page.locator('#connect-server').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' }); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    await page.locator('#connection-settings').click(); await page.locator('#open-server-import').click();
    await page.locator('#server-import-list input[value="' + 'a'.repeat(32) + '"]').check(); await page.locator('#confirm-server-import').click();
    await page.waitForFunction(() => document.querySelector('#server-import-status').textContent.startsWith('已完成 1/1 篇'));
    const nextSession = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
    const next = await (await fetch(second + '/api/notes', { headers: { Authorization: 'Bearer ' + nextSession.token } })).json();
    assert.equal(next.length, 1); assert.notEqual(next[0].id, lostID);
    await page.screenshot({ path: '/tmp/jianji-server-import.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await page.locator('#server-import-dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.height <= 844, 'import dialog fits narrow windows');
    assert.deepEqual(errors, []);
    console.log('PASS: schema upgrade, explicit selection, image import, lost response + browser restart retry, deduplication, original preservation and server isolation');
  } finally { await context.close(); await fs.rm(work, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
