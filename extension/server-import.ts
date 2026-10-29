import { parser } from '@lezer/markdown';
import { localSnapshot, importProgress, finishImport, type LocalNote, type Asset } from './local-store';

type Target = { baseURL: string; token: string };
const element = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const managedAsset = /^(?:\/api\/notes\/([a-f0-9]{32})\/)?assets\/([a-f0-9]{32}\.(?:png|jpg|gif|webp))$/;
async function assetName(key: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(hash)).map(n => n.toString(16).padStart(2, '0')).join('').slice(0, 32) + '.' + key.split('.').pop();
}
type Destination = { from: number; to: number; value: string };
function destinations(content: string) {
  const result: Destination[] = [];
  const decode = (value: string) => {
    const textarea = document.createElement('textarea'); textarea.innerHTML = value;
    return textarea.value.replace(/\\([/.'"()<>])/g, '$1');
  };
  parser.parse(content).iterate({ enter(node) {
    if (node.name === 'URL') {
      let from = node.from, to = node.to;
      if (content[from] === '<' && content[to - 1] === '>') { from++; to--; }
      result.push({ from, to, value: decode(content.slice(from, to)) });
    }
    if (node.name === 'HTMLTag' || node.name === 'HTMLBlock') {
      const html = content.slice(node.from, node.to);
      // Skip comments and raw script/style text; only real media/link tags are
      // candidates. Source ranges preserve the rest of the user's HTML exactly.
      const tags = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<([a-z][a-z0-9:_-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
      for (const tag of html.matchAll(tags)) {
        if (!tag[2]) continue;
        const tagName = tag[2].toLowerCase();
        if (!['img', 'a', 'video', 'source'].includes(tagName)) continue;
        const attributes = /[\t\n\f\r ]+([^\t\n\f\r "'<>/=]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/g;
        const seen = new Set<string>();
        for (const attr of tag[0].matchAll(attributes)) {
          const name = attr[1].toLowerCase();
          if (seen.has(name)) continue;
          seen.add(name);
          if (!(tagName === 'a' ? name === 'href' : name === 'src' || (tagName === 'video' && name === 'poster'))) continue;
          const raw = attr[2] ?? attr[3] ?? attr[4];
          if (raw === undefined) continue;
          const offset = attr[0].search(/=\s*/) + attr[0].match(/=\s*/)![0].length + (attr[2] !== undefined || attr[3] !== undefined ? 1 : 0);
          const from = node.from + tag.index! + attr.index! + offset;
          result.push({ from, to: from + raw.length, value: decode(raw) });
        }
      }
    }
  } });
  return result;
}
async function importBody(note: LocalNote, assets: Asset[], serverID: string) {
  const edits: (Destination & { replacement: string })[] = [];
  const attached = new Map<string, Blob>();
  const names = new Map<string, string>();
  const byKey = new Map(assets.map(asset => [asset.key, asset.blob]));
  for (const destination of destinations(note.content)) {
    const match = managedAsset.exec(destination.value);
    if (!match) continue;
    const key = (match[1] || note.id) + '/' + match[2];
    const asset = byKey.get(key);
    if (!asset) throw new Error('本地笔记缺少图片，请修复附件或从完整备份恢复后再导入');
    const name = names.get(key) || await assetName(key); names.set(key, name);
    edits.push({ ...destination, replacement: 'assets/' + name }); attached.set(name, asset);
  }
  const chunks: string[] = []; let offset = 0;
  for (const edit of edits.sort((a, b) => a.from - b.from)) {
    chunks.push(note.content.slice(offset, edit.from), edit.replacement); offset = edit.to;
  }
  chunks.push(note.content.slice(offset));
  const content = chunks.join('');
  const body = new FormData();
  body.append('note', JSON.stringify({ serverID, title: note.title, folder: note.folder }));
  body.append('content', new Blob([content], { type: 'text/plain;charset=utf-8' }), 'note.md');
  for (const [name, blob] of attached) body.append(name, blob, name);
  return body;
}

export async function openServerImport(target: Target, isCurrent: () => boolean, onUpdated: () => Promise<void>) {
  const dialog = element<HTMLDialogElement>('#server-import-dialog');
  const confirm = element<HTMLButtonElement>('#confirm-server-import');
  const close = element<HTMLButtonElement>('#close-server-import');
  const all = element<HTMLInputElement>('#select-all-import');
  const list = element('#server-import-list');
  const status = element('#server-import-status');
  const message = (text: string) => { status.textContent = text; };
  let activeRequest: AbortController | undefined;
  const request = async (path: string, options: RequestInit = {}) => {
    if (!isCurrent()) throw new Error('服务器连接已切换，请重新打开导入窗口');
    const controller = new AbortController(); activeRequest = controller;
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(target.baseURL + path, { ...options, headers: { Authorization: 'Bearer ' + target.token }, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (!isCurrent()) throw new Error('服务器连接已切换，请重新打开导入窗口');
      if (!response.ok) {
        let detail; try { detail = (await response.json()).error; } catch {}
        throw new Error(detail || (response.status === 401 ? '登录已过期，请重新连接服务器' : response.status === 404 ? '服务器不支持导入，请先升级后端' : response.status === 413 ? '服务器或反向代理拒绝导入大小，请调整上传限制' : `导入失败（HTTP ${response.status}）`));
      }
      return await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw new Error('请求已取消或超时');
      if (error instanceof TypeError) throw new Error('无法连接服务器，请检查网络后重试');
      throw error;
    } finally { clearTimeout(timer); activeRequest = undefined; }
  };
  element('#server-import-target').textContent = target.baseURL;
  list.replaceChildren(); message('正在读取本地笔记与目标服务器…');
  confirm.disabled = true; all.checked = false; all.disabled = true; close.disabled = false;
  dialog.showModal();
  let running = false;
  const closed = new Promise<void>(resolve => { dialog.onclose = () => { activeRequest?.abort(); resolve(); }; });
  close.onclick = () => { if (!running) dialog.close(); };
  dialog.oncancel = event => { if (running) event.preventDefault(); };
  try {
    const [snapshot, info] = await Promise.all([localSnapshot(), request('/api/import/info')]);
    if (!dialog.open) return;
    if (info.importAPI !== 1 || !/^[a-f0-9]{32}$/.test(info.serverID)) throw new Error('服务器不支持导入，请先升级后端');
    const choices = snapshot.notes.map(note => {
      const label = document.createElement('label'); label.className = 'server-import-choice';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = note.id;
      label.append(checkbox, document.createTextNode((note.folder ? note.folder + ' / ' : '') + note.title)); list.append(label);
      return { note, checkbox };
    });
    const updateSelection = () => {
      const count = choices.filter(choice => choice.checkbox.checked).length;
      all.checked = count > 0 && count === choices.length; all.indeterminate = count > 0 && count < choices.length;
      confirm.disabled = count === 0; confirm.textContent = `导入所选 ${count} 篇`;
    };
    for (const choice of choices) choice.checkbox.onchange = updateSelection;
    all.disabled = !choices.length;
    all.onchange = () => { for (const choice of choices) choice.checkbox.checked = all.checked; updateSelection(); };
    message(choices.length ? '请选择要导入的笔记。已保存版本会复制到目标服务器，本地原件保留；重复操作会跳过同一版本。' : '没有可导入的本地笔记。');
    updateSelection();
    confirm.onclick = async () => {
      if (running) return;
      const selected = choices.filter(choice => choice.checkbox.checked);
      if (!selected.length) return;
      running = true; confirm.disabled = true; close.disabled = true; all.disabled = true;
      for (const choice of choices) choice.checkbox.disabled = true;
      let completed = 0;
      try {
        for (const { note } of selected) {
          message(`正在导入 ${completed + 1}/${selected.length}：${note.title}`);
          const progress = await importProgress(JSON.stringify([target.baseURL, info.serverID, note.id, note.version, note.folder]));
          if (!progress.done) {
            const body = await importBody(note, snapshot.assets, info.serverID);
            const result = await request('/api/import/notes/' + progress.remoteID, { method: 'POST', body });
            if (result.id !== progress.remoteID) throw new Error('服务器导入结果无效，请重试');
            await finishImport(progress);
          }
          completed++;
        }
        message(`已完成 ${completed}/${selected.length} 篇，本地原件已保留。相同版本不会重复导入。`);
        try { await onUpdated(); } catch { message(`已完成 ${completed} 篇；服务器列表刷新失败，请重新打开笔记。`); }
      } catch (error) {
        message(`已完成 ${completed}/${selected.length} 篇；${error instanceof Error ? error.message : '导入失败'}。本地原件保留，再次点击可重试。`);
      } finally {
        running = false; close.disabled = false; all.disabled = false;
        for (const choice of choices) choice.checkbox.disabled = false;
        updateSelection();
      }
    };
    await closed;
  } catch (error) { message(error instanceof Error ? error.message : '无法打开导入'); await closed; }
}
