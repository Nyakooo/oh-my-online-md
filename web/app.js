const $ = (selector) => document.querySelector(selector);
const state = { notes: [], current: null, folder: '', version: '', saving: false, dirty: false, saved: { title: '', content: '' } };
let loading = true;
function setLoading(value, message = '正在加载笔记…', scope = 'page') {
  const pageLoading = value && scope === 'page';
  loading = value;
  $('.app').dataset.loading = String(value);
  $('.app').dataset.loadingScope = scope;
  $('.app').setAttribute('aria-busy', String(value));
  $('#loading-panel').hidden = !value;
  $('#loading-message').textContent = message;
  $('#retry-load').hidden = true;
  $('#editor-pane').inert = value;
  $('#editor-pane').setAttribute('aria-busy', String(value));
  $('#sidebar').inert = value;
  $('.sidebar-rail').inert = value;
  $('#new-note').disabled = pageLoading;
  $('#new-folder').disabled = pageLoading;
  $('#note-search').disabled = pageLoading;
  $('#note-list').inert = value;
  document.querySelectorAll('.sidebar-rail [data-note-action]').forEach(button => { button.disabled = pageLoading; });
  $('#mobile-menu').disabled = value;
  $('#note-menu').hidden = true;
  $('#save-note').disabled = value || state.saving || !$('#folder-locked-panel').hidden || Boolean(state.current && !state.dirty);
  $('#share-note').disabled = value || !$('#folder-locked-panel').hidden;
}
const MAX_NOTE_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_NOTE_REQUEST_BYTES = 32 * 1024 * 1024;
const utf8Size = value => new TextEncoder().encode(value).byteLength;
const pendingImages = new Map();
function clearPendingImages() {
  for (const image of pendingImages.values()) URL.revokeObjectURL(image.url);
  pendingImages.clear();

}
const escapeHTML = (value) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function noteRequest(url, options = {}) {
  const headers = new Headers(options.headers); if (!headers.has('X-Note-Window')) headers.set('X-Note-Window', folderSession.windowID);
  const request = { ...options, headers, cache: 'no-store' };
  return window.noteHost ? window.noteHost.request(url, request) : fetch(url, request);
}
async function api(url, options = {}) {
  const accessEpoch = folderSession.epoch;
  if (typeof options.body === 'string' && utf8Size(options.body) > MAX_NOTE_REQUEST_BYTES) throw new Error('笔记保存请求超过 32 MiB 上限，请缩减内容或拆分笔记，当前编辑内容已保留');
  const response = await noteRequest(url, options);
  if (!response.ok) {
    const message = await response.text();
    if (response.status === 401) throw new Error(window.noteHost ? '连接已过期，请点击服务器设置重新登录；当前未保存内容仍保留' : '登录已过期，请在新标签页登录后重试，当前未保存内容仍保留');
    let detail;
    try { detail = JSON.parse(message).error; } catch {}
    if (response.status === 413) throw new Error(detail || (url.endsWith('/assets') ? '图片上传超限：单张图片最多 10 MiB；请检查反向代理上传限制' : '保存请求被服务器或反向代理拒绝（413），请检查 Nginx 的 client_max_body_size 是否至少为 32m；当前编辑内容已保留'));
    const error = new Error(detail || `请求失败（HTTP ${response.status}）`); error.status = response.status; throw error;
  }
  const result = response.status === 204 ? null : await response.json();
  window.noteHost?.assertCurrent(response);
  if ((!options.method || options.method === 'GET') && accessEpoch !== folderSession.epoch) throw new Error('文件夹访问状态已改变，请重试');
  return result;
}
let noticeTimer;
function showNotice(message) {
  clearTimeout(noticeTimer);
  $('#notice').textContent = message;
  $('#notice').hidden = false;
  noticeTimer = setTimeout(() => { $('#notice').hidden = true; }, 6000);
}
function setSavedState(text) {
  $('#save-state').textContent = text;
  const button = $('#save-note');
  button.dataset.state = text === '保存中…' ? 'saving' : text === '保存失败' || text === '连接失败' ? 'error' : text === '已保存' ? 'saved' : 'idle';
  button.setAttribute('aria-label', button.dataset.state === 'idle' ? '保存' : text);
  if (button.dataset.state === 'saving' || button.dataset.state === 'saved') { clearTimeout(noticeTimer); $('#notice').hidden = true; }
  if (button.dataset.state === 'saving') button.innerHTML = '<span class="save-spinner" aria-hidden="true"></span>';
  else button.textContent = button.dataset.state === 'saved' ? '✓' : button.dataset.state === 'error' ? '!' : '保存';
  button.disabled = loading || state.saving || Boolean(state.current && !state.dirty);
}
function markDirty() {
  state.dirty = $('#title').value !== state.saved.title || contentEditor.getValue() !== state.saved.content;
  setSavedState(state.dirty ? '未保存' : state.current ? '已保存' : '草稿');
}

async function refreshNotes() {
  await refreshFolders();
  const protectedFolder = folderState.items.find(f => f.name === state.folder && f.protected && f.locked);
  if (protectedFolder) resetProtectedEditor(protectedFolder.name, true);
  state.notes = await api('/api/notes');
  await searchNotes();
}
let searchVersion = 0;
let searchTimer;
function highlightSearch(text, query) {
  if (!query) return escapeHTML(text);
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = text.matchAll(new RegExp(pattern, 'giu'));
  let result = '', offset = 0;
  for (const match of matches) {
    result += escapeHTML(text.slice(offset, match.index)) + '<mark>' + escapeHTML(match[0]) + '</mark>';
    offset = match.index + match[0].length;
  }
  return result + escapeHTML(text.slice(offset));
}
async function searchNotes(options = {}) {
  const version = ++searchVersion;
  const query = $('#note-search').value.trim();
  const notes = query && !options.localOnly ? await api('/api/notes?q=' + encodeURIComponent(query)) : query ? state.notes.filter(note => (note.title || '').toLocaleLowerCase().includes(query.toLocaleLowerCase())) : state.notes;
  if (version !== searchVersion) return;
  const list = $('#note-list');
  list.replaceChildren();
  $('#list-label').textContent = query ? `搜索结果 · ${notes.length}` : '我的笔记';
  $('#empty-list').hidden = notes.length > 0 || (!query && folderState.items.length > 0);
  $('#empty-list').textContent = query ? '没有找到匹配的笔记。' : '还没有笔记，点上方按钮记下第一条。';
  const makeNote = note => {
    const button = document.createElement('button');
    const date = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(note.updatedAt));
    button.className = `note-item${note.id === state.current ? ' active' : ''}`;
    button.innerHTML = `${folderIcon('note')}<span class="note-details"><span class="note-name">${highlightSearch(note.title || '未命名便签', query)}</span>${note.snippet ? `<span class="note-snippet">${highlightSearch(note.snippet, query)}</span>` : ''}<span class="note-date">${date}</span></span>`;
    bindNoteDrag(button, note);
    button.addEventListener('click', () => openNote(note.id));
    button.addEventListener('contextmenu', async event => {
      event.preventDefault();
      await openNote(note.id);
      if (state.current !== note.id) return;
      const menu = $('#note-menu');
      menu.style.left = `${Math.min(event.clientX, innerWidth - 150)}px`;
      menu.style.top = `${Math.min(event.clientY, innerHeight - 100)}px`;
      menu.hidden = false;
    });
    return button;
  };
  renderFolderList(list, notes, query, makeNote);
}
function askUnsaved() {
  return new Promise((resolve) => {
    const dialog = $('#unsaved-dialog');
    const finish = (choice) => { dialog.close(); resolve(choice); };
    $('#save-and-continue').onclick = () => finish('save');
    $('#discard-changes').onclick = () => finish('discard');
    $('#cancel-navigation').onclick = () => finish('cancel');
    dialog.oncancel = event => { event.preventDefault(); finish('cancel'); };
    dialog.showModal();
  });
}
async function allowLeave() {
  if (state.saving || loading || folderState.busy) return false;
  if (!state.dirty) return true;
  const choice = await askUnsaved();
  if (choice === 'save') return saveNote();
  if (choice === 'discard') { state.dirty = false; setSavedState('已保存'); return true; }
  return false;
}
async function loadNote(id) {
  const note = await api(`/api/notes/${id}`);
  clearPendingImages();
  clearNoteAssets();
  showNoteEditor();
  state.current = id;
  state.version = note.version;
  state.folder = note.folder || '';
  const expandFolder = state.folder && !folderState.expanded.has(state.folder);
  if (state.folder) folderState.expanded.add(state.folder);
  $('#delete-note').disabled = false;
  $('#title').value = note.title;
  contentEditor.setValue(note.content, true);
  state.saved = { title: note.title, content: note.content };
  updateFolderCrumb(note.title);
  state.dirty = false;
  setSavedState('已保存');
  if (expandFolder) await searchNotes();
  else for (const button of $('#note-list').querySelectorAll('.note-item')) button.classList.toggle('active', button.dataset.noteId === id);
}
async function openNote(id) {
  if (loading) return;
  if (id === state.current) { await leaveProtectedFolder(state.folder, true); closeMobileSidebar(); return; }
  if (!await allowLeave() || loading) return;
  const target = state.notes.find(note => note.id === id)?.folder || '';
  if (!await leaveProtectedFolder(target, true)) return;
  setLoading(true, '正在加载笔记…', 'note');
  try {
    await loadNote(id);
    closeMobileSidebar();
    return true;
  } catch (error) { showNotice(error.message); return false; }
  finally { setLoading(false); }
}
async function createNote() {
  if (!await allowLeave() || !await leaveProtectedFolder('', true)) return;
  showNoteEditor();
  setLoading(true);
  try {
    clearPendingImages(); clearNoteAssets();
    state.current = null; state.version = ''; state.folder = ''; state.dirty = false;
    $('#delete-note').disabled = true;
    $('#title').value = ''; contentEditor.setValue('', true);
    state.saved = { title: '', content: '' };
    updateFolderCrumb('新便签'); setSavedState('草稿');
    await refreshNotes();
    closeMobileSidebar();
  } catch (error) { showNotice(error.message); }
  finally { setLoading(false); $('#title').focus(); }
}
async function saveNote() {
  if (!$('#folder-locked-panel').hidden) return false;
  if (state.saving || loading || folderState.busy) return false;
  if (state.current && !state.dirty) { setSavedState('已保存'); return true; }
  const saveEpoch = folderSession.epoch;
  let saveID = state.current, saveVersion = state.version;
  const assertSaveAccess = () => { if (saveEpoch !== folderSession.epoch) throw new Error('文件夹已锁定，请解锁后确认保存状态'); };
  const title = $('#title').value;
  let content = contentEditor.getValue();
  const contentBytes = utf8Size(content);
  if (contentBytes > MAX_NOTE_CONTENT_BYTES || utf8Size(JSON.stringify({title, content})) > MAX_NOTE_REQUEST_BYTES) {
    setSavedState('保存失败');
    showNotice(contentBytes > MAX_NOTE_CONTENT_BYTES
      ? `笔记正文过长：当前 ${(contentBytes / 1024 / 1024).toFixed(2)} MiB，上限 16 MiB（UTF-8），请拆分后保存；当前编辑内容已保留`
      : '笔记保存请求超过 32 MiB 上限，请拆分后保存；当前编辑内容已保留');
    return false;
  }
  state.saving = true;
  // Keep a fixed revision while uploading so navigation and edits cannot race
  // the server's cleanup of removed references.
  contentEditor.blur();
  contentEditor.setEditable(false);
  const controls = ['#title', '#save-note', '#share-note', '#new-folder'];
  controls.forEach(selector => { $(selector).disabled = true; });
  setSavedState('保存中…');
  try {
    const images = [...pendingImages].filter(([path]) => content.includes(path));
    if (images.length && !saveID) {
      const draft = await api('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content: '' })
      });
      assertSaveAccess();
      saveID = state.current = draft.id;
      saveVersion = state.version = draft.version;
    }
    for (const [path, image] of images) {
      if (!image.uploadedPath) {
        const result = await api(`/api/notes/${saveID}/assets`, { method: 'POST', body: image.file });
        // Reuse completed uploads if the note save fails and the user retries.
        assertSaveAccess();
        image.uploadedPath = result.path;
      }
      content = content.replaceAll(path, image.uploadedPath);
    }
    const uploadedAssets = [...pendingImages.values()].map(image => image.uploadedPath).filter(Boolean);
    assertSaveAccess();
    const options = { method: saveID ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json', ...(saveID && saveVersion ? { 'If-Match': '"' + saveVersion + '"' } : {}) }, body: JSON.stringify({ title, content, uploadedAssets }) };
    const url = saveID ? `/api/notes/${saveID}` : '/api/notes';
    const saved = await api(url, options);
    assertSaveAccess();
    state.current = saved.id;
    state.version = saved.version;
    clearNoteAssets();
    state.folder = saved.folder || '';
    $('#delete-note').disabled = false;
    $('#title').value = saved.title;
    contentEditor.setValue(saved.content);
    state.saved = { title: saved.title, content: saved.content };
    state.dirty = false;
    contentEditor.refreshImages();
    updateFolderCrumb(saved.title);
    setSavedState('已保存');
    if (saved.cleanupWarning) showNotice(saved.cleanupWarning);
    // A sidebar refresh failure must not misreport a successful note save.
    try { await refreshNotes(); } catch { showNotice('笔记已保存，列表刷新失败，请刷新页面'); }
    return true;
  } catch (error) {
    if (saveEpoch !== folderSession.epoch) return false;
    state.dirty = true;
    setSavedState('保存失败');
    showNotice(error.message);
    if (error.status === 412) showConflictDialog();
    if (error.status === 403 && state.folder) setTimeout(autoLockFolders, 0);
    return false;
  } finally {
    state.saving = false;
    contentEditor.setEditable(true);
    controls.forEach(selector => { $(selector).disabled = false; });
    $('#save-note').disabled = !$('#folder-locked-panel').hidden || Boolean(state.current && !state.dirty);
    $('#share-note').disabled = !$('#folder-locked-panel').hidden;
  }
}
async function deleteNote() {
  if (loading || !state.current || state.saving || folderState.busy) return;
  const message = state.dirty ? '删除这篇笔记和未保存的修改？此操作无法撤销。' : '删除这篇笔记？此操作无法撤销。';
  if (!confirm(message)) return;
  await api(`/api/notes/${state.current}`, { method: 'DELETE', headers: state.version ? { 'If-Match': '"' + state.version + '"' } : {} });
  clearPendingImages();
  state.current = null;
  state.version = '';
  state.folder = '';
  state.dirty = false;
  $('#delete-note').disabled = true;
  await refreshNotes();
  if (state.notes.length) await openNote(state.notes[0].id);
  else await createNote();
}
function initTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  updateThemeButton();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem('theme')) updateThemeButton();
  });
}
function isDarkTheme() {
  return document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
}
function updateThemeButton() {
  const dark = isDarkTheme();
  const icon = dark
    ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>'
    : '<path d="M20.5 13.3A8.5 8.5 0 0 1 10.7 3.5a8.5 8.5 0 1 0 9.8 9.8Z"/>';
  $('#theme-toggle').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
  $('#theme-toggle').title = dark ? '切换到白天模式' : '切换到黑夜模式';
  $('#theme-toggle').setAttribute('aria-label', $('#theme-toggle').title);
}
function resolveImage(path) {
  const asset = resolveNoteAsset(path); if (asset !== null) return asset;
  if (pendingImages.has(path)) return pendingImages.get(path).url;
  if (state.current && /^assets\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(path)) return `/api/notes/${state.current}/${path}`;
  return path;
}
const contentEditor = createNoteEditor($('#content'), {
  onChange: markDirty,
  resolveImage,
  onPaste(event) {
    const images = Array.from(event.clipboardData?.items || []).filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    if (!images.length) return false;
    event.preventDefault();
    insertImages(images);
    return true;
  }
});
function insertImages(files) {
  if (loading || !files.length || state.saving) return;
  try {
    for (const file of files) {
      if (!['image/png','image/jpeg','image/gif','image/webp'].includes(file.type)) throw new Error('仅支持 PNG、JPEG、GIF、WebP 图片');
      if (file.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MiB');
    }
    for (const file of files) {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[file.type];
      const path = `assets/pending/${id}.${ext}`;
      pendingImages.set(path, { file, url: URL.createObjectURL(file) });
      contentEditor.insertText(`\n![图片](${path})\n`);
    }
    markDirty();
    contentEditor.refreshImages();
  } catch (error) { showNotice(error.message); }
}
let activeShare = null;
let shareBusy = false;
function renderShare(record) {
  activeShare = record;
  $('#share-result').hidden = !record;
  $('#revoke-share').hidden = !record;
  $('#create-share').textContent = state.dirty || !state.current ? '保存并生成链接' : record ? '重新生成链接' : '生成链接';
  if (record) {
    $('#share-link').value = window.noteHost ? window.noteHost.serverURL(record.path) : new URL(record.path, location.origin).href;
    $('#share-expiry').textContent = `${new Date(record.expiresAt).toLocaleString('zh-CN', { hour12: false })} 到期`;
    $('#share-days').value = record.days;
  }
}
function shareError(message) {
  $('#share-error').textContent = message;
  $('#share-error').hidden = !message;
}
function setShareBusy(busy) {
  shareBusy = busy;
  for (const id of ['#create-share', '#revoke-share', '#share-days', '#close-share', '#copy-share']) $(id).disabled = busy;
}
async function openShare() {
  if (loading || state.saving || shareBusy || folderState.busy || !$('#folder-locked-panel').hidden) return;
  contentEditor.blur();
  shareError('');
  $('#copy-share').textContent = '复制链接';
  $('#share-days').value = '1';
  renderShare(null);
  $('#share-dialog').showModal();
  setShareBusy(true);
  try {
    if (state.current) renderShare(await api(`/api/notes/${state.current}/share`));
  } catch (error) { shareError(error.message); }
  finally { setShareBusy(false); }
}
$('#attach-image').onclick = () => { if (!loading && !state.saving) $('#image-input').click(); };
$('#image-input').onchange = event => { insertImages([...event.target.files]); event.target.value = ''; };
$('#content').addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
$('#content').addEventListener('drop', event => {
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  if (!loading && !state.saving) insertImages([...event.dataTransfer.files]);
});
$('#share-note').addEventListener('click', openShare);
$('#close-share').addEventListener('click', () => $('#share-dialog').close());
$('#share-dialog').addEventListener('cancel', event => { if (shareBusy) event.preventDefault(); });
$('#create-share').addEventListener('click', async () => {
  if (shareBusy) return;
  const days = Number($('#share-days').value);
  setShareBusy(true);
  shareError('');
  $('#create-share').textContent = '生成中…';
  try {
    // This action is explicitly labelled "save and generate" for unsaved edits.
    if ((state.dirty || !state.current) && !await saveNote()) throw new Error('笔记保存失败，请重试后再分享');
    renderShare(await api(`/api/notes/${state.current}/share`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }) }));
    $('#copy-share').textContent = '复制链接';
  } catch (error) { shareError(error.message); renderShare(activeShare); }
  finally { setShareBusy(false); }
});
$('#copy-share').addEventListener('click', async () => {
  const input = $('#share-link');
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(input.value);
    $('#copy-share').textContent = '已复制';
  } catch {
    input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
    // Plain HTTP on a LAN may not expose the Clipboard API.
    if (document.execCommand('copy')) $('#copy-share').textContent = '已复制';
    else shareError('链接已选中，请长按或使用复制快捷键');
  }
});
$('#revoke-share').addEventListener('click', async () => {
  if (shareBusy || !state.current) return;
  setShareBusy(true); shareError('');
  try {
    await api(`/api/notes/${state.current}/share`, { method: 'DELETE' });
    renderShare(null);
  } catch (error) { shareError(error.message); }
  finally { setShareBusy(false); }
});
$('#theme-toggle').addEventListener('click', () => {
  const next = isDarkTheme() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  updateThemeButton();
});
$('#note-search').addEventListener('input', event => {
  ++searchVersion;
  clearTimeout(searchTimer);
  if (event.isComposing) return;
  searchTimer = setTimeout(() => searchNotes().catch(error => showNotice(error.message)), 180);
});
$('#note-search').addEventListener('compositionend', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => searchNotes().catch(error => showNotice(error.message)), 180);
});
$('#note-search').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    $('#note-search').value = '';
    clearTimeout(searchTimer);
    searchNotes().catch(error => showNotice(error.message));
  }
});
$('#new-note').addEventListener('click', createNote);
$('#title').addEventListener('input', markDirty);
$('#save-note').addEventListener('click', saveNote);
$('#delete-note').addEventListener('click', () => deleteNote().catch(error => showNotice(error.message)));
document.addEventListener('click', event => { if (!event.target.closest('#note-menu')) $('#note-menu').hidden = true; });
$('#note-menu').addEventListener('click', () => { $('#note-menu').hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('#note-menu').hidden = true; });
const sidebarMedia = window.matchMedia('(max-width: 760px)');
function isSidebarOpen() {
  if (sidebarMedia.matches) return document.documentElement.dataset.mobileSidebarOpen === 'true';
  const collapsed = document.documentElement.dataset.sidebarCollapsed;
  return collapsed !== 'true';
}
function closeMobileSidebar() {
  if (sidebarMedia.matches) setSidebarOpen(false);
}
let sidebarPeekTimer;
let sidebarPeekPinned = false;
function setSidebarPeek(open, pin = false) {
  clearTimeout(sidebarPeekTimer);
  const peek = open && !sidebarMedia.matches && !isSidebarOpen();
  sidebarPeekPinned = peek && (pin || sidebarPeekPinned);
  if (document.documentElement.dataset.sidebarPeek !== String(peek)) document.documentElement.dataset.sidebarPeek = String(peek);
  $('#rail-directory').setAttribute('aria-expanded', String(peek));
  $('#rail-directory').classList.toggle('active', peek);
}
function syncSidebar() {
  setSidebarPeek(false);
  const open = isSidebarOpen();
  $('#sidebar').classList.toggle('open', sidebarMedia.matches && open);
  for (const id of ['sidebar-toggle', 'mobile-menu']) $(`#${id}`).setAttribute('aria-expanded', String(open));
  const label = open ? '收起侧栏' : '展开侧栏';
  $('#sidebar-toggle').setAttribute('aria-label', label);
  $('#sidebar-toggle').title = label;
  $('#sidebar-toggle svg path').setAttribute('d', open ? 'M9 4v16m6-11-3 3 3 3' : 'M9 4v16m4-11 3 3-3 3');
}
function setSidebarOpen(open) {
  if (sidebarMedia.matches) {
    document.documentElement.dataset.mobileSidebarOpen = String(open);
    try { localStorage.setItem('mobile-sidebar-open', String(open)); } catch {}
  } else {
    document.documentElement.dataset.sidebarCollapsed = String(!open);
    try { localStorage.setItem('sidebar-collapsed', String(!open)); } catch {}
  }
  syncSidebar();
}
for (const id of ['sidebar-toggle', 'mobile-menu']) $(`#${id}`).addEventListener('click', () => setSidebarOpen(!isSidebarOpen()));
const sidebarRail = $('.sidebar-rail');
for (const id of ['rail-directory', 'rail-search']) {
  for (const type of ['mouseenter', 'focus']) $(`#${id}`).addEventListener(type, () => { if (!loading) setSidebarPeek(true); });
}
function scheduleSidebarPeekClose() {
  clearTimeout(sidebarPeekTimer);
  sidebarPeekTimer = setTimeout(() => {
    if (!sidebarPeekPinned && !$('#sidebar').matches(':hover') && !sidebarRail.matches(':hover') && !$('#sidebar').contains(document.activeElement)) setSidebarPeek(false);
  }, 140);
}
sidebarRail.addEventListener('mouseleave', scheduleSidebarPeekClose);
$('#sidebar').addEventListener('mouseenter', () => clearTimeout(sidebarPeekTimer));
$('#sidebar').addEventListener('mouseleave', scheduleSidebarPeekClose);
$('#sidebar').addEventListener('focusout', scheduleSidebarPeekClose);
sidebarRail.addEventListener('focusout', scheduleSidebarPeekClose);
$('#rail-new').onclick = () => { setSidebarPeek(false); createNote(); };
$('#rail-directory').onclick = () => setSidebarPeek(true, true);
$('#rail-search').onclick = () => { setSidebarPeek(true, true); $('#note-search').focus({ preventScroll: true }); };
$('#rail-expand').onclick = () => setSidebarOpen(true);
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('#sidebar, .sidebar-rail')) setSidebarPeek(false);
  if (sidebarMedia.matches && isSidebarOpen() && !event.target.closest('#sidebar, #mobile-menu')) setSidebarOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && sidebarMedia.matches && isSidebarOpen() && !event.target.closest('dialog')) {
    setSidebarOpen(false);
    $('#mobile-menu').focus();
  }
  if (event.key === 'Escape' && document.documentElement.dataset.sidebarPeek === 'true') {
    setSidebarPeek(false);
    $('#sidebar-toggle').focus();
  }
});
sidebarMedia.addEventListener('change', syncSidebar);
syncSidebar();
$('#sidebar').addEventListener('click', (event) => { if (event.target.id === 'sidebar') closeMobileSidebar(); });
document.addEventListener('keydown', (event) => {
  if (loading) {
    if ((event.ctrlKey || event.metaKey) && ['k', 's', 'p'].includes(event.key.toLowerCase())) event.preventDefault();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !event.target.closest('.cm-editor')) { event.preventDefault(); setSidebarOpen(true); $('#note-search').focus(); $('#note-search').select(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); contentEditor.togglePreview(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveNote(); }
});
window.addEventListener('beforeunload', (event) => { if (state.dirty || state.saving) { event.preventDefault(); event.returnValue = ''; } });
async function init() {
  initTheme();
  if (!$('#new-folder').dataset.initialized) { initFolderUI(); initFolderSession(); $('#new-folder').dataset.initialized = 'true'; }
  setLoading(true);
  try {
    if (window.noteHost && !await window.noteHost.prepare()) return;
    await refreshNotes();
    if (state.notes.length) await loadNote(state.notes[0].id);
    else { state.current = null; state.folder = ''; state.version = ''; state.saved = { title: '', content: '' }; state.dirty = false; $('#title').value = ''; contentEditor.setValue('', true); updateFolderCrumb('新便签'); setSavedState('草稿'); }
    setLoading(false);
  } catch (error) {
    setLoading(true);
    setSavedState('连接失败');
    $('#loading-message').textContent = error.message || '加载失败，请检查连接后重试';
    $('#retry-load').hidden = false;
  }
}
$('#retry-load').onclick = init;
function showConflictDialog() {
 const dialog = document.createElement('dialog'); dialog.className = 'unsaved-dialog';
 dialog.innerHTML = '<h2>这篇笔记已在其他窗口修改</h2><p>当前内容仍保留。可以继续保留本地编辑，或放弃本地内容，重新加载服务器版本。</p><div class="dialog-actions"><button type="button" data-keep>保留本地内容</button><button type="button" class="primary" data-reload>放弃本地并重新加载</button></div>';
 document.body.append(dialog); dialog.onclose = () => dialog.remove();
 dialog.querySelector('[data-keep]').onclick = () => dialog.close();
 dialog.querySelector('[data-reload]').onclick = async () => { dialog.close(); setLoading(true); try { await loadNote(state.current); } catch (error) { showNotice(error.message); } finally { setLoading(false); } };
 dialog.showModal();
}
window.addEventListener('note-assets-ready', () => contentEditor.refreshImages());
init();
