// Folder UI extends the existing note list; all storage and access checks live on the server.
const folderState = { items: [], expanded: new Set(), busy: false, drag: null };
const folderIcons = {
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  open: '<path d="M3 10V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2"/><path d="M5 10h16l-3 10H3L1 10Z"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  unlock: '<path d="M8 10V7a4 4 0 0 1 7-2"/><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M12 14v3"/>',
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
  for (const note of notes.filter(note => !note.folder)) list.append(makeNote(note));
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
    toggle.innerHTML = `<span class="folder-chevron${expanded ? ' expanded' : ''}">${folderIcon('chevron')}</span><span class="folder-symbol">${folderIcon(expanded ? 'open' : 'folder')}</span><span class="folder-name">${escapeHTML(folder.name)}</span>${folder.protected && folder.locked ? folderIcon('lock') : ''}`;
    toggle.onclick = async () => {
      if (loading || state.saving || folderState.busy || folderSession.busy) return;
      try {
        if (folder.locked) { await unlockFolderUI(folder); return; }
        if (folder.protected && folderState.expanded.has(folder.name)) { await lockFolderUI(folder); return; }
        if (!await beforeFolderAccess(folder)) return;
        if (folderSession.drafts.has(folder.name)) await restoreFolderDraft(folder);
        if (folderState.expanded.has(folder.name)) folderState.expanded.delete(folder.name);
        else folderState.expanded.add(folder.name);
        await searchNotes();
      } catch (error) { showNotice(error.message); }
    };
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'icon-button folder-settings';
    settings.setAttribute('aria-label', `${folder.name}设置`);
    settings.innerHTML = folderIcon('more');
    settings.onclick = () => editFolder(folder).catch(error => showNotice(error.message));
    row.append(toggle);
    if (folder.protected && !folder.locked) {
      const lock = document.createElement('button'); lock.className = 'icon-button folder-lock-now'; lock.innerHTML = folderIcon('unlock');
      lock.title = '已解锁，点击锁定'; lock.setAttribute('aria-label', `锁定文件夹 ${folder.name}`);
      lock.onclick = () => lockFolderUI(folder).catch(error => showNotice(error.message)); row.append(lock);
    }
    row.append(settings);
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
    bindFolderDrop(group, folder, event => !event.target.closest('.note-item')
      && folderState.drag?.item.dataset.noteId
      && folderState.drag.parent !== group.querySelector('.folder-children'));
    bindFolderSort(row, folder);
    list.append(group);
  }
}
function bindNoteDrag(button, note) {
  button.draggable = true;
  button.dataset.noteId = note.id;
  button.addEventListener('dragstart', event => {
    if (loading || state.saving || folderState.busy) { event.preventDefault(); return; }
    startSortDrag(note.id, button);
    event.dataTransfer.setData('application/x-online-md-note', note.id);
    event.dataTransfer.effectAllowed = 'move';
  });
  button.addEventListener('dragend', () => clearSortDrag());
  bindNoteSort(button, note);
}
function bindFolderDrop(element, folder, accepts) {
  element.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-online-md-note') || !accepts(event)) {
      element.classList.remove('folder-dropover');
      return;
    }
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; element.classList.add('folder-dropover');
  });
  element.addEventListener('dragleave', event => {
    if (!element.contains(event.relatedTarget)) element.classList.remove('folder-dropover');
  });
  element.addEventListener('drop', event => {
    element.classList.remove('folder-dropover');
    const id = event.dataTransfer.getData('application/x-online-md-note');
    if (!id || !accepts(event)) return;
    event.preventDefault(); event.stopPropagation();
    clearSortDrag();
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
async function unlockFolderUI(folder, options = {}) {
  if (!folder.locked) return true;
  if ($('#folder-dialog').open || folderSession.busy) return false;
  if (!options.forMove && !await beforeFolderAccess(folder)) return false;
  return new Promise(resolve => {
    const dialog = folderDialogShell(`解锁「${folder.name}」`, '<p>输入密码后访问文件夹内的笔记。</p><label for="folder-password">访问密码</label><input id="folder-password" type="password" autocomplete="off">', '解锁');
    let succeeded = false;
    dialog.onclose = () => { if (!dialog.open) resolve(succeeded); };
    $('#folder-form').onsubmit = async event => {
      event.preventDefault(); folderDialogBusy(true);
      try {
        await api(folderURL(folder.name) + '/unlock', folderJSON('POST', { password: $('#folder-password').value }));
        folderSession.lastActivity = Date.now(); armFolderIdleTimer();
        await refreshNotes();
        folderState.expanded.add(folder.name);
        folder.locked = false;
        if (!options.forMove) await restoreFolderDraft(folder);
        await searchNotes();
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
  if (window.noteHost?.localMode) {
    $('#folder-protect').disabled = true;
    $('#folder-protect').closest('label').hidden = true;
    $('#folder-password-area').nextElementSibling.textContent = '本地文件夹保存在此浏览器，不支持访问密码。';
  }
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
    event.preventDefault();
    const name = $('#folder-name').value;
    const keepPassword = existing && $('#folder-protect').checked && !$('#folder-change-password').checked;
    const password = $('#folder-protect').checked && !keepPassword ? $('#folder-password').value : null;
    if (folder && state.folder === folder.name && $('#folder-protect').checked && state.dirty) {
      dialog.close(); const allowed = await allowLeave(); dialog.showModal(); if (!allowed) return;
    }
    folderDialogBusy(true); folderState.busy = true;
    try {
      const savedFolder = await api(folder ? folderURL(folder.name) : '/api/folders', folderJSON(folder ? 'PUT' : 'POST', { name, password, keepPassword }));
      const active = folder && state.folder === folder.name;
      if (folderSession.drafts.has(folder?.name)) { const draft = folderSession.drafts.get(folder.name); folderSession.drafts.delete(folder.name); folderSession.drafts.set(name, draft); }
      if (active) {
        state.folder = name;
        if (readLastNote()?.id === state.current) rememberCurrentNote();
      }
      if (active && savedFolder.locked) resetProtectedEditor(name, true);
      if (folder) folderState.expanded.delete(folder.name);
      if (!savedFolder.locked) folderState.expanded.add(name);
      await refreshNotes();
      updateFolderCrumb($('#title').value || '新便签');
      dialog.close();
      if (savedFolder.warning) showNotice(savedFolder.warning);
    } catch (error) { markDirty(); folderDialogError(error); }
    finally { folderDialogBusy(false); folderState.busy = false; }
  };
}
async function lockFolderUI(folder) {
  if (folderState.busy || loading || state.saving || folderSession.busy) return;
  if (state.folder === folder.name && !await allowLeave()) return;
  folderState.busy = true; setLoading(true);
  try {
    await lockFolderPermissions(folder);
    if (state.folder === folder.name) resetProtectedEditor(folder.name);
    await refreshNotes();
  } finally { folderState.busy = false; setLoading(false); }
}
async function moveNoteToFolder(id, folder) {
  if (loading || state.saving || folderState.busy) return;
  const note = state.notes.find(item => item.id === id);
  if (!note || (note.folder || '') === (folder?.name || '')) return;
  if (id === state.current && !await allowLeave()) return;
  if (folder?.locked && !await unlockFolderUI(folder, { forMove: true })) return;
  folderState.busy = true;
  setLoading(true);
  try {
    const oldFolder = folderState.items.find(f => f.name === note.folder && f.protected);
    const moved = await api(`/api/notes/${id}/folder`, folderJSON('PUT', { folder: folder?.name || '' }));
    if (folder) folderState.expanded.add(folder.name);
    if (id === state.current) {
      state.folder = moved.folder;
      // Reload after a possible discard of unsaved changes.
      if (oldFolder && oldFolder.name !== moved.folder) await lockFolderPermissions(oldFolder);
      await loadNote(id);
    }
    await refreshNotes();
    showNotice(moved.cleanupWarning || (folder ? `已移入「${folder.name}」` : '已移出文件夹'));
    return true;
  } finally { folderState.busy = false; setLoading(false); }
}
function initFolderUI() {
  $('#new-folder').innerHTML = folderIcon('folderplus');
  $('#new-folder').onclick = () => editFolder().catch(error => showNotice(error.message));
  const list = $('#note-list');
  bindFolderDrop(list, null, event => event.target === list
    && folderState.drag?.item.parentElement.matches('.folder-children')
    && !$('#note-search').value.trim());
  document.addEventListener('dragover', event => scrollSidebarDuringDrag(list, event));
  document.addEventListener('dragleave', event => {
    if (!event.relatedTarget && !list.matches(':hover') && folderState.drag) folderState.drag.scrollSpeed = 0;
  });
}
function scrollSidebarDuringDrag(list, event) {
  const drag = folderState.drag;
  if (!drag) return;
  const { top, bottom, left, right, height } = list.getBoundingClientRect();
  const { clientX: x, clientY: y } = event;
  const edge = Math.min(56, height / 3);
  drag.scrollSpeed = 0;
  if (!edge || x < left || x > right || y < top || y > bottom) return;
  if (y < top + edge) drag.scrollSpeed = -420 * (1 - (y - top) / edge);
  if (y > bottom - edge) drag.scrollSpeed = 420 * (1 - (bottom - y) / edge);
  if (!drag.scrollSpeed || drag.scrollFrame) return;

  let previous = performance.now();
  let remainder = 0;
  const scroll = now => {
    drag.scrollFrame = 0;
    if (!drag.scrollSpeed || folderState.drag !== drag) return;
    if (drag.scrollSpeed < 0 ? list.scrollTop <= 0 : list.scrollTop >= list.scrollHeight - list.clientHeight - 1) return;
    const distance = drag.scrollSpeed * Math.min(now - previous, 32) / 1000 + remainder;
    const pixels = Math.trunc(distance);
    remainder = distance - pixels;
    previous = now;
    list.scrollTop += pixels;
    drag.scrollFrame = requestAnimationFrame(scroll);
  };
  drag.scrollFrame = requestAnimationFrame(scroll);
}
function startSortDrag(id, item) {
  const drag = { id, item, parent: item.parentElement, next: item.nextElementSibling, animations: new Map() };
  folderState.drag = drag;
  // Let the browser capture the native drag image before styling the placeholder.
  requestAnimationFrame(() => {
    if (folderState.drag === drag) item.classList.add('sort-source');
  });
}
function clearSortDrag(restore = true) {
  const drag = folderState.drag;
  folderState.drag = null;
  if (drag) {
    cancelAnimationFrame(drag.scrollFrame);
    for (const animation of drag.animations.values()) animation.cancel();
    drag.item.classList.remove('sort-source');
    if (restore === true && drag.item.parentElement === drag.parent && drag.item.nextElementSibling !== drag.next) {
      drag.parent.insertBefore(drag.item, drag.next);
    }
  }
  document.querySelectorAll('.folder-dropover').forEach(el => el.classList.remove('folder-dropover'));
}
function sortDropPosition(element, event) { const box = element.getBoundingClientRect(); return event.clientY < box.top + box.height / 2 ? 'before' : 'after'; }
function previewSortPosition(item, event, hitbox = item) {
  const drag = folderState.drag;
  if (!drag || item === drag.item || item.parentElement !== drag.parent || $('#note-search').value.trim()) return;
  if (drag.animations.has(item)) return;
  const next = sortDropPosition(hitbox, event) === 'before' ? item : item.nextElementSibling;
  if (next === drag.item || next === drag.item.nextElementSibling) return;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const positions = reduceMotion ? [] : [...drag.parent.children]
    .filter(peer => peer !== drag.item)
    .map(peer => [peer, peer.getBoundingClientRect().top]);
  drag.parent.insertBefore(drag.item, next);
  for (const [peer, top] of positions) {
    const previous = drag.animations.get(peer);
    previous?.cancel();
    drag.animations.delete(peer);
    const offset = top - peer.getBoundingClientRect().top;
    if (!offset) continue;
    const animation = peer.animate([{ translate: `0 ${offset}px` }, { translate: '0 0' }], { duration: 150, easing: 'ease-out' });
    drag.animations.set(peer, animation);
    animation.onfinish = () => drag.animations.delete(peer);
  }
}
async function saveSidebarSort(kind, id, before, folder = '') {
  if ($('#note-search').value.trim()) { showNotice('请清空搜索后调整排序'); return; }
  folderState.busy = true;
  try { await api('/api/order', folderJSON('PUT', { kind, id, before, folder })); await refreshNotes(); }
  finally { folderState.busy = false; }
}
function bindFolderSort(row, folder) {
  row.draggable = true;
  row.addEventListener('dragstart', event => {
    if (loading || state.saving || folderState.busy || $('#note-search').value.trim()) { event.preventDefault(); return; }
    startSortDrag(folder.name, row.parentElement);
    event.dataTransfer.setData('application/x-online-md-folder', folder.name); event.dataTransfer.effectAllowed = 'move';
  });
  row.addEventListener('dragend', () => clearSortDrag());
  row.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-online-md-folder')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; previewSortPosition(row.parentElement, event, row);
  });
  row.addEventListener('drop', event => {
    const id = event.dataTransfer.getData('application/x-online-md-folder'); if (!id) return;
    event.preventDefault(); event.stopPropagation();
    const drag = folderState.drag;
    if (!drag || drag.id !== id) return;
    const before = drag.item.nextElementSibling?.dataset.folder || '';
    const changed = drag.item.nextElementSibling !== drag.next;
    clearSortDrag(false);
    if (changed) saveSidebarSort('folder', id, before).catch(async error => {
      await searchNotes({ localOnly: true });
      showNotice(error.message);
    });
  });
}
function bindNoteSort(button, note) {
  button.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('application/x-online-md-note')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move'; previewSortPosition(button, event);
  });
  button.addEventListener('drop', async event => {
    const id = event.dataTransfer.getData('application/x-online-md-note'); if (!id) return;
    event.preventDefault(); event.stopPropagation();
    const source = state.notes.find(n => n.id === id);
    const drag = folderState.drag;
    if (drag?.id === id && drag.parent === button.parentElement && !$('#note-search').value.trim()) {
      const before = drag.item.nextElementSibling?.dataset.noteId || '';
      const changed = drag.item.nextElementSibling !== drag.next;
      clearSortDrag(false);
      if (changed) {
        try { await saveSidebarSort('note', id, before, note.folder || ''); }
        catch (error) { await searchNotes({ localOnly: true }); showNotice(error.message); }
      }
      return;
    }
    const peers = state.notes.filter(n => (n.folder || '') === (note.folder || '') && n.id !== id).map(n => n.id);
    const index = peers.indexOf(note.id); const before = sortDropPosition(button, event) === 'before' ? note.id : peers[index + 1] || '';
    clearSortDrag(); if (!source || id === note.id || loading || state.saving || folderState.busy) return;
    if ($('#note-search').value.trim()) { showNotice('请清空搜索后调整排序'); return; }
    try {
      if ((source.folder || '') !== (note.folder || '')) {
        const target = folderState.items.find(f => f.name === note.folder);
        if (!await moveNoteToFolder(id, target)) return;
      }
      await saveSidebarSort('note', id, before, note.folder || '');
    } catch (error) { showNotice(error.message); }
  });
}
