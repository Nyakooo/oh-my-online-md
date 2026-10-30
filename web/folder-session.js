const folderSession = { windowID: newFolderWindowID(), epoch: 0, lastActivity: Date.now(), timer: null, drafts: new Map(), lockedFolder: '', busy: false };
window.noteWindowID = folderSession.windowID;
const FOLDER_IDLE_MS = 5 * 60 * 1000;
function newFolderWindowID() { return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); }
function resetFolderSession() {
  folderSession.epoch++; folderSession.drafts.clear(); folderSession.lockedFolder = '';
  folderSession.windowID = newFolderWindowID(); window.noteWindowID = folderSession.windowID;
  clearTimeout(folderSession.timer); clearNoteAssets();
  $('#folder-locked-panel').hidden = true; $('#editor-pane').hidden = false;
}
function showNoteEditor() { $('#folder-locked-panel').hidden = true; $('#editor-pane').hidden = false; folderSession.lockedFolder = ''; }
function resetProtectedEditor(folder, preserveDraft = false) {
  const resume = { id: state.current };
  if (preserveDraft && state.dirty) {
    Object.assign(resume, { title: $('#title').value, content: contentEditor.getValue(), saved: { ...state.saved }, version: state.version, images: [...pendingImages].map(([path, image]) => [path, { file: image.file, uploadedPath: image.uploadedPath }]) });
  }
  if (preserveDraft && state.current) folderSession.drafts.set(folder, resume);
  contentEditor.closeDialogs();
  clearPendingImages(); clearNoteAssets();
  state.current = null; state.version = ''; state.folder = ''; state.dirty = false;
  state.saved = { title: '', content: '' }; $('#title').value = ''; contentEditor.setValue('', true);
  $('#delete-note').disabled = true; updateFolderCrumb('新便签'); setSavedState('草稿');
  $('#share-dialog').close();
  if (preserveDraft && resume.id) {
    folderSession.lockedFolder = folder;
    $('#locked-folder-name').textContent = `「${folder}」已锁定`;
    $('#locked-folder-hint').textContent = resume.content !== undefined ? '未保存修改暂存在此窗口内存中，重新解锁后可继续编辑。' : '重新输入密码后继续查看。';
    $('#folder-locked-panel').hidden = false; $('#editor-pane').hidden = true;
    $('#share-note').disabled = true; $('#save-note').disabled = true;
  }
}
async function restoreFolderDraft(folder) {
  const draft = folderSession.drafts.get(folder.name);
  if (!draft) return;
  if (draft.content === undefined) { await loadNote(draft.id); folderSession.drafts.delete(folder.name); return; }
  // Confirm access using the server without replacing the local, unsaved revision.
  await api(`/api/notes/${draft.id}`);
  contentEditor.closeDialogs();
  clearPendingImages(); clearNoteAssets();
  state.current = draft.id; state.folder = folder.name; state.version = draft.version; state.saved = draft.saved;
  $('#title').value = draft.title; contentEditor.setValue(draft.content, true);
  for (const [path, image] of draft.images) pendingImages.set(path, { ...image, url: URL.createObjectURL(image.file) });
  showNoteEditor(); $('#delete-note').disabled = false; updateFolderCrumb(draft.title); markDirty();
  folderSession.drafts.delete(folder.name); contentEditor.refreshImages();
}
async function lockFolderPermissions(folder) {
  folderSession.epoch++;
  await api(folderURL(folder.name) + '/lock', { method: 'POST' });
  folderState.expanded.delete(folder.name); folder.locked = true; clearNoteAssets();
}
async function leaveProtectedFolder(targetFolder, alreadyAllowed = false) {
  const folders = folderState.items.filter(f => f.protected && !f.locked && f.name !== targetFolder);
  if (!folders.length) return true;
  const current = folders.find(f => f.name === state.folder);
  if (current && !alreadyAllowed && !await allowLeave()) return false;
  for (const folder of folders) await lockFolderPermissions(folder);
  if (current) resetProtectedEditor(current.name);
  // Permission changes must invalidate cached private rows even when note navigation reuses the list.
  const lockedNames = new Set(folders.map(folder => folder.name));
  state.notes = state.notes.filter(note => !lockedNames.has(note.folder));
  await searchNotes({ localOnly: true });
  return true;
}
async function beforeFolderAccess(folder) {
  if (!await leaveProtectedFolder(folder.name)) return false;
  if (folderSession.drafts.has(folder.name) && state.dirty && !await allowLeave()) return false;
  return true;
}
async function autoLockFolders({ force = false } = {}) {
  if (folderSession.busy) return;
  if (!force && (state.saving || folderState.busy)) { folderSession.timer = setTimeout(autoLockFolders, 500); return; }
  const folders = folderState.items.filter(f => f.protected && !f.locked);
  if (!folders.length) return;
  folderSession.busy = true; folderSession.epoch++;
  const oldWindowID = folderSession.windowID;
  folderSession.windowID = newFolderWindowID(); window.noteWindowID = folderSession.windowID;
  const currentFolder = folders.find(f => f.name === state.folder);
  if (currentFolder) resetProtectedEditor(currentFolder.name, true);
  if ($('#folder-dialog').open) $('#folder-dialog').close();
  for (const folder of folders) { folder.locked = true; folderState.expanded.delete(folder.name); }
  clearNoteAssets();
  // Hide protected titles immediately, even if the network is unavailable.
  state.notes = state.notes.filter(note => !folders.some(f => f.name === note.folder));
  await searchNotes({ localOnly: true }).catch(() => {});
  try { await api('/api/folder-window/lock', { method: 'POST', headers: { 'X-Note-Window': oldWindowID } }); await refreshNotes(); }
  catch (error) { showNotice('文件夹已在本窗口锁定；连接恢复后请重新解锁。'); }
  finally { folderSession.busy = false; }
}
function armFolderIdleTimer() {
  clearTimeout(folderSession.timer);
  folderSession.timer = setTimeout(autoLockFolders, FOLDER_IDLE_MS);
}
function recordFolderActivity() {
  if (Date.now() - folderSession.lastActivity >= FOLDER_IDLE_MS && folderState.items.some(f => f.protected && !f.locked)) {
    autoLockFolders();
  }
  folderSession.lastActivity = Date.now(); armFolderIdleTimer();
}
function initFolderSession() {
  $('#unlock-active-folder').onclick = async () => {
    const folder = folderState.items.find(f => f.name === folderSession.lockedFolder);
    if (folder) { try { await unlockFolderUI(folder); } catch (error) { showNotice(error.message); } }
  };
  for (const event of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) document.addEventListener(event, recordFolderActivity, { passive: true });
  window.addEventListener('focus', recordFolderActivity);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) recordFolderActivity(); });
  setInterval(async () => {
    if (document.hidden || folderSession.busy || Date.now() - folderSession.lastActivity >= FOLDER_IDLE_MS) return;
    const folder = folderState.items.find(f => f.protected && !f.locked);
    if (!folder) return;
    try { await api(folderURL(folder.name) + '/touch', { method: 'POST' }); }
    catch { if (!state.saving && !folderState.busy) autoLockFolders(); }
  }, 30000);
  window.addEventListener('pagehide', () => { autoLockFolders({ force: true }); noteRequest('/api/folder-window/lock', { method: 'POST', keepalive: true }).catch(() => {}); });
}
