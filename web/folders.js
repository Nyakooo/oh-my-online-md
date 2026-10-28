// Folder UI extends the existing note list; all storage and access checks live on the server.
const folderState = { items: [], expanded: new Set(), busy: false };
const folderIcons = {
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  open: '<path d="M3 10V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2"/><path d="M5 10h16l-3 10H3L1 10Z"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  folderplus: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 10v6M9 13h6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'
};
function folderIcon(name) {
  return `<svg class="folder-icon icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${folderIcons[name]}</svg>`;
}
const folderURL = name => '/api/folders/' + encodeURIComponent(name);
const folderJSON = (method, value) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
async function refreshFolders() {
  folderState.items = await api('/api/folders');
}
function updateFolderCrumb(title) {
  $('#crumb-title').textContent = (state.folder ? state.folder + ' / ' : '') + title;
}
function renderFolderList(list, notes, query, makeNote) {
  for (const folder of folderState.items) {
    const children = notes.filter(note => note.folder === folder.name);
    if (query && !children.length && !folder.locked) continue;
    const expanded = !folder.locked && (Boolean(query) || folderState.expanded.has(folder.name));
    const group = document.createElement('div');
    group.className = 'folder-group';
    group.dataset.folder = folder.name;
    const row = document.createElement('div');
    row.className = 'folder-row';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'folder-toggle';
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', `${folder.locked ? '解锁' : expanded ? '收起' : '展开'}文件夹 ${folder.name}`);
    toggle.innerHTML = `<span class="folder-chevron${expanded ? ' expanded' : ''}">${folderIcon('chevron')}</span><span class="folder-symbol">${folderIcon(expanded ? 'open' : 'folder')}</span><span class="folder-name">${escapeHTML(folder.name)}</span>${folder.protected ? folderIcon('lock') : ''}`;
    toggle.onclick = async () => {
      if (loading || state.saving || folderState.busy) return;
      if (folder.locked) {
        if (!await unlockFolderUI(folder)) return;
      } else if (folderState.expanded.has(folder.name)) folderState.expanded.delete(folder.name);
      else folderState.expanded.add(folder.name);
      searchNotes().catch(error => showNotice(error.message));
    };
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'icon-button folder-settings';
    settings.setAttribute('aria-label', `${folder.name}设置`);
    settings.innerHTML = folderIcon('more');
    settings.onclick = () => editFolder(folder).catch(error => showNotice(error.message));
    row.append(toggle, settings);
    group.append(row);
    if (expanded) {
      const inner = document.createElement('div');
      inner.className = 'folder-children';
      for (const note of children) inner.append(makeNote(note));
      if (!children.length) {
        const empty = document.createElement('div');
        empty.className = 'folder-empty'; empty.textContent = '空文件夹 · 可拖入笔记'; inner.append(empty);
      }
      group.append(inner);
    }
    bindFolderDrop(row, folder);
    list.append(group);
  }
  for (const note of notes.filter(note => !note.folder)) list.append(makeNote(note));
}
function bindNoteDrag(button, note) {
  button.draggable = true;
  button.dataset.noteId = note.id;
  button.addEventListener('dragstart', event => {
    if (loading || state.saving || folderState.busy) { event.preventDefault(); return; }
    event.dataTransfer.setData('application/x-online-md-note', note.id);
    event.dataTransfer.effectAllowed = 'move';
    document.body.classList.add('dragging-note');
  });
  button.addEventListener('dragend', () => {
    document.body.classList.remove('dragging-note');
    document.querySelectorAll('.folder-dropover').forEach(el => el.classList.remove('folder-dropover'));
  });
}
function bindFolderDrop(element, folder) {
  element.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-online-md-note')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('folder-dropover');
  });
  element.addEventListener('dragleave', event => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('folder-dropover');
  });
  element.addEventListener('drop', event => {
    element.classList.remove('folder-dropover');
    const id = event.dataTransfer.getData('application/x-online-md-note');
    if (!id) return;
    event.preventDefault(); event.stopPropagation();
    document.body.classList.remove('dragging-note');
    moveNoteToFolder(id, folder).catch(error => showNotice(error.message));
  });
}
function folderDialogError(error) {
  $('#folder-error').textContent = error.message;
  $('#folder-error').hidden = false;
}
function folderDialogBusy(busy) {
  $('#folder-dialog').querySelectorAll('button,input,select').forEach(el => { el.disabled = busy; });
  $('#folder-dialog').oncancel = event => { if (busy) event.preventDefault(); };
}
function folderDialogShell(title, fields, submitLabel) {
  const dialog = $('#folder-dialog');
  dialog.innerHTML = `<form id="folder-form"><h2 id="folder-heading">${escapeHTML(title)}</h2>${fields}<p id="folder-error" role="alert" hidden></p><div class="dialog-actions"><button type="button" id="folder-cancel">取消</button><button class="primary" id="folder-confirm" type="submit">${submitLabel}</button></div></form>`;
  $('#folder-cancel').onclick = () => dialog.close();
  dialog.showModal();
  return dialog;
}
async function unlockFolderUI(folder) {
  if (!folder.locked) return true;
  if ($('#folder-dialog').open) return false;
  return new Promise(resolve => {
    const dialog = folderDialogShell(`解锁「${folder.name}」`, '<p>输入密码后访问文件夹内的笔记。</p><label for="folder-password">访问密码</label><input id="folder-password" type="password" autocomplete="off">', '解锁');
    let succeeded = false;
    dialog.onclose = () => resolve(succeeded);
    $('#folder-form').onsubmit = async event => {
      event.preventDefault(); folderDialogBusy(true);
      try {
        await api(folderURL(folder.name) + '/unlock', folderJSON('POST', { password: $('#folder-password').value }));
        await refreshNotes();
        folderState.expanded.add(folder.name);
        succeeded = true; dialog.close();
      } catch (error) { folderDialogError(error); }
      finally { folderDialogBusy(false); }
    };
  });
}
async function editFolder(folder = null) {
  if (loading || state.saving || folderState.busy || $('#folder-dialog').open) return;
  if (folder?.locked) {
    if (!await unlockFolderUI(folder)) return;
    folder = folderState.items.find(item => item.name === folder.name);
  }
  const existing = Boolean(folder?.protected);
  const fields = `<label for="folder-name">文件夹名称</label><input id="folder-name" value="${escapeHTML(folder?.name || '')}" required autocomplete="off"><label class="folder-check"><input id="folder-protect" type="checkbox" ${existing ? 'checked' : ''}>设置访问密码</label><div id="folder-password-area">${existing ? '<label class="folder-check"><input id="folder-change-password" type="checkbox">修改密码</label>' : ''}<div id="folder-password-input"><label for="folder-password">访问密码</label><input id="folder-password" type="password" autocomplete="new-password"><button type="button" id="folder-show-password">显示密码</button><p>不限制长度或字符组合。密码明文保存在此目录的 .pwd 文件中，供服务器端找回。</p></div></div><p>文件夹对应服务器上的同名目录。启用密码后，其中笔记的公开分享暂停访问。</p>${existing ? '<button type="button" id="folder-lock" class="folder-lock-button">重新锁定文件夹</button>' : ''}`;
  const dialog = folderDialogShell(folder ? '文件夹设置' : '新建文件夹', fields, folder ? '保存' : '创建');
  const updatePasswordField = () => {
    $('#folder-password-area').hidden = !$('#folder-protect').checked;
    $('#folder-password-input').hidden = existing && !$('#folder-change-password').checked;
  };
  updatePasswordField();
  $('#folder-protect').onchange = updatePasswordField;
  if (existing) $('#folder-change-password').onchange = updatePasswordField;
  $('#folder-show-password').onclick = () => {
    const field = $('#folder-password'); field.type = field.type === 'password' ? 'text' : 'password';
    $('#folder-show-password').textContent = field.type === 'password' ? '显示密码' : '隐藏密码';
  };
  if (existing) $('#folder-lock').onclick = async () => {
    // Close before the unsaved-changes dialog so focus and Escape remain predictable.
    dialog.close();
    try { await lockFolderUI(folder); } catch (error) { showNotice(error.message); }
  };
  $('#folder-form').onsubmit = async event => {
    event.preventDefault(); folderDialogBusy(true); folderState.busy = true;
    const name = $('#folder-name').value;
    const keepPassword = existing && $('#folder-protect').checked && !$('#folder-change-password').checked;
    const password = $('#folder-protect').checked && !keepPassword ? $('#folder-password').value : null;
    try {
      await api(folder ? folderURL(folder.name) : '/api/folders', folderJSON(folder ? 'PUT' : 'POST', { name, password, keepPassword }));
      if (state.folder === folder?.name) state.folder = name;
      if (folder) folderState.expanded.delete(folder.name);
      folderState.expanded.add(name);
      await refreshNotes();
      updateFolderCrumb($('#title').value || '新便签');
      dialog.close();
    } catch (error) { folderDialogError(error); }
    finally { folderDialogBusy(false); folderState.busy = false; }
  };
}
async function lockFolderUI(folder) {
  if (folderState.busy || loading || state.saving) return;
  if (state.folder === folder.name && !await allowLeave()) return;
  folderState.busy = true;
  setLoading(true);
  try {
    await api(folderURL(folder.name) + '/lock', { method: 'POST' });
    if (state.folder === folder.name) {
      clearPendingImages(); state.current = null; state.folder = ''; state.dirty = false;
      $('#title').value = ''; contentEditor.setValue('', true); state.saved = { title: '', content: '' };
      $('#delete-note').disabled = true; updateFolderCrumb('新便签'); setSavedState('草稿');
      $('#share-dialog').close();
    }
    folderState.expanded.delete(folder.name);
    await refreshNotes();
  } finally { folderState.busy = false; setLoading(false); }
}
async function moveNoteToFolder(id, folder) {
  if (loading || state.saving || folderState.busy) return;
  const note = state.notes.find(item => item.id === id);
  if (!note || (note.folder || '') === (folder?.name || '')) return;
  if (id === state.current && !await allowLeave()) return;
  if (folder?.locked && !await unlockFolderUI(folder)) return;
  folderState.busy = true;
  setLoading(true);
  try {
    const moved = await api(`/api/notes/${id}/folder`, folderJSON('PUT', { folder: folder?.name || '' }));
    if (folder) folderState.expanded.add(folder.name);
    if (id === state.current) {
      state.folder = moved.folder;
      // Reload after a possible discard of unsaved changes.
      await loadNote(id);
    }
    await refreshNotes();
    showNotice(folder ? `已移入「${folder.name}」` : '已移出文件夹');
  } finally { folderState.busy = false; setLoading(false); }
}
function openMoveDialog() {
  if (loading || state.saving || folderState.busy || !state.current || $('#folder-dialog').open) return;
  const options = [{ name: '', label: '我的笔记（文件夹外）' }, ...folderState.items.map(f => ({ name: f.name, label: f.name + (f.locked ? ' · 需要解锁' : '') }))];
  const dialog = folderDialogShell('移动笔记', `<label for="folder-destination">移动到</label><select id="folder-destination">${options.map(f => `<option value="${escapeHTML(f.name)}" ${state.folder === f.name ? 'selected' : ''}>${escapeHTML(f.label)}</option>`).join('')}</select>`, '移动');
  $('#folder-form').onsubmit = async event => {
    event.preventDefault();
    const folder = folderState.items.find(f => f.name === $('#folder-destination').value);
    dialog.close();
    try { await moveNoteToFolder(state.current, folder); } catch (error) { showNotice(error.message); }
  };
}
function initFolderUI() {
  $('#new-folder').innerHTML = folderIcon('folderplus');
  $('#new-folder').onclick = () => editFolder().catch(error => showNotice(error.message));
  $('#move-note').onclick = openMoveDialog;
  bindFolderDrop($('#folder-root-drop'), null);
}
