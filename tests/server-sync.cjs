const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const server = process.env.TEST_URL;
  const work = await fs.mkdtemp('/tmp/jianji-sync-');
  const extension = path.join(work, 'extension'); await fs.cp(path.resolve('dist/extension'), extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8')); manifest.host_permissions = ['http://127.0.0.1/*'];
  await fs.writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const profile = path.join(work, 'profile');
  const launch = () => chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 900 }, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension] });
  let context = await launch(); const errors = [];
  const watch = () => context.on('page', page => page.on('pageerror', e => errors.push(e.message))); watch();
  let page, base, session; const trace = [];
  context.on('response', response => { if (response.url().includes('/api/sync')) trace.push([response.status(), response.url()]); });
  const headers = () => ({ Authorization: 'Bearer ' + session.token });
  const remote = async (url, options = {}) => {
    const response = await fetch(server + url, { ...options, headers: { ...headers(), ...(options.headers || {}) } });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(JSON.stringify({ url, status: response.status, body }));
    return body;
  };
  const updateRemote = async (id, title, content) => {
    const note = await remote('/api/notes/' + id);
    return remote('/api/notes/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"' + note.version + '"' }, body: JSON.stringify({ title, content }) });
  };
  const sync = async () => {
    if (!await page.locator('#connection-page').isVisible()) await page.locator('#connection-settings').click();
    await page.locator('#sync-now').click();
    await page.waitForFunction(() => !document.querySelector('#sync-now').disabled && document.querySelector('#sync-status').textContent.includes('已连接') && !document.querySelector('#sync-status').textContent.includes('项待同步'));
  };
  const cached = (url, method, value) => page.evaluate(async ({ url, method, value }) => api(url, method ? { method, ...(value === undefined ? {} : { body: JSON.stringify(value) }) } : {}), { url, method, value });
  const open = async () => {
    page = await context.newPage(); await page.goto(base + '/app.html'); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
  };
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker'); base = 'chrome-extension://' + new URL(worker.url()).host;
    page = await context.newPage(); await page.goto(base + '/app.html');
    await page.locator('#server-url').fill(server); await page.locator('#server-password').fill(process.env.TEST_PASSWORD); await page.locator('#connect-server').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' }); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    session = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
    const note = await remote('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '服务器原件', content: 'initial' }) });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=', 'base64');
    const asset = await remote('/api/notes/' + note.id + '/assets', { method: 'POST', body: png });
    await updateRemote(note.id, note.title, 'initial\n![原图](' + asset.path + ')');
    const deletion = await remote('/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '删除冲突测试', content: 'keep' }) });
    const privateID = 'f'.repeat(32), privateDir = path.join(process.env.TEST_DATA_DIR, 'private', 'secret');
    await fs.mkdir(privateDir, { recursive: true }); await fs.writeFile(path.dirname(privateDir) + '/.pwd', 'password');
    await fs.writeFile(privateDir + '/meta.json', JSON.stringify({ id: privateID, title: '不得缓存的秘密', updatedAt: new Date().toISOString() })); await fs.writeFile(privateDir + '/note.md', 'secret must never be cached');
    await page.locator('#connection-settings').click(); await page.locator('#toggle-server-sync').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' }); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.noteHost.syncEnabled), true);
    assert.equal((await cached('/api/notes')).length, 2);
    assert.equal(await page.evaluate(async id => (await noteRequest('/api/notes/' + id)).status, privateID), 404);
    await context.setOffline(true);
    await page.evaluate(async id => { await loadNote(id); }, note.id);
    await page.locator('#edit-tab').click(); await page.locator('#title').fill('离线修改');
    await page.locator('#image-input').setInputFiles({ name: 'new.png', mimeType: 'image/png', buffer: png });
    await page.locator('#save-note').click(); await page.locator('#save-note[data-state="saved"]').waitFor();
    await page.locator('#new-note').click(); await page.locator('#title').fill('离线新建'); await page.locator('.cm-content').fill('offline new content');
    await page.locator('#save-note').click(); await page.locator('#save-note[data-state="saved"]').waitFor();
    const newID = await page.evaluate(() => state.current);
    await cached('/api/folders', 'POST', { name: '离线目录' });
    await cached('/api/notes/' + newID + '/folder', 'PUT', { folder: '离线目录' });
    await cached('/api/folders/' + encodeURIComponent('离线目录'), 'PUT', { name: '离线重命名' });
    await cached('/api/notes/' + deletion.id, 'DELETE');
    await context.close(); context = await launch(); watch(); await context.setOffline(true); await open();
    assert.equal((await cached('/api/notes/' + newID)).folder, '离线重命名');
    await updateRemote(note.id, '服务器并发修改', 'remote version\n![原图](' + asset.path + ')');
    await updateRemote(deletion.id, '保留服务器新修改', 'remote deletion conflict');
    await context.setOffline(false); await sync();
    let notes = await remote('/api/notes');
    const conflict = notes.find(n => n.title.includes('冲突副本'));
    assert.ok(conflict, 'both edits produce one conflict copy');
    assert.equal((await remote('/api/notes/' + note.id)).title, '服务器并发修改');
    const copied = await remote('/api/notes/' + conflict.id); assert.ok(copied.content.includes(asset.path));
    assert.equal((copied.content.match(/!\[/g) || []).length, 2, 'new and old image references survive conflict');
    assert.equal((await remote('/api/notes/' + newID)).folder, '离线重命名');
    assert.equal((await cached('/api/notes/' + deletion.id)).title, '保留服务器新修改');
    // Concurrent order changes keep the server order while preserving new local folders.
    await context.setOffline(true);
    await cached('/api/folders', 'POST', { name: 'A' }); await cached('/api/folders', 'POST', { name: 'B' });
    await cached('/api/order', 'PUT', { kind: 'note', id: conflict.id, before: note.id, folder: '' });
    await remote('/api/order', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'note', id: note.id, before: conflict.id, folder: '' }) });
    await context.setOffline(false); await sync();
    let inventory = await remote('/api/sync');
    assert.ok(inventory.structure.folders.includes('A') && inventory.structure.folders.includes('B'));
    assert.equal(inventory.structure.order.notes[''][0], note.id, 'concurrent server order wins without losing folders');
    await context.setOffline(true);
    await cached('/api/order', 'PUT', { kind: 'folder', id: 'B', before: 'A' });
    await cached('/api/order', 'PUT', { kind: 'note', id: conflict.id, before: note.id, folder: '' });
    await context.setOffline(false); await sync(); inventory = await remote('/api/sync');
    assert.ok(inventory.structure.order.folders.indexOf('B') < inventory.structure.order.folders.indexOf('A'));
    assert.equal(inventory.structure.order.notes[''][0], conflict.id, 'single-sided offline order is uploaded');
    // Clean remote edits and new notes are downloaded, clean deletions propagate.
    await updateRemote(newID, '远端更新', 'remote new version'); await sync();
    assert.equal((await cached('/api/notes/' + newID)).content, 'remote new version');
    // A delayed editor refresh must not overwrite typing started during sync.
    await page.locator('#back-to-notes').click();
    await page.evaluate(async id => { await loadNote(id); document.activeElement.blur(); }, newID);
    await updateRemote(newID, '刷新竞态', 'remote refresh race');
    await page.evaluate(id => {
      const original = noteHost.request;
      window.refreshGateReached = false;
      noteHost.request = async (...args) => {
        const result = await original(...args);
        if (args[0] === '/api/notes/' + id) {
          window.refreshGateReached = true;
          await new Promise(resolve => { window.releaseRefreshGate = resolve; });
          noteHost.request = original;
        }
        return result;
      };
    }, newID);
    await page.locator('#connection-settings').click(); await page.locator('#sync-now').click();
    await page.waitForFunction(() => window.refreshGateReached);
    await page.locator('#back-to-notes').click(); await page.locator('#title').fill('输入不能被覆盖');
    await page.evaluate(() => window.releaseRefreshGate());
    await page.waitForFunction(() => !document.querySelector('#sync-now').disabled);
    assert.equal(await page.locator('#title').inputValue(), '输入不能被覆盖');
    assert.equal(await page.evaluate(() => state.dirty), true);
    // Explicitly discard this test draft before continuing the queue scenarios.
    await page.evaluate(async () => { await loadNote(state.current); document.activeElement.blur(); });
    await page.locator('#connection-settings').click();
    // A successful mutation with a lost response must keep its immutable job.
    await context.setOffline(true); await cached('/api/notes/' + newID, 'PUT', { title: '第一次离线', content: 'first local revision' });
    await context.setOffline(false);
    let lost = false;
    await page.route(server + '/api/sync/notes/' + newID, async route => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch(); assert.equal(response.status(), 200); lost = true; await route.abort();
    });
    await page.locator('#sync-now').click();
    await page.waitForFunction(() => !document.querySelector('#sync-now').disabled && document.querySelector('#sync-status').textContent.includes('项待同步'));
    assert.equal(lost, true);
    await context.setOffline(true); await cached('/api/notes/' + newID, 'PUT', { title: '第二次离线', content: 'latest local revision' });
    await updateRemote(newID, '上传后远端修改', 'later remote edit');
    await context.close(); context = await launch(); watch(); await context.setOffline(true); await open();
    await context.setOffline(false); await sync();
    notes = await remote('/api/notes');
    assert.equal((await remote('/api/notes/' + newID)).content, 'later remote edit');
    const latest = notes.find(n => n.title.startsWith('第二次离线') && n.title.includes('冲突副本')); assert.ok(latest);
    assert.equal((await remote('/api/notes/' + latest.id)).content, 'latest local revision');
    assert.equal(notes.filter(n => n.title.startsWith('第二次离线')).length, 1, 'stable recovery prevents duplicate conflict copies');
    await sync(); assert.equal((await remote('/api/notes')).length, notes.length);
    // Remote delete versus an offline edit produces a new ID, never resurrection.
    await context.setOffline(true); await cached('/api/notes/' + deletion.id, 'PUT', { title: '删除后的本地修改', content: 'recover deleted edit' });
    await remote('/api/notes/' + deletion.id, { method: 'DELETE' });
    await context.setOffline(false); await sync();
    assert.equal((await remote('/api/notes')).some(n => n.id === deletion.id), false);
    const rescued = (await remote('/api/notes')).find(n => n.title.startsWith('删除后的本地修改')); assert.ok(rescued);
    assert.equal((await remote('/api/notes/' + rescued.id)).content, 'recover deleted edit');
    // Local delete without remote modifications is propagated and stays deleted.
    await cached('/api/notes/' + rescued.id, 'DELETE'); await sync();
    assert.equal((await remote('/api/notes')).some(n => n.id === rescued.id), false);
    await remote('/api/notes/' + latest.id, { method: 'DELETE' }); await sync();
    assert.equal((await cached('/api/notes')).some(n => n.id === latest.id), false);
    // A changed server identity pauses the queue before any note upload.
    await context.setOffline(true); await cached('/api/notes/' + newID, 'PUT', { title: '身份检查', content: 'pending identity check' });
    const identityPath = path.join(process.env.TEST_DATA_DIR, '.server-id'); const identity = await fs.readFile(identityPath, 'utf8');
    await fs.writeFile(identityPath, '0'.repeat(32)); await context.setOffline(false);
    await page.locator('#sync-now').click();
    await page.waitForFunction(() => !document.querySelector('#sync-now').disabled && document.querySelector('#sync-status').textContent.includes('目标服务器身份已变化'));
    assert.equal((await remote('/api/notes/' + newID)).content, 'later remote edit');
    assert.equal((await cached('/api/notes/' + newID)).content, 'pending identity check');
    await fs.writeFile(identityPath, identity); await sync();
    assert.equal((await remote('/api/notes/' + newID)).content, 'pending identity check');
    // Changing URL never sends the previous server's queued changes to the new one.
    await context.setOffline(true); await cached('/api/notes/' + newID, 'PUT', { title: '隔离检查', content: 'only the first server' });
    await page.route(server + '/api/sync**', route => route.abort()); await context.setOffline(false);
    await page.locator('#server-url').fill(process.env.SECOND_TEST_URL); await page.locator('#server-password').fill(process.env.TEST_PASSWORD); await page.locator('#connect-server').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' }); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.noteHost.syncEnabled), false);
    assert.equal((await cached('/api/notes')).length, 0);
    await page.locator('#connection-settings').click(); await page.locator('#toggle-server-sync').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' }); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal((await cached('/api/notes')).length, 0, 'distinct server has independent cache');
    await cached('/api/notes', 'POST', { title: '仅第二台', content: 'only the second server' }); await sync();
    const secondSession = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
    const secondNotes = await (await fetch(process.env.SECOND_TEST_URL + '/api/notes', { headers: { Authorization: 'Bearer ' + secondSession.token } })).json();
    assert.equal(secondNotes.length, 1); assert.equal(secondNotes[0].title, '仅第二台');
    await page.locator('#server-url').fill(server); await page.locator('#server-password').fill(process.env.TEST_PASSWORD); await page.locator('#connect-server').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' }); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    session = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
    assert.equal((await cached('/api/notes/' + newID)).content, 'only the first server');
    await page.unroute(server + '/api/sync**'); await sync();
    assert.equal((await remote('/api/notes/' + newID)).content, 'only the first server');
    assert.equal((await remote('/api/notes')).some(n => n.title === '仅第二台'), false);
    // A formerly ordinary note can become protected. Rescue old pending edits
    // into independent local notes, without fetching new protected contents.
    await context.setOffline(true); await cached('/api/notes/' + note.id, 'PUT', { title: '需要本地恢复', content: 'old offline edit, no secret' });
    const entries = await fs.readdir(process.env.TEST_DATA_DIR, { withFileTypes: true }); let originalDir;
    for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('.'))) {
      try { const meta = JSON.parse(await fs.readFile(path.join(process.env.TEST_DATA_DIR, entry.name, 'meta.json'))); if (meta.id === note.id) originalDir = entry.name; } catch {}
    }
    assert.ok(originalDir); await fs.rename(path.join(process.env.TEST_DATA_DIR, originalDir), path.join(process.env.TEST_DATA_DIR, 'private', originalDir));
    await fs.writeFile(path.join(process.env.TEST_DATA_DIR, 'private', originalDir, 'note.md'), 'new secret must not be cached');
    await context.setOffline(false); await sync();
    assert.equal((await cached('/api/notes')).some(n => n.id === note.id), false);
    await page.locator('#use-local').click(); await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    const recovery = (await cached('/api/notes')).find(n => n.title.startsWith('需要本地恢复')); assert.ok(recovery);
    const recovered = await cached('/api/notes/' + recovery.id); assert.equal(recovered.content, 'old offline edit, no secret');
    assert.equal(recovered.content.includes('new secret'), false);
    assert.deepEqual(errors, []);
    console.log('PASS: scoped cache, offline save/images/create/folder rename/restart, modification/deletion conflicts, lost response + newer local edits, clean downloads/deletes, protected-note exclusion and local recovery');
  } catch (error) {
    console.error('Sync trace', trace, 'Errors', errors);
    if (page && !page.isClosed()) console.error(await page.evaluate(() => ({ enabled: window.noteHost?.syncEnabled, saving: state.saving, dirty: state.dirty, loading, disabled: document.querySelector('#toggle-server-sync')?.disabled, status: document.querySelector('#sync-status')?.textContent, error: document.querySelector('#connection-error')?.textContent, text: document.body.innerText.slice(-500) })).catch(() => ({})));
    throw error;
  } finally { await context.close(); await fs.rm(work, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
