const { chromium, request } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  const server = process.env.TEST_URL || 'http://127.0.0.1:10782';
  const password = process.env.TEST_PASSWORD || 'test-password';
  const extensionDir = await fs.mkdtemp('/tmp/online-md-extension-test-');
  const profile = await fs.mkdtemp('/tmp/online-md-extension-profile-');
  await fs.cp(path.resolve('dist/extension'), extensionDir, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  // Headless Chromium cannot accept its native runtime permission prompt. Pregrant
  // only the fixture host in a temporary copy; distribution keeps optional grants.
  manifest.host_permissions = [new URL(server).protocol + '//' + new URL(server).hostname + '/*'];
  await fs.writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1200, height: 850 }, args: ['--disable-extensions-except=' + extensionDir, '--load-extension=' + extensionDir] });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionID = new URL(worker.url()).host;
    const controller = await context.newPage();
    await controller.goto(`chrome-extension://${extensionID}/options.html`);
    const created = context.waitForEvent('page');
    await controller.locator('#open-settings').click();
    const page = await created;
    await page.locator('#connection-page').waitFor();
    await page.locator('#server-url').fill(server);
    await page.locator('#test-server').click();
    await page.getByText('连接成功 · 请输入服务器访问密码', { exact: true }).waitFor();
    await page.locator('#server-password').fill('wrong');
    await page.locator('#connect-server').click();
    await page.getByText('密码错误', { exact: true }).waitFor();
    await page.locator('#server-password').fill(password);
    await page.locator('#connect-server').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' });
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    const stamp = Date.now();
    const title = '扩展笔记-' + stamp;
    await page.locator('#new-note').click();
    await page.waitForFunction(() => !loading && !state.current);
    await page.locator('#title').fill(title);
    await page.locator('.cm-content').fill('## 扩展编辑\n\n保留正文\n\n[服务器帮助](/help)');
    await page.locator('#save-note').click();
    await page.locator('#save-note[data-state="saved"]').waitFor();
    const noteID = await page.evaluate(() => state.current);
    const connection = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
    assert.ok(connection.token);
    assert.equal(Object.values(connection).includes(password), false, 'password must not be stored');
    const api = await request.newContext({ baseURL: server, extraHTTPHeaders: { Authorization: 'Bearer ' + connection.token, 'X-Note-Window': await page.evaluate(() => folderSession.windowID) } });
    const saved = await (await api.get('/api/notes/' + noteID)).json();
    assert.equal(saved.title, title);
    await page.locator('#preview-tab').click();
    const linkOpening = context.waitForEvent('page');
    await page.getByRole('link', { name: '服务器帮助' }).click();
    const linkedPage = await linkOpening;
    await linkedPage.waitForURL(server + '/help');
    await linkedPage.close();
    assert.match(page.url(), /app\.html$/);
    await page.locator('#edit-tab').click();
    // Paste image, save and load it through authenticated Blob fetch in the real extension.
    await page.locator('.cm-content').evaluate(el => {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII='), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([png], 'test.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.locator('#save-note').click();
    await page.locator('#save-note[data-state="saved"]').waitFor();
    await page.locator('#preview-tab').click();
    await page.waitForFunction(() => document.querySelector('#preview-panel img')?.src.startsWith('blob:') && document.querySelector('#preview-panel img').naturalWidth === 1);
    assert.match(await page.locator('#preview-panel img').getAttribute('src'), /^blob:chrome-extension:/);
    // A failed save leaves the current draft available for retry.
    await page.locator('#edit-tab').click();
    await page.locator('#title').fill(title + ' 网络恢复后保存');
    await page.route(server + '/api/notes/' + noteID, route => route.request().method() === 'PUT' ? route.abort() : route.continue());
    await page.locator('#save-note').click();
    await page.locator('#save-note[data-state="error"]').waitFor();
    assert.equal(await page.locator('#title').inputValue(), title + ' 网络恢复后保存');
    await page.unroute(server + '/api/notes/' + noteID);
    await page.locator('#save-note').click();
    await page.locator('#save-note[data-state="saved"]').waitFor();
    // Mermaid's lazy loader and bundled scripts also have to work under MV3 CSP.
    await page.locator('#edit-tab').click();
    await page.locator('.cm-content').fill('```mermaid\nflowchart LR\n A[开始] --> B[完成]\n```');
    await page.locator('#preview-tab').click();
    await page.locator('.diagram-canvas svg').waitFor();
    await page.locator('#save-note').click();
    await page.locator('#save-note[data-state="saved"]').waitFor();
    const folder = '私人空间-' + stamp;
    await page.locator('#new-folder').click();
    await page.locator('#folder-name').fill(folder);
    await page.locator('#folder-protect').check();
    await page.locator('#folder-password').fill(' 任意密码 ');
    await page.locator('#folder-confirm').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('button', { name: '移动', exact: true }).count(), 0);
    await page.locator(`[data-note-id="${noteID}"]`).dragTo(page.locator('.folder-group').filter({ has: page.getByText(folder, { exact: true }) }).locator('.folder-row'));
    await page.locator('#folder-password').fill(' 任意密码 ');
    await page.locator('#folder-confirm').click();
    await page.waitForFunction(f => !folderState.busy && state.folder === f, folder);
    const group = page.locator('.folder-group').filter({ has: page.getByText(folder, { exact: true }) });
    await group.getByRole('button', { name: folder + '设置', exact: true }).click();
    await page.locator('#folder-lock').click();
    await page.waitForFunction(() => !folderState.busy);
    assert.equal((await api.get('/api/notes/' + noteID)).status(), 403);
    await group.getByRole('button', { name: '解锁文件夹 ' + folder, exact: true }).click();
    await page.locator('#folder-password').fill(' 任意密码 ');
    await page.locator('#folder-confirm').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    await group.locator(`[data-note-id="${noteID}"]`).click();
    await page.waitForFunction(id => state.current === id, noteID);
    // Reopening must focus this same window and keep unsaved content.
    await page.locator('#title').fill('还没有保存的标题');
    const originalPageCount = context.pages().length;
    await controller.evaluate(() => chrome.runtime.sendMessage({ type: 'open-notes' }));
    assert.equal(context.pages().length, originalPageCount);
    assert.equal(await page.locator('#title').inputValue(), '还没有保存的标题');
    await page.locator('#connection-settings').click();
    await page.locator('#server-password').fill(password);
    await page.locator('#connect-server').click();
    await page.locator('#connection-page').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#folder-locked-panel').isVisible(), true);
    await page.locator('#unlock-active-folder').click();
    await page.locator('#folder-password').fill(' 任意密码 ');
    await page.locator('#folder-confirm').click();
    await page.locator('#folder-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#title').inputValue(), '还没有保存的标题');
    assert.equal((await api.get('/api/notes')).status(), 401, 'reconnect must revoke the old client session');
    // Reconnecting creates a new session, which must not inherit a folder grant.
    const reconnected = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
    const fresh = await request.newContext({ baseURL: server, extraHTTPHeaders: { Authorization: 'Bearer ' + reconnected.token, 'X-Note-Window': await page.evaluate(() => folderSession.windowID) } });
    assert.equal((await fresh.get('/api/notes/' + noteID, { headers: { 'X-Note-Window': 'c'.repeat(32) } })).status(), 403);
    await fresh.post('/api/folders/' + encodeURIComponent(folder) + '/unlock', { data: { password: ' 任意密码 ' } });
    // Conflict handling preserves local text rather than overwriting another editor.
    const remote = await (await fresh.get('/api/notes/' + noteID)).json();
    assert.equal((await fresh.put('/api/notes/' + noteID, { data: { title: '服务器新标题', content: remote.content }, headers: { 'If-Match': '"' + remote.version + '"' } })).status(), 200);
    await page.locator('#save-note').click();
    await page.getByRole('heading', { name: '这篇笔记已在其他窗口修改' }).waitFor();
    assert.equal(await page.locator('#title').inputValue(), '还没有保存的标题');
    await page.getByRole('button', { name: '放弃本地并重新加载' }).click();
    await page.waitForFunction(() => !loading && document.querySelector('#title').value === '服务器新标题');
    // Hash navigation inside notes must not make an existing window invisible to the worker.
    await page.evaluate(() => { location.hash = 'note-section'; });
    // Background termination must not lose the single-window identity.
    const devtools = await context.newCDPSession(controller);
    await devtools.send('ServiceWorker.enable');
    await devtools.send('ServiceWorker.stopAllWorkers');
    await controller.evaluate(() => chrome.runtime.sendMessage({ type: 'open-notes' }));
    assert.equal(context.pages().length, originalPageCount);
    await devtools.detach();
    // Switching server must ask about unsaved edits, revoke old credentials,
    // and leave the previous server's content out of the new session.
    if (process.env.SECOND_TEST_URL) {
      await page.locator('#title').fill('切换前未保存');
      await page.locator('#connection-settings').click();
      await page.locator('#server-url').fill(process.env.SECOND_TEST_URL);
      await page.locator('#server-password').fill(password);
      await page.locator('#connect-server').click();
      await page.locator('#unsaved-dialog[open]').waitFor();
      await page.locator('#cancel-navigation').click();
      await page.waitForFunction(() => !document.querySelector('#connect-server').disabled);
      assert.equal(await page.locator('#title').inputValue(), '切换前未保存');
      await page.locator('#connect-server').click();
      await page.locator('#unsaved-dialog[open]').waitFor();
      await page.locator('#discard-changes').click();
      await page.locator('#connection-page').waitFor({ state: 'hidden' });
      await page.locator('#loading-panel').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#title').inputValue(), '');
      assert.equal((await fresh.get('/api/notes')).status(), 401);
      assert.equal(await page.locator('.note-item').count(), 0);
    }
    if (process.env.SECOND_TEST_URL) {
      // Old server unavailable: changing the connection must still be possible.
      const oldConnection = await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection);
      await page.route(oldConnection.baseURL + '/api/client/session', route => route.request().method() === 'DELETE' ? route.abort() : route.continue());
      await page.locator('#connection-settings').click();
      await page.locator('#server-url').fill(server);
      await page.locator('#server-password').fill(password);
      await page.locator('#connect-server').click();
      await page.locator('#connection-page').waitFor({ state: 'hidden' });
      await page.locator('#loading-panel').waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection.baseURL), server);
      await page.getByText('旧服务器无法连接，未能远程撤销旧登录；本地凭证已移除，旧会话将在到期后失效。', { exact: true }).waitFor();
      // Logout must also work locally when remote revocation cannot reach the server.
      await page.route(server + '/api/client/session', route => route.request().method() === 'DELETE' ? route.abort() : route.continue());
    }
    // Local/server workspaces stay separate, and a cancelled switch keeps the draft.
    await page.locator('#connection-settings').click(); await page.locator('#use-local').click();
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.note-item').count(), 0);
    await page.locator('#edit-tab').click();
    await page.locator('#title').fill('仅此浏览器'); await page.locator('.cm-content').fill('不应自动上传');
    await page.locator('#save-note').click(); await page.locator('#save-note[data-state="saved"]').waitFor();
    const localID = await page.evaluate(() => state.current);
    await page.locator('#title').fill('切换前的本地草稿');
    await page.locator('#connection-settings').click(); await page.locator('#server-password').fill(password);
    await page.locator('#connect-server').click(); await page.locator('#unsaved-dialog[open]').waitFor();
    await page.locator('#cancel-navigation').click();
    await page.waitForFunction(() => !document.querySelector('#connect-server').disabled);
    assert.equal(await page.locator('#title').inputValue(), '切换前的本地草稿');
    await page.locator('#connect-server').click(); await page.locator('#unsaved-dialog[open]').waitFor();
    await page.locator('#discard-changes').click(); await page.locator('#connection-page').waitFor({ state: 'hidden' });
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(async id => (await api('/api/notes')).some(n => n.id === id), localID), false);
    assert.equal(await page.locator('#share-note').isVisible(), true);
    await page.locator('#connection-settings').click(); await page.locator('#use-local').click();
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#title').inputValue(), '仅此浏览器');
    await page.locator('#connection-settings').click(); await page.locator('#server-password').fill(password);
    await page.locator('#connect-server').click(); await page.locator('#connection-page').waitFor({ state: 'hidden' });
    await page.locator('#loading-panel').waitFor({ state: 'hidden' });
    await page.locator('#connection-settings').click();
    await page.locator('#disconnect-server').click();
    await page.locator('#disconnect-server').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(async () => (await chrome.storage.local.get('connection')).connection), undefined);
    assert.equal((await fresh.get('/api/notes')).status(), 401);
    assert.equal(await page.locator('#connection-page').isVisible(), true);
    assert.equal(await page.evaluate(() => state.saved.content), '');
    assert.equal(await page.evaluate(() => state.notes.length), 0);
    const reopening = context.waitForEvent('page');
    await page.close();
    await controller.evaluate(() => Promise.all([chrome.runtime.sendMessage({ type: 'open-notes' }), chrome.runtime.sendMessage({ type: 'open-notes' })]));
    const reopened = await reopening;
    await reopened.locator('#connection-page').waitFor();
    assert.equal(context.pages().length, originalPageCount);
    assert.deepEqual(errors, []);
    await fresh.dispose(); await api.dispose();
    console.log('PASS: real MV3 settings/login, local UI/save, authenticated images, Mermaid/CSP, folders/lock, window reuse/worker recovery, reconnect, conflicts, server switching and offline logout');
  } catch (error) {
    for (const p of context.pages()) console.error('Extension diagnostic:', p.url(), await p.evaluate(() => ({ hidden: document.querySelector('#connection-page')?.hidden, message: document.querySelector('#loading-message')?.textContent, host: Boolean(window.noteHost), text: document.body.innerText.slice(0, 150) })).catch(() => 'closed'));
    console.error('Page errors:', errors);
    throw error;
  } finally { await context.close(); await fs.rm(profile, { recursive: true, force: true }); await fs.rm(extensionDir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
