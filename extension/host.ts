import { localRequest, exportLocal, importLocal } from './local-store';
interface Connection { baseURL: string; token: string; expiresAt: string }
declare const state: { current: string | null; folder: string; dirty: boolean; saving: boolean; version: string; saved: { title: string; content: string }; notes: unknown[] };
declare const loading: boolean;
declare function allowLeave(): Promise<boolean>;
declare function init(): Promise<void>;
declare function refreshNotes(): Promise<void>;
declare function setLoading(value: boolean): void;
declare function clearPendingImages(): void;
declare function markDirty(): void;
declare function clearNoteAssets(): void;
declare function resetFolderSession(): void;
declare function noteAssetPath(path: string, noteID?: string | null): string | null;
declare const folderState: { items: unknown[]; expanded: Set<string> };
declare function showNotice(message: string): void;
declare const contentEditor: { getValue(): string; setValue(value: string, reset?: boolean): void };
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
let connection: Connection | undefined;
let configured = false;
let localMode = false;
let modeLoaded = false;
let formBusy = false;
let storageTimer: ReturnType<typeof setTimeout>;
let storageEpoch = 0;
const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
function scheduleStorageRefresh() {
  clearTimeout(storageTimer);
  if (localMode) storageTimer = setTimeout(() => { void updateStorage(); }, 600);
}
async function updateStorage() {
  const epoch = ++storageEpoch;
  $('#storage-panel').hidden = !localMode;
  $('#storage-usage').hidden = !localMode;
  if (!localMode) { $('#storage-usage').textContent = ''; return; }
  $('#storage-summary').textContent = '正在统计空间…';
  try {
    // Always read the isolated local library; this never makes a network request.
    const response = await localRequest('/api/storage');
    const value = await jsonResponse(response);
    if (epoch !== storageEpoch || !localMode) return;
    const used = Number(value.usedBytes), limit = Number(value.limitBytes);
    if (!Number.isSafeInteger(used) || used < 0 || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('空间统计数据无效');
    const ratio = used / limit;
    const text = `离线已用 ${formatBytes(used)} / ${formatBytes(limit)}`;
    $('#storage-summary').textContent = text + (ratio >= 0.95 ? ' · 空间即将用满，请备份并清理或提高上限' : ratio >= 0.8 ? ' · 空间使用已超过 80%' : '');
    $('#storage-usage').textContent = text;
    for (const selector of ['#storage-summary', '#storage-usage']) $(selector).dataset.warning = String(ratio >= 0.8);
    $<HTMLProgressElement>('#storage-progress').value = Math.min(ratio, 1);
    if (document.activeElement !== $('#local-limit')) $<HTMLInputElement>('#local-limit').value = String(limit / 1024 / 1024);
  } catch (error) {
    if (epoch !== storageEpoch || !localMode) return;
    $('#storage-summary').textContent = error instanceof Error ? error.message : '暂时无法读取已用空间';
    $('#storage-usage').textContent = '空间用量暂不可用';
  }
}
const responseOwners = new WeakMap<Response, Connection | undefined>();
function normalizeServer(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请输入 HTTP / HTTPS 服务器地址，不含账号、查询参数或片段');
  return url.origin + url.pathname.replace(/\/+$/, '');
}
function originPermission(baseURL: string) {
  const url = new URL(baseURL);
  return `${url.protocol}//${url.hostname}/*`;
}
function serverURL(path: string, baseURL?: string) {
  if (localMode && !baseURL) return 'https://local.invalid' + path;
  baseURL ||= connection?.baseURL;
  if (!baseURL || !path.startsWith('/') || path.startsWith('//')) throw new Error('服务器尚未连接');
  return baseURL + path;
}
async function jsonResponse(response: Response) {
  let data: Record<string, unknown>;
  try { data = await response.json(); } catch { throw new Error('服务器未提供扩展接口，请确认地址并升级简记服务器'); }
  if (!response.ok) throw new Error(String(data.error || `请求失败（${response.status}）`));
  return data;
}
async function request(path: string, options: RequestInit = {}) {
  if (localMode) {
    const response = await localRequest(path, options);
    if (response.ok && options.method && options.method !== 'GET' && path !== '/api/storage') scheduleStorageRefresh();
    responseOwners.set(response, undefined);
    return response;
  }
  if (!connection?.token || !path.startsWith('/api/')) throw new Error('请先连接服务器');
  const owner = connection;
  const headers = new Headers(options.headers);
  headers.set('Authorization', 'Bearer ' + owner.token);
  if (!headers.has('X-Note-Window')) headers.set('X-Note-Window', (window as unknown as { noteWindowID: string }).noteWindowID);
  const response = await fetch(serverURL(path, owner.baseURL), { ...options, headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: options.signal || AbortSignal.timeout(60000) });
  responseOwners.set(response, owner);
  assertCurrent(response);
  if (response.status === 401) $('#server-connection-label').textContent = '登录已过期 · 点击设置重新连接';
  return response;
}
function assertCurrent(response: Response) {
  if (responseOwners.get(response) !== (localMode ? undefined : connection)) throw new Error('服务器连接已切换，请重新操作');
}
function status(message: string, ok = false) {
  $('#connection-status').textContent = message;
  $('#connection-status').dataset.ok = String(ok);
  $('#connection-error').hidden = true;
}
function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  $('#connection-error').textContent = message === 'Failed to fetch' ? '无法连接服务器，请检查地址、网络和 HTTPS 证书' : message;
  $('#connection-error').hidden = false;
}
function busy(value: boolean) {
  formBusy = value;
  $('#connection-form').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(el => { el.disabled = value; });
}
function showSettings() {
  void updateStorage();
  $('#connection-page').hidden = false;
  $<HTMLInputElement>('#server-url').value = connection?.baseURL || '';
  $<HTMLInputElement>('#server-password').value = '';
  $('#back-to-notes').hidden = !configured;
  $('#disconnect-server').hidden = !connection?.token;
  status(localMode ? '当前使用本地笔记，连接服务器不会自动上传或合并数据。' : connection ? '重新连接同一服务器会保留当前未保存内容。' : '可直接打开本地笔记，或连接你的简记服务器。');
}
function hideSettings() {
  void updateStorage();
  $('#connection-page').hidden = true;
  $<HTMLInputElement>('#server-password').value = '';
  $('#share-note').hidden = localMode;
  $('#server-connection-label').textContent = localMode ? '本地笔记 · 仅此浏览器' : connection ? new URL(connection.baseURL).host : '尚未连接';
}
async function checkServer(baseURL: string) {
  const response = await fetch(serverURL('/api/client/info', baseURL), { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000) });
  const info = await jsonResponse(response);
  if (info.clientAPI !== 1) throw new Error('服务器版本不支持此扩展，请先升级服务器');
  return info;
}
// Invoke directly from a click/submit, before awaiting anything, to retain the browser user gesture.
function permissionForInput(): { baseURL: string; granted: Promise<boolean> } {
  const baseURL = normalizeServer($<HTMLInputElement>('#server-url').value);
  return { baseURL, granted: chrome.permissions.request({ origins: [originPermission(baseURL)] }) };
}
async function revoke(value: Connection) {
  const response = await fetch(serverURL('/api/client/session', value.baseURL), { method: 'DELETE', headers: { Authorization: 'Bearer ' + value.token }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok && response.status !== 401) throw new Error('无法撤销旧服务器登录，请稍后重试');
}
async function removeServerPermission(baseURL: string): Promise<string> {
  try { await chrome.permissions.remove({ origins: [originPermission(baseURL)] }); return ''; }
  catch { return '浏览器未能移除旧服务器访问权限，可在扩展管理中手动取消。'; }
}
function resetWorkspace() {
  resetFolderSession(); clearPendingImages(); clearNoteAssets();
  contentEditor.setValue('', true); state.current = null; state.folder = ''; state.dirty = false;
  state.version = ''; state.saved = { title: '', content: '' }; state.notes = [];
  folderState.items = []; folderState.expanded.clear(); $('#note-list').replaceChildren();
  $<HTMLInputElement>('#note-search').value = '';
}
function initConnectionUI() {
  window.addEventListener('focus', () => { if (configured && localMode) scheduleStorageRefresh(); });
  $('#local-limit').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('#save-local-limit').click(); }
  });
  $('#save-local-limit').onclick = async () => {
    if (!localMode || formBusy) return;
    busy(true);
    try {
      const response = await request('/api/storage', { method: 'PUT', body: JSON.stringify({ limitMiB: Number($<HTMLInputElement>('#local-limit').value) }) });
      await jsonResponse(response); await updateStorage(); status('离线空间上限已保存。', true);
    } catch (error) { errorMessage(error); } finally { busy(false); }
  };
  $('#use-local').onclick = async () => {
    if (state.saving || formBusy) return;
    if (configured && state.dirty && !await allowLeave()) return;
    busy(true);
    try {
      await chrome.storage.local.set({ workspaceMode: 'local' });
      localMode = true; resetWorkspace(); configured = true; hideSettings(); await init();
    } catch (error) { errorMessage(error); } finally { busy(false); }
  };
  $('#export-local').onclick = async () => {
    busy(true); try { await exportLocal(); status('本地笔记和图片已导出；未保存的编辑内容不包含在备份中。', true); }
    catch (error) { errorMessage(error); } finally { busy(false); }
  };
  $('#import-local').onclick = () => $<HTMLInputElement>('#local-backup-file').click();
  $<HTMLInputElement>('#local-backup-file').onchange = async event => {
    const field = event.target as HTMLInputElement; const file = field.files?.[0]; field.value = '';
    if (!file) return;
    busy(true);
    try { const count = await importLocal(file); if (localMode) { await refreshNotes(); scheduleStorageRefresh(); } status(`已导入 ${count} 篇本地笔记，原有笔记保持保留。`, true); }
    catch (error) { errorMessage(error); } finally { busy(false); }
  };
  $('#connection-settings').onclick = () => { if (!state.saving && !formBusy) showSettings(); };
  $('#back-to-notes').onclick = hideSettings;
  $('#show-server-password').onclick = () => {
    const field = $<HTMLInputElement>('#server-password'); field.type = field.type === 'password' ? 'text' : 'password';
    $('#show-server-password').textContent = field.type === 'password' ? '显示' : '隐藏';
  };
  chrome.commands.getAll().then(commands => { $('#actual-shortcut').textContent = commands.find(c => c.name === 'open-notes')?.shortcut || '未绑定'; });
  $('#shortcut-settings').onclick = () => { chrome.tabs.create({ url: /Edg\//.test(navigator.userAgent) ? 'edge://extensions/shortcuts' : 'chrome://extensions/shortcuts' }); };
  $('#test-server').onclick = async () => {
    try {
      const input = permissionForInput(); busy(true); status('正在连接…');
      if (!await input.granted) throw new Error('未获得服务器访问权限，请在浏览器提示中允许访问');
      const info = await checkServer(input.baseURL);
      status(info.passwordRequired ? '连接成功 · 请输入服务器访问密码' : '连接成功 · 服务器未设置访问密码', true);
    } catch (error) { errorMessage(error); } finally { busy(false); }
  };
  $('#connection-form').onsubmit = async event => {
    event.preventDefault();
    let next: Connection | undefined;
    let revocationWarning = "";
    try {
      const input = permissionForInput(); busy(true); status('正在连接…');
      if (!await input.granted) throw new Error('未获得服务器访问权限，请在浏览器提示中允许访问');
      await checkServer(input.baseURL);
      const response = await fetch(serverURL('/api/client/session', input.baseURL), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $<HTMLInputElement>('#server-password').value }), credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12000) });
      const result = await jsonResponse(response);
      next = { baseURL: input.baseURL, token: String(result.token), expiresAt: String(result.expiresAt) };
      const switching = localMode || Boolean(connection && connection.baseURL !== next.baseURL);
      if (switching && configured && state.dirty && !await allowLeave()) { await revoke(next); status("已取消切换，当前笔记保持不变。"); return; }
      if (connection) {
        try { await revoke(connection); } catch { revocationWarning = "旧服务器无法连接，未能远程撤销旧登录；本地凭证已移除，旧会话将在到期后失效。"; }
        if (originPermission(connection.baseURL) !== originPermission(next.baseURL)) revocationWarning += await removeServerPermission(connection.baseURL);
      }
      connection = next; localMode = false;
      await chrome.storage.local.set({ workspaceMode: 'server' });
      clearNoteAssets();
      await chrome.storage.local.set({ connection });
      hideSettings();
      if (switching) {
        $<HTMLInputElement>('#note-search').value = '';
        resetFolderSession();
        clearPendingImages(); contentEditor.setValue('', true);
        state.current = null; state.folder = ''; state.dirty = false;
        state.version = ''; state.saved = { title: '', content: '' }; state.notes = [];
        folderState.items = []; folderState.expanded.clear(); $('#note-list').replaceChildren();
      }
      if (!configured || switching) { configured = true; await init(); }
      else { await refreshNotes(); setLoading(false); window.dispatchEvent(new Event('note-assets-ready')); }
      if (revocationWarning) showNotice(revocationWarning);
    } catch (error) { if (configured) markDirty(); errorMessage(error); } finally { busy(false); }
  };
  $('#disconnect-server').onclick = async () => {
    if (configured && state.dirty && !await allowLeave()) return;
    busy(true); status('正在退出…');
    let revocationWarning = '';
    try {
      if (connection) {
        try { await revoke(connection); } catch { revocationWarning = '已从本地退出；服务器无法连接，旧登录未能远程撤销，将在到期后失效。'; }
        revocationWarning += await removeServerPermission(connection.baseURL);
      }
      await chrome.storage.local.remove('connection'); connection = undefined; localMode = false; await chrome.storage.local.set({ workspaceMode: 'server' }); configured = false;
      resetFolderSession(); clearPendingImages(); state.current = null; state.folder = ''; state.dirty = false;
      contentEditor.setValue('', true); $<HTMLInputElement>('#title').value = ''; $('#crumb-title').textContent = '新便签';
      state.version = ''; state.saved = { title: '', content: '' }; state.notes = [];
      folderState.items = []; folderState.expanded.clear(); $('#note-list').replaceChildren();
      setLoading(true); showSettings();
      if (revocationWarning) status(revocationWarning);
    } catch (error) { errorMessage(error); } finally { busy(false); }
  };
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'configure-notes' && !state.saving && !formBusy) showSettings();
  });
  // Handle attached image download links without putting credentials into URLs.
  $('#content').addEventListener('click', async event => {
    const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const target = noteAssetPath(anchor.getAttribute('href') || '', state.current);
    if (!target) {
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('#')) return;
      const destination = new URL(href, (localMode ? 'https://local.invalid' : connection?.baseURL || 'https://local.invalid') + '/');
      if (localMode && destination.origin === 'https://local.invalid') { event.preventDefault(); showNotice('本地模式下请使用完整网页地址'); return; }
      if (destination.protocol === 'http:' || destination.protocol === 'https:') {
        event.preventDefault(); await chrome.tabs.create({ url: destination.href });
      }
      return;
    }
    // Stored attachments are handled by the shared authenticated downloader.
  });
}
let initialized = false;
const host = {
  request, serverURL, assertCurrent,
  get localMode() { return localMode; },
  async prepare() {
    if (!initialized) { initConnectionUI(); initialized = true; }
    if (!modeLoaded) { localMode = (await chrome.storage.local.get('workspaceMode')).workspaceMode === 'local'; modeLoaded = true; }
    if (!connection) connection = (await chrome.storage.local.get('connection')).connection as Connection | undefined;
    const { showSettings: requested } = await chrome.storage.session.get('showSettings');
    await chrome.storage.session.remove('showSettings');
    if (localMode) { configured = true; if (requested) showSettings(); else hideSettings(); return true; }
    if (!connection?.token || Date.parse(connection.expiresAt) < Date.now() || !await chrome.permissions.contains({ origins: [originPermission(connection.baseURL)] })) { showSettings(); return false; }
    configured = true;
    if (requested) showSettings(); else hideSettings();
    return true;
  }
};
(window as unknown as { noteHost: typeof host }).noteHost = host;
export {};
