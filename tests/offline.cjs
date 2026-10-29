const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const profile = await fs.mkdtemp('/tmp/jianji-offline-');
  const extension = path.resolve('dist/extension');
  let context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  const errors = [];
  context.on('page', page => page.on('pageerror', e => errors.push(e.message)));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const url = 'chrome-extension://' + new URL(worker.url()).host + '/app.html';
    const page = await context.newPage(); await page.goto(url);
    // Existing v3 installations must remain readable after server sync is removed.
    await page.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('jianji-local', 3);
        request.onupgradeneeded = () => {
          for (const [name, keyPath] of [['notes','id'],['folders','name'],['assets','key'],['imports','key'],['sync','id'],['meta','key']]) request.result.createObjectStore(name, { keyPath });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction('notes', 'readwrite');
          tx.objectStore('notes').put({ id: 'd'.repeat(32), title: '已有本地笔记', content: '保留已有内容', folder: '', updatedAt: new Date().toISOString(), version: 'e'.repeat(32) });
          tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
        };
      });
    });
    await page.locator('#use-local').click();
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#title').inputValue(), '已有本地笔记');
    assert.equal(await page.locator('#sync-now, #toggle-server-sync, #import-to-server').count(), 0);
    await page.evaluate(async () => {
      await api('/api/notes/' + 'd'.repeat(32), { method: 'DELETE', headers: { 'If-Match': '"' + 'e'.repeat(32) + '"' } });
      await init();
    });
    await context.setOffline(true);
    await page.locator('#title').fill('离线笔记');
    await page.locator('.cm-content').fill('断网保存的内容');
    await page.locator('#image-input').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64') });
    await page.locator('#save-note').click(); await page.locator('#save-note[data-state="saved"]').waitFor();
    const noteID = await page.evaluate(() => state.current);
    const boundaries = await page.evaluate(async id => {
      const tooLargeImage = await noteRequest('/api/notes/' + id + '/assets', { method: 'POST', body: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/png' }) });
      const tooLargeNote = await noteRequest('/api/notes/' + id, { method: 'PUT', body: JSON.stringify({ title: 'must not save', content: 'x'.repeat(16 * 1024 * 1024 + 1) }) });
      return { image: tooLargeImage.status, note: tooLargeNote.ok, saved: await api('/api/notes/' + id) };
    }, noteID);
    assert.equal(boundaries.image, 413); assert.equal(boundaries.note, false); assert.equal(boundaries.saved.title, '离线笔记');
    const quota = await page.evaluate(async () => {
      const draft = await api('/api/notes', { method: 'POST', body: JSON.stringify({ title: 'quota fixture', content: '' }) });
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const image = new Blob([png, new Uint8Array(10 * 1024 * 1024 - png.length)], { type: 'image/png' });
      let successful = 0, rejected;
      for (let i = 0; i < 20; i++) {
        const response = await noteRequest('/api/notes/' + draft.id + '/assets', { method: 'POST', body: image });
        if (response.status === 413) { rejected = response.status; break; }
        if (!response.ok) throw new Error('quota fixture failed');
        successful++;
      }
      await api('/api/notes/' + draft.id, { method: 'DELETE', headers: { 'If-Match': '"' + draft.version + '"' } });
      return { successful, rejected, remaining: (await api('/api/notes')).length };
    });
    assert.deepEqual(quota, { successful: 19, rejected: 413, remaining: 1 }, '200 MiB aggregate limit preserves existing notes');


    await page.reload(); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#title').inputValue(), '离线笔记');
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => document.querySelector('#preview-panel img')?.naturalWidth === 1);
    assert.equal(await page.locator('#share-note').isVisible(), false);
    await page.locator('#new-folder').click();
    assert.equal(await page.locator('#folder-protect').isVisible(), false);
    await page.locator('#folder-name').fill('本地目录'); await page.locator('#folder-confirm').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    await page.evaluate(async id => {
      const result = await api('/api/notes/' + id + '/folder', { method: 'PUT', body: JSON.stringify({ folder: '本地目录' }) });
      if (result.folder !== '本地目录') throw new Error('move failed');
    }, noteID);
    await page.reload(); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    await page.evaluate(async () => {
      await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'A' }) });
      await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'B' }) });
      await api('/api/order', { method: 'PUT', body: JSON.stringify({ kind: 'folder', id: '本地目录', before: 'A' }) });
    });
    await page.getByRole('button', { name: '本地目录设置', exact: true }).click();
    await page.locator('#folder-name').fill('重命名目录'); await page.locator('#folder-confirm').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(async () => (await api('/api/folders'))[0].name), '重命名目录');
    await page.locator('#title').fill('重命名后保存'); await page.locator('#save-note').click(); await page.locator('#save-note[data-state="saved"]').waitFor();
    const second = await context.newPage(); await second.goto(url); await second.locator('#loading-panel').waitFor({ state: 'hidden' });
    await page.locator('#title').fill('窗口一'); await page.locator('#save-note').click(); await page.locator('#save-note[data-state="saved"]').waitFor();
    second.on('dialog', dialog => dialog.accept());
    await second.locator(`[data-note-id="${noteID}"]`).click({ button: 'right' });
    await second.locator('#delete-note').click();
    await second.getByText('笔记已在其他窗口修改，当前编辑内容已保留', { exact: true }).waitFor();
    assert.equal(await second.evaluate(() => state.current), noteID, 'stale delete must retain note');
    await second.locator('#title').fill('窗口二'); await second.locator('#save-note').click(); await second.locator('#save-note[data-state="error"]').waitFor();
    assert.equal(await second.locator('#title').inputValue(), '窗口二');
    await second.close({ runBeforeUnload: false });
    await page.locator('#connection-settings').click();
    const downloadPromise = page.waitForEvent('download'); await page.locator('#export-local').click();
    const download = await downloadPromise; const backup = await download.path();
    const data = JSON.parse(await fs.readFile(backup, 'utf8'));
    assert.equal(data.notes.length, 1); assert.equal(data.assets.length, 1); assert.equal(data.folders.length, 3);
    await page.locator('#local-backup-file').setInputFiles(backup);
    await page.getByText('已导入 1 篇本地笔记，原有笔记保持保留。', { exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await api('/api/notes')).length), 2);
    const imported = await page.evaluate(async id => (await api('/api/notes')).find(n => n.id !== id), noteID);
    assert.equal(imported.folder, '重命名目录');
    const restored = await page.evaluate(async id => {
      const note = await api('/api/notes/' + id);
      const name = note.content.match(/assets\/([a-f0-9]{32}\.png)/)[1];
      const response = await noteRequest('/api/notes/' + id + '/assets/' + name);
      return { ok: response.ok, bytes: (await response.blob()).size };
    }, imported.id);
    assert.deepEqual(restored, { ok: true, bytes: 68 });

    const invalid = { ...data, assets: [{ key: data.assets[0].key, data: 'https://invalid.example/track' }] };
    await page.locator('#local-backup-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalid)) });
    await page.getByText('备份附件无效', { exact: true }).waitFor();
    assert.equal(await page.evaluate(async () => (await api('/api/notes')).length), 2, 'invalid import must be atomic');
    await page.locator('#back-to-notes').click();
    await page.screenshot({ path: '/tmp/jianji-offline.png' });
    assert.deepEqual(errors, []);
    await context.close();
    context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
    const restarted = await context.newPage(); await restarted.goto(url);
    await restarted.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await restarted.evaluate(async () => (await api('/api/notes')).length), 2, 'notes survive browser restart');
    console.log('offline extension: persistence, image, folders, revision conflict, backup and atomic import passed');
  } finally { await context.close(); await fs.rm(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
