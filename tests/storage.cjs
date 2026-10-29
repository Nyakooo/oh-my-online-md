const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const work = await fs.mkdtemp('/tmp/jianji-storage-');
  const extension = path.join(work, 'extension'); await fs.cp(path.resolve('dist/extension'), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const launch = () => chromium.launchPersistentContext(path.join(work, 'profile'), { channel: 'chromium', headless: true, viewport: { width: 1200, height: 950 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  let context = await launch(), page, base; const errors = []; let queries = 0;
  const watch = () => context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.url().endsWith('/api/storage')) queries++; });
  }); watch();
  const api = (url, method, value) => page.evaluate(({ url, method, value }) => window.api(url, method ? { method, body: JSON.stringify(value) } : {}), { url, method, value });
  const upload = (id, bytes = 600 * 1024) => page.evaluate(async ({ id, bytes }) => {
    const response = await noteRequest('/api/notes/' + id + '/assets', { method: 'POST', body: new Blob([new Uint8Array(bytes)], { type: 'image/png' }) });
    return { status: response.status, data: await response.json() };
  }, { id, bytes });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); base = 'chrome-extension://' + new URL(worker.url()).host;
    page = await context.newPage(); await page.goto(base + '/app.html');
    await page.locator('#server-url').fill(process.env.TEST_URL); await page.locator('#server-password').fill(process.env.TEST_PASSWORD); await page.locator('#connect-server').click();
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    await page.locator('#connection-settings').click();
    assert.equal(await page.locator('#storage-panel').isHidden(), true);
    assert.equal(await page.locator('#storage-usage').isHidden(), true);
    for (let i = 0; i < 3; i++) await api('/api/notes', 'POST', { title: 'online fixture ' + i, content: 'x'.repeat(10000) });
    assert.equal(queries, 0, 'online mode never requests server storage statistics');
    await page.locator('#use-local').click(); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    await context.setOffline(true);
    await page.waitForFunction(() => document.querySelector('#storage-usage').textContent.includes('/ 200.0 MiB'));
    assert.equal((await api('/api/notes')).length, 0, 'server notes stay separate from local quota');
    await page.locator('#connection-settings').click();
    await page.locator('#local-limit').fill('1'); await page.locator('#save-local-limit').click();
    await page.getByText('离线空间上限已保存。', { exact: true }).waitFor();
    assert.equal((await api('/api/storage')).limitBytes, 1024 * 1024);
    const note = await api('/api/notes', 'POST', { title: '额度测试', content: '中文正文' });
    assert.equal((await upload(note.id)).status, 201);
    const before = await api('/api/storage');
    assert.equal((await upload(note.id)).status, 413);
    assert.equal((await api('/api/storage')).usedBytes, before.usedBytes, 'rejected upload leaves usage unchanged');
    await page.locator('#local-limit').fill('2'); await page.locator('#save-local-limit').click();
    await page.waitForFunction(() => document.querySelector('#storage-summary').textContent.includes('/ 2.0 MiB'));
    assert.equal((await upload(note.id)).status, 201); assert.equal((await upload(note.id)).status, 201);
    await page.waitForFunction(() => document.querySelector('#storage-summary').dataset.warning === 'true');
    assert.ok((await page.locator('#storage-summary').textContent()).includes('80%'));
    assert.equal((await upload(note.id, 240 * 1024)).status, 201);
    await page.waitForFunction(() => document.querySelector('#storage-summary').textContent.includes('即将用满'));
    await page.locator('#local-limit').fill('1'); await page.locator('#save-local-limit').click();
    await page.getByText('上限不能低于当前已用空间，请先清理数据', { exact: true }).waitFor();
    assert.equal((await api('/api/storage')).limitBytes, 2 * 1024 * 1024);
    for (const limitMiB of [0, -1, 1.5, null, 1e20]) {
      assert.equal(await page.evaluate(async limitMiB => (await noteRequest('/api/storage', { method: 'PUT', body: JSON.stringify({ limitMiB }) })).status, limitMiB), 400);
    }
    await api('/api/storage');
    const scans = await page.evaluate(async () => {
      const original = IDBObjectStore.prototype.getAll; let calls = 0;
      IDBObjectStore.prototype.getAll = function (...args) { calls++; return original.apply(this, args); };
      try { for (let i = 0; i < 5; i++) await api('/api/storage'); return calls; }
      finally { IDBObjectStore.prototype.getAll = original; }
    });
    assert.equal(scans, 0, 'unchanged offline usage reads only the cached aggregate');
    const saved = await api('/api/storage');
    await context.close(); context = await launch(); watch(); await context.setOffline(true);
    page = await context.newPage(); await page.goto(base + '/app.html'); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.deepEqual(await api('/api/storage'), saved, 'quota and usage persist across browser restarts');
    await api('/api/notes/' + note.id, 'DELETE');
    assert.ok((await api('/api/storage')).usedBytes < 1024, 'deletion frees note and image storage');
    await page.waitForFunction(() => document.querySelector('#storage-usage').dataset.warning === 'false');
    // The configured cap also applies to text edits and atomic backup restore.
    await api('/api/storage', 'PUT', { limitMiB: 1 });
    const textNote = await api('/api/notes', 'POST', { title: '正文额度', content: 'keep' });
    const rejectedText = await page.evaluate(async id => (await noteRequest('/api/notes/' + id, { method: 'PUT', body: JSON.stringify({ title: 'must not replace', content: '文'.repeat(400000) }) })).status, textNote.id);
    assert.equal(rejectedText, 413); assert.equal((await api('/api/notes/' + textNote.id)).content, 'keep');
    const nearFull = await api('/api/storage');
    await api('/api/notes/' + textNote.id, 'PUT', { title: '正文额度', content: 'x'.repeat(1024 * 1024 - nearFull.usedBytes + 4 - 10) });
    await api('/api/folders', 'POST', { name: 'a' });
    await api('/api/notes/' + textNote.id + '/folder', 'PUT', { folder: 'a' });
    assert.equal(await page.evaluate(async () => (await noteRequest('/api/folders/a', { method: 'PUT', body: JSON.stringify({ name: 'b'.repeat(30) }) })).status), 413);
    assert.equal((await api('/api/notes/' + textNote.id)).folder, 'a', 'failed folder rename is atomic at the quota boundary');
    await api('/api/notes/' + textNote.id, 'PUT', { title: '正文额度', content: 'keep' });
    await api('/api/notes/' + textNote.id + '/folder', 'PUT', { folder: '' });
    await api('/api/storage', 'PUT', { limitMiB: 2 });
    await api('/api/notes/' + textNote.id, 'PUT', { title: '正文额度', content: '文'.repeat(400000) });
    const restore = await page.evaluate(async () => {
      const source = (await api('/api/notes'))[0];
      const data = { format: 'jianji-local', version: 1, notes: [{ ...source, content: '文'.repeat(400000) }], folders: [], assets: [] };
      const backup = new File([JSON.stringify(data)], 'quota.json', { type: 'application/json' });
      return data;
    });
    await page.locator('#connection-settings').click();
    await page.locator('#local-backup-file').setInputFiles({ name: 'quota.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(restore)) });
    await page.getByText('导入后超过本地 2 MiB 上限', { exact: true }).waitFor();
    assert.equal((await api('/api/notes')).length, 1, 'failed restore leaves existing notes intact');
    await api('/api/storage', 'PUT', { limitMiB: 3 });
    await page.locator('#local-backup-file').setInputFiles({ name: 'quota.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(restore)) });
    await page.getByText('已导入 1 篇本地笔记，原有笔记保持保留。', { exact: true }).waitFor();
    assert.equal((await api('/api/notes')).length, 2);
    assert.ok((await api('/api/storage')).usedBytes > 2 * 1024 * 1024, 'import invalidates the cached usage');
    // A second window observes quota changes through the same IDB transaction scope.
    const other = await context.newPage(); await other.goto(base + '/app.html'); await other.locator('#loading-panel').waitFor({ state: 'hidden' });
    await other.evaluate(() => api('/api/storage', { method: 'PUT', body: JSON.stringify({ limitMiB: 4 }) }));
    assert.equal((await api('/api/storage')).limitBytes, 4 * 1024 * 1024); await other.close();
        await page.setViewportSize({ width: 360, height: 700 });
    const card = await page.locator('.connection-card').boundingBox();
    assert.ok(card.x >= 0 && card.y >= 0 && card.x + card.width <= 360, 'settings remain reachable on a narrow screen');
    assert.equal(queries, 0, 'offline stats and quota changes make no storage network requests');
    assert.deepEqual(errors, []);
    console.log('PASS: no online storage queries, offline usage and configurable quota, rejection safety, warnings, restart persistence, cache hits and deletion');
  } finally { await context.close(); await fs.rm(work, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
