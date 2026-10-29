// A transaction is the unit of a local edit: concurrent windows cannot overwrite
// a newer revision after reading an older one.
type LocalNote = { id: string; title: string; content: string; folder: string; updatedAt: string; version: string; rank?: number };
type LocalFolder = { name: string; protected: false; locked: false; rank?: number };
type Asset = { key: string; blob: Blob };
const LIMIT = 200 * 1024 * 1024;
const id = () => crypto.randomUUID().replaceAll('-', '');
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
let database: Promise<IDBDatabase> | undefined;
function open() {
  return database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('jianji-local', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('notes', { keyPath: 'id' });
      request.result.createObjectStore('folders', { keyPath: 'name' });
      request.result.createObjectStore('assets', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(request.error); };
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>) {
  const db = await open();
  const tx = db.transaction(['notes', 'folders', 'assets'], mode);
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || new Error('本地保存已取消')); tx.onerror = () => {}; });
  try { const result = await action(tx); await done; return result; }
  catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
}
function validFolder(name: unknown): name is string {
  return typeof name === 'string' && name.trim() === name && Boolean(name) && !name.startsWith('.') && !/[\\/\x00-\x1f\x7f]/.test(name) && new TextEncoder().encode(name).length <= 255;
}
const titleOf = (value: unknown) => typeof value === 'string' ? value.trim() || '未命名笔记' : '未命名笔记';
function validateNote(note: LocalNote) {
  if (!/^[a-f0-9]{32}$/.test(note.id) || typeof note.title !== 'string' || [...note.title].length > 200 || typeof note.content !== 'string' || new TextEncoder().encode(note.content).length > 16 * 1024 * 1024 || typeof note.folder !== 'string' || (note.folder && !validFolder(note.folder)) || !Number.isFinite(Date.parse(note.updatedAt))) throw new Error('笔记数据无效或超过大小上限');
}
function size(notes: LocalNote[], assets: Asset[]) {
  return new TextEncoder().encode(JSON.stringify(notes)).length + assets.reduce((sum, asset) => sum + asset.blob.size, 0);
}
export async function localRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const url = new URL(path, 'https://local.invalid');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = options.method || 'GET';
  const mutating = method !== 'GET';
  try {
    return await transaction(mutating ? 'readwrite' : 'readonly', async tx => {
      const ns = tx.objectStore('notes'), fs = tx.objectStore('folders'), as = tx.objectStore('assets');
      const notes = (await read<LocalNote[]>(ns.getAll())).sort((a, b) => (a.rank ?? -Date.parse(a.updatedAt)) - (b.rank ?? -Date.parse(b.updatedAt)));
      const folders = (await read<LocalFolder[]>(fs.getAll())).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.name.localeCompare(b.name));
      const assets = await read<Asset[]>(as.getAll());
      const input = typeof options.body === 'string' ? JSON.parse(options.body) : {};
      if (parts[1] === 'order' && method === 'PUT') {
        const isFolder = input.kind === 'folder';
        if (!isFolder && input.kind !== 'note') return json({ error: '排序类型无效' }, 400);
        const items = isFolder ? folders : notes.filter(n => n.folder === (input.folder || ''));
        const key = (item: LocalFolder | LocalNote) => 'id' in item ? item.id : item.name;
        const moved = items.find(item => key(item) === input.id);
        if (!moved || (input.before && !items.some(item => key(item) === input.before))) return json({ error: '排序目标不存在' }, 400);
        const rest = items.filter(item => key(item) !== input.id);
        rest.splice(input.before ? rest.findIndex(item => key(item) === input.before) : rest.length, 0, moved);
        rest.forEach((item, rank) => (isFolder ? fs : ns).put({ ...item, rank }));
        return json({ ok: true });
      }
      if (parts[1] === 'notes') {
        if (parts.length === 2) {
          if (method === 'GET') {
            const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
            return json(notes.filter(n => !query || (n.title + '\n' + n.content).toLocaleLowerCase().includes(query)).map(({ content, ...summary }) => summary));
          }
          if (method === 'POST') {
            const note: LocalNote = { id: id(), title: titleOf(input.title), content: input.content || '', folder: '', updatedAt: new Date().toISOString(), version: id() };
            validateNote(note);
            if (size([...notes, note], assets) > LIMIT) return json({ error: '本地空间超过 200 MiB，请导出备份并清理附件' }, 413);
            ns.add(note); return json(note, 201);
          }
        }
        const note = notes.find(n => n.id === parts[2]);
        if (!note) return json({ error: '笔记不存在' }, 404);
        if (parts[3] === 'assets') {
          if (method === 'GET') {
            const asset = assets.find(a => a.key === note.id + '/' + parts[4]);
            return asset ? new Response(asset.blob) : json({ error: '图片不存在' }, 404);
          }
          if (method === 'POST' && options.body instanceof Blob) {
            const blob = options.body;
            const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[blob.type];
            if (!ext) return json({ error: '仅支持 PNG、JPEG、GIF、WebP 图片' }, 415);
            if (blob.size > 10 * 1024 * 1024 || size(notes, assets) + blob.size > LIMIT) return json({ error: '单张图片最多 10 MiB，本地总空间最多 200 MiB' }, 413);
            const name = id() + '.' + ext; as.add({ key: note.id + '/' + name, blob });
            return json({ path: 'assets/' + name }, 201);
          }
        }
        if (parts[3] === 'share') return json({ error: '本地笔记不支持公开分享，请连接服务器后使用' }, 400);
        if (parts[3] === 'folder' && method === 'PUT') {
          if (input.folder && !folders.some(f => f.name === input.folder)) return json({ error: '文件夹不存在' }, 404);
          note.folder = input.folder || ''; note.version = id(); ns.put(note); return json(note);
        }
        if (parts.length === 3) {
          if (method === 'GET') return json(note);
          const expected = new Headers(options.headers).get('If-Match')?.replaceAll('"', '');
          if (expected && expected !== note.version) return json({ error: '笔记已在其他窗口修改，当前编辑内容已保留' }, 412);
          if (method === 'DELETE') { ns.delete(note.id); for (const asset of assets.filter(a => a.key.startsWith(note.id + '/'))) as.delete(asset.key); return new Response(null, { status: 204 }); }
          if (method === 'PUT') {
            const next = { ...note, title: titleOf(input.title), content: input.content, version: id(), updatedAt: new Date().toISOString() };
            validateNote(next);
            if (size(notes.map(n => n.id === next.id ? next : n), assets) > LIMIT) return json({ error: '本地空间超过 200 MiB，请导出备份并清理附件' }, 413);
            ns.put(next);
            for (const asset of assets.filter(a => a.key.startsWith(note.id + '/'))) if (note.content.includes('assets/' + asset.key.split('/')[1]) && !next.content.includes('assets/' + asset.key.split('/')[1])) as.delete(asset.key);
            return json(next);
          }
        }
      }
      if (parts[1] === 'folders') {
        if (method === 'GET') return json(folders);
        if (input.password || input.keepPassword) return json({ error: '本地模式暂不支持文件夹密码' }, 400);
        if (!validFolder(input.name)) return json({ error: '文件夹名称无效' }, 400);
        if (folders.some(f => f.name === input.name && f.name !== parts[2])) return json({ error: '同名文件夹已存在' }, 409);
        if (method === 'PUT' && !folders.some(f => f.name === parts[2])) return json({ error: '文件夹不存在' }, 404);
        const folder: LocalFolder = { ...folders.find(f => f.name === parts[2]), name: input.name, protected: false, locked: false };
        if (method === 'PUT') {
          fs.delete(parts[2]);
          for (const note of notes.filter(n => n.folder === parts[2])) ns.put({ ...note, folder: folder.name });
        }
        fs.put(folder); return json(folder);
      }
      return json({ error: '本地模式不支持此操作' }, 400);
    });
  } catch (error) { return json({ error: error instanceof Error ? error.message : '本地存储失败' }, 400); }
}

export async function exportLocal() {
  const snapshot = await transaction('readonly', async tx => ({ notes: await read<LocalNote[]>(tx.objectStore('notes').getAll()), folders: await read<LocalFolder[]>(tx.objectStore('folders').getAll()), assets: await read<Asset[]>(tx.objectStore('assets').getAll()) }));
  const assets = await Promise.all(snapshot.assets.map(async asset => {
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(asset.blob); });
    return { key: asset.key, data };
  }));
  const blob = new Blob([JSON.stringify({ format: 'jianji-local', version: 1, notes: snapshot.notes, folders: snapshot.folders, assets })], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = '简记完整备份-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function importLocal(file: File) {
  if (file.size > 300 * 1024 * 1024) throw new Error('备份文件超过 300 MiB');
  const data = JSON.parse(await file.text());
  if (data.format !== 'jianji-local' || data.version !== 1 || !Array.isArray(data.notes) || !Array.isArray(data.folders) || !Array.isArray(data.assets)) throw new Error('不是有效的简记完整备份');
  const mapping = new Map<string, string>();
  const notes: LocalNote[] = data.notes.map((note: LocalNote) => { validateNote(note); if (mapping.has(note.id)) throw new Error('备份包含重复笔记'); mapping.set(note.id, id()); return { ...note }; });
  const folders: LocalFolder[] = data.folders.map((f: LocalFolder) => { if (!validFolder(f.name)) throw new Error('备份文件夹无效'); return { name: f.name, protected: false, locked: false, ...(Number.isFinite(f.rank) ? { rank: f.rank } : {}) }; });
  const assets: Asset[] = await Promise.all(data.assets.map(async (asset: { key: string; data: string }) => {
    if (typeof asset.key !== 'string' || !/^[a-f0-9]{32}\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(asset.key) || !mapping.has(asset.key.split('/')[0]) || typeof asset.data !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(asset.data)) throw new Error('备份附件无效');
    const blob = await (await fetch(asset.data)).blob(); if (blob.size > 10 * 1024 * 1024) throw new Error('备份图片超过 10 MiB');
    return { key: mapping.get(asset.key.split('/')[0]) + '/' + asset.key.split('/')[1], blob };
  }));
  for (const note of notes) {
    note.content = note.content.replace(/\/api\/notes\/([a-f0-9]{32})\/assets\//g, (match, oldID) => mapping.has(oldID) ? '/api/notes/' + mapping.get(oldID) + '/assets/' : match);
    note.id = mapping.get(note.id)!; note.version = id();
    if (note.folder && !folders.some(f => f.name === note.folder)) throw new Error('备份缺少文件夹');
  }
  await transaction('readwrite', async tx => {
    const existing = await read<LocalNote[]>(tx.objectStore('notes').getAll());
    const oldAssets = await read<Asset[]>(tx.objectStore('assets').getAll());
    if (size([...existing, ...notes], [...oldAssets, ...assets]) > LIMIT) throw new Error('导入后超过本地 200 MiB 上限');
    const existingFolders = await read<LocalFolder[]>(tx.objectStore('folders').getAll());
    for (const folder of folders) if (!existingFolders.some(f => f.name === folder.name)) tx.objectStore('folders').add(folder);
    for (const note of notes) tx.objectStore('notes').add(note);
    for (const asset of assets) tx.objectStore('assets').add(asset);
  });
  return notes.length;
}
