import { localRequest, localTransaction, readLocal, assertLocalCapacity, validateNote, type LocalNote, type LocalFolder, type Asset, type MutationHook } from './local-store';
import { destinations } from './server-import';

type Order = { folders: string[]; notes: Record<string, string[]> };
type Structure = { folders: string[]; order: Order };
type Manifest = { syncAPI: number; serverID: string; notes: { id: string; version: string }[]; excluded: string[]; structure: Structure; structureVersion: string };
type Job = { operation: string; conflictID: string; base: string; note: LocalNote | null; assets: Asset[] };
type RecordState = { id: string; base?: string; dirty: boolean; deleted?: boolean; operation: string; conflictID: string; pending?: Job };
type Meta = { key: 'state'; structureBase?: { version: string; value: Structure }; structureDirty?: boolean; structureOperation?: string; notice?: string; initialized?: boolean };
type Bundle = { note: LocalNote; assets: Asset[] };
type Net = (path: string, options?: RequestInit) => Promise<Response>;
const randomID = () => crypto.randomUUID().replaceAll('-', '');
const stores = (tx: IDBTransaction) => ({ notes: tx.objectStore('notes'), folders: tx.objectStore('folders'), assets: tx.objectStore('assets'), sync: tx.objectStore('sync'), meta: tx.objectStore('meta') });
async function metaOf(tx: IDBTransaction): Promise<Meta> { return await readLocal(tx.objectStore('meta').get('state')) || { key: 'state' }; }
const fingerprint = (note: LocalNote | undefined | null) => note ? JSON.stringify([note.version, note.folder]) : '';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
const sameStructure = (a: Structure, b: Structure) => canonical({ ...a, folders: [...a.folders].sort() }) === canonical({ ...b, folders: [...b.folders].sort() });
class SyncError extends Error { constructor(message: string, readonly status: number) { super(message); } }

export class ServerSync {
  readonly databaseName: string;
  online = false;
  private running?: Promise<void>;
  constructor(readonly baseURL: string, readonly serverID: string, private net: Net, private report: (message: string) => void) {
    this.databaseName = 'jianji-server:' + JSON.stringify([baseURL, serverID]);
  }
  private tx<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction) => Promise<T>) { return localTransaction(mode, action, this.databaseName); }
  private changed: MutationHook = async (tx, before, path) => {
    const s = stores(tx); const notes = await readLocal<LocalNote[]>(s.notes.getAll());
    const previous = new Map(before.notes.map(note => [note.id, note]));
    const records = new Map((await readLocal<RecordState[]>(s.sync.getAll())).map(record => [record.id, record]));
    for (const note of notes) {
      if (fingerprint(note) !== fingerprint(previous.get(note.id))) {
        const record = records.get(note.id);
        s.sync.put({ ...record, id: note.id, dirty: true, deleted: false, operation: randomID(), conflictID: randomID() });
      }
      previous.delete(note.id);
    }
    for (const note of previous.values()) {
      const record = records.get(note.id);
      // A create never submitted to the server can be removed immediately.
      if (!record?.base && !record?.pending) s.sync.delete(note.id);
      else s.sync.put({ ...record, id: note.id, dirty: true, deleted: true, operation: randomID(), conflictID: randomID() });
    }
    if (path.startsWith('/api/folders') || path === '/api/order' || path.endsWith('/folder')) {
      const meta = await metaOf(tx); s.meta.put({ ...meta, structureDirty: true, structureOperation: randomID() });
    }
  };
  async request(path: string, options: RequestInit = {}) {
    if (path.includes('/share') || path.includes('/folder-window') || /\/(unlock|lock|touch)$/.test(path)) {
      if (path.includes('/folder-window')) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ error: '密码文件夹和公开分享请在直接在线模式使用' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    return localRequest(path, options, this.databaseName, this.changed);
  }
  async status() {
    return this.tx('readonly', async tx => { const meta = await metaOf(tx); return { ...meta, pending: (await readLocal<RecordState[]>(tx.objectStore('sync').getAll())).filter(r => r.dirty).length + (meta.structureDirty ? 1 : 0) }; });
  }
  private async json<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await this.net(path, options);
    if (!response.ok) {
      let message; try { message = (await response.json()).error; } catch {}
      throw new SyncError(message || `同步失败（HTTP ${response.status}）`, response.status);
    }
    return response.json();
  }
  private async manifest(): Promise<Manifest> {
    const manifest = await this.json<Manifest>('/api/sync');
    if (manifest.syncAPI !== 1 || manifest.serverID !== this.serverID) throw new Error('目标服务器身份已变化，已停止同步；原缓存和待同步修改仍保留，请先导出缓存备份');
    return manifest;
  }
  private async download(id: string): Promise<Bundle> {
    const value = await this.json<{ note: LocalNote; assets: string[] }>('/api/sync/notes/' + id);
    validateNote(value.note);
    if (value.note.id !== id || !/^[a-f0-9]{64}$/.test(value.note.version) || !Array.isArray(value.assets)) throw new Error('服务器同步数据无效');
    const assets: Asset[] = []; let bytes = new TextEncoder().encode(value.note.content).length;
    for (const name of value.assets) {
      if (!/^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(name)) throw new Error('服务器图片名称无效');
      const response = await this.net('/api/sync/notes/' + id + '/assets/' + name, { headers: { 'If-Match': '"' + value.note.version + '"' } });
      if (!response.ok) throw new SyncError('图片读取中笔记发生变化，请重试同步', response.status);
      const blob = await response.blob(); bytes += blob.size;
      if (blob.size > 10 * 1024 * 1024 || bytes > 200 * 1024 * 1024) throw new Error('服务器图片或缓存超过离线上限，请在直接在线模式整理后重试');
      assets.push({ key: id + '/' + name, blob });
    }
    return { note: value.note, assets };
  }
  private async nextJob(): Promise<{ id: string; job: Job } | undefined> {
    return this.tx('readwrite', async tx => {
      const s = stores(tx); const record = (await readLocal<RecordState[]>(s.sync.getAll())).find(record => record.dirty);
      if (!record) return;
      if (record.pending) return { id: record.id, job: record.pending };
      const note = await readLocal<LocalNote | undefined>(s.notes.get(record.id));
      const assets = (await readLocal<Asset[]>(s.assets.getAll())).filter(a => a.key.startsWith(record.id + '/'));
      const job: Job = { operation: record.operation, conflictID: record.conflictID, base: record.base || 'none', note: note || null, assets };
      s.sync.put({ ...record, pending: job });
      return { id: record.id, job };
    });
  }
  private async send(id: string, job: Job) {
    const headers: Record<string, string> = { 'If-Match': '"' + job.base + '"', 'X-Sync-Operation': job.operation, 'X-Server-ID': this.serverID };
    let body: FormData | undefined;
    if (job.note) {
      body = new FormData(); body.append('note', JSON.stringify({ serverID: this.serverID, title: job.note.title, folder: job.note.folder }));
      body.append('content', new Blob([job.note.content], { type: 'text/plain;charset=utf-8' }), 'note.md');
      for (const asset of job.assets) { const name = asset.key.split('/')[1]; body.append(name, asset.blob, name); }
    }
    return this.json<{ id: string; version: string; deleted: boolean }>('/api/sync/notes/' + id, { method: job.note ? 'PUT' : 'DELETE', headers, body });
  }
  private async acknowledge(id: string, job: Job, version: string) {
    await this.tx('readwrite', async tx => {
      const s = stores(tx); const record = await readLocal<RecordState | undefined>(s.sync.get(id));
      if (!record || record.pending?.operation !== job.operation) return;
      const current = await readLocal<LocalNote | undefined>(s.notes.get(id));
      if (!job.note && !current) { s.sync.delete(id); return; }
      const dirty = fingerprint(current) !== fingerprint(job.note);
      s.sync.put({ ...record, base: version, pending: undefined, dirty, deleted: !current });
    });
  }
  private copyNote(note: LocalNote, id: string, suffix: string): LocalNote {
    const ownPath = '/api/notes/' + note.id + '/';
    const edits = destinations(note.content).filter(d => d.value.startsWith(ownPath + 'assets/') || d.value.startsWith(this.baseURL + ownPath + 'assets/'));
    const chunks: string[] = []; let offset = 0;
    for (const edit of edits.sort((a, b) => a.from - b.from)) {
      chunks.push(note.content.slice(offset, edit.from), edit.value.replace(this.baseURL + ownPath, '').replace(ownPath, '')); offset = edit.to;
    }
    chunks.push(note.content.slice(offset));
    return { ...note, id, version: randomID(), title: [...note.title].slice(0, 180).join('') + suffix, content: chunks.join(''), updatedAt: new Date().toISOString() };
  }
  private async notice(message: string) {
    await this.tx('readwrite', async tx => { const meta = await metaOf(tx); tx.objectStore('meta').put({ ...meta, notice: message }); });
    this.report(message);
  }
  private async conflict(id: string, job: Job, remote?: Bundle) {
    await this.tx('readwrite', async tx => {
      const s = stores(tx); const record = await readLocal<RecordState | undefined>(s.sync.get(id));
      if (record?.pending?.operation !== job.operation) return;
      const notes = await readLocal<LocalNote[]>(s.notes.getAll()); const assets = await readLocal<Asset[]>(s.assets.getAll());
      const current = notes.find(n => n.id === id);
      const keptNotes = notes.filter(n => n.id !== id); const keptAssets = assets.filter(a => !a.key.startsWith(id + '/'));
      if (current) {
        const copy = this.copyNote(current, job.conflictID, remote ? '（冲突副本）' : '（删除冲突副本）');
        // A stable conflict ID makes recovery repeatable after a browser crash.
        keptNotes.push(copy); s.notes.put(copy);
        for (const asset of assets.filter(a => a.key.startsWith(id + '/'))) { const copied = { ...asset, key: copy.id + '/' + asset.key.split('/')[1] }; keptAssets.push(copied); s.assets.put(copied); }
        s.sync.put({ id: copy.id, dirty: true, operation: randomID(), conflictID: randomID() } satisfies RecordState);
      }
      for (const asset of assets.filter(a => a.key.startsWith(id + '/'))) s.assets.delete(asset.key);
      if (remote) {
        const cached = { ...remote.note, version: randomID() }; keptNotes.push(cached); keptAssets.push(...remote.assets); s.notes.put(cached);
        for (const asset of remote.assets) s.assets.put(asset);
        s.sync.put({ id, base: remote.note.version, dirty: false, operation: randomID(), conflictID: randomID() } satisfies RecordState);
      } else { s.notes.delete(id); s.sync.delete(id); }
      assertLocalCapacity(keptNotes, keptAssets);
    });
    await this.notice(job.note ? (remote ? '同步冲突：服务器版本已保留，本地修改保存为“冲突副本”。' : '删除冲突：服务器删除已保留，本地修改保存为“删除冲突副本”。') : '删除冲突：服务器已有新修改，已取消本地删除并保留服务器版本。');
  }
  private async exclude(id: string) {
    const saved = await this.tx('readonly', async tx => {
      const s = stores(tx); return { record: await readLocal<RecordState | undefined>(s.sync.get(id)), note: await readLocal<LocalNote | undefined>(s.notes.get(id)), assets: (await readLocal<Asset[]>(s.assets.getAll())).filter(a => a.key.startsWith(id + '/')) };
    });
    if (!saved.record && !saved.note) return;
    // Previously ordinary notes may become protected elsewhere. Do not upload
    // stale plaintext into a public server folder; rescue pending edits locally.
    if (saved.record?.dirty && saved.note) {
      const copy = { ...this.copyNote(saved.note, saved.record.conflictID, '（受保护笔记的本地恢复副本）'), folder: '' };
      await localTransaction('readwrite', async tx => {
        const s = stores(tx); const existing = await readLocal<LocalNote | undefined>(s.notes.get(copy.id));
        if (existing) return;
        const notes = await readLocal<LocalNote[]>(s.notes.getAll()); const assets = await readLocal<Asset[]>(s.assets.getAll());
        const copied = saved.assets.map(a => ({ ...a, key: copy.id + '/' + a.key.split('/')[1] }));
        assertLocalCapacity([...notes, copy], [...assets, ...copied]); s.notes.add(copy); for (const asset of copied) s.assets.add(asset);
      });
    }
    await this.tx('readwrite', async tx => {
      const s = stores(tx); const now = await readLocal<LocalNote | undefined>(s.notes.get(id));
      if (fingerprint(now) !== fingerprint(saved.note)) throw new Error('受保护笔记的本地修改刚发生变化，请重试以保留最新版本');
      s.notes.delete(id); s.sync.delete(id);
      for (const asset of await readLocal<Asset[]>(s.assets.getAll())) if (asset.key.startsWith(id + '/')) s.assets.delete(asset.key);
    });
    if (saved.record?.dirty) await this.notice('受保护笔记已移出服务器缓存；待同步修改已保存在独立“本地笔记”的恢复副本中，不会自动上传。');
  }
  private async applyRemote(id: string, bundle?: Bundle) {
    await this.tx('readwrite', async tx => {
      const s = stores(tx); const record = await readLocal<RecordState | undefined>(s.sync.get(id));
      if (record?.dirty) return; // An edit made during the download wins locally.
      const notes = (await readLocal<LocalNote[]>(s.notes.getAll())).filter(n => n.id !== id);
      const assets = await readLocal<Asset[]>(s.assets.getAll()); const retained = assets.filter(a => !a.key.startsWith(id + '/'));
      if (bundle) {
        const cached = { ...bundle.note, version: randomID() };
        assertLocalCapacity([...notes, cached], [...retained, ...bundle.assets]); s.notes.put(cached);
        for (const asset of bundle.assets) s.assets.put(asset);
        s.sync.put({ id, base: bundle.note.version, dirty: false, operation: randomID(), conflictID: randomID() } satisfies RecordState);
      } else { s.notes.delete(id); s.sync.delete(id); }
      for (const asset of assets) if (asset.key.startsWith(id + '/') && !bundle?.assets.some(a => a.key === asset.key)) s.assets.delete(asset.key);
    });
  }
  private async localStructure(): Promise<Structure> {
    return this.tx('readonly', async tx => {
      const s = stores(tx); const folders = (await readLocal<LocalFolder[]>(s.folders.getAll())).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.name.localeCompare(b.name));
      const notes = (await readLocal<LocalNote[]>(s.notes.getAll())).sort((a, b) => (a.rank ?? -Date.parse(a.updatedAt)) - (b.rank ?? -Date.parse(b.updatedAt)));
      const order: Order = { folders: folders.map(f => f.name), notes: Object.create(null) };
      for (const note of notes) (order.notes[note.folder] ||= []).push(note.id);
      return { folders: folders.map(f => f.name).sort(), order };
    });
  }
  private async syncStructure(start: Manifest, fresh: Manifest, createdFolders: Set<string>, deleted: Set<string>) {
    const meta = await this.tx('readonly', metaOf);
    if (!meta.structureDirty) return;
    const desired = await this.localStructure();
    const expected = structuredClone(start.structure);
    expected.folders = [...new Set([...expected.folders, ...createdFolders])].sort();
    for (const folder of Object.keys(expected.order.notes)) { expected.order.notes[folder] = expected.order.notes[folder].filter(id => !deleted.has(id)); if (!expected.order.notes[folder].length) delete expected.order.notes[folder]; }
    const conflict = meta.structureBase?.version !== start.structureVersion || !sameStructure(expected, fresh.structure);
    const structure = conflict ? { folders: [...new Set([...fresh.structure.folders, ...desired.folders])].sort(), order: fresh.structure.order } : desired;
    const result = await this.json<{ structure: Structure; structureVersion: string }>('/api/sync/structure', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': '"' + fresh.structureVersion + '"' }, body: JSON.stringify({ serverID: this.serverID, structure }) });
    await this.tx('readwrite', async tx => {
      const current = await metaOf(tx); tx.objectStore('meta').put({ ...current, structureDirty: current.structureOperation !== meta.structureOperation, structureBase: { version: result.structureVersion, value: result.structure } });
    });
    if (conflict) await this.notice('目录或排序发生冲突：保留服务器顺序和双方目录，笔记内容已分别按版本处理。');
  }
  private async applyStructure(manifest: Manifest) {
    await this.tx('readwrite', async tx => {
      const s = stores(tx); const meta = await metaOf(tx);
      if (meta.structureDirty) return;
      const notes = await readLocal<LocalNote[]>(s.notes.getAll());
      const folders = [...new Set([...manifest.structure.folders, ...notes.map(n => n.folder).filter(Boolean)])];
      s.folders.clear();
      for (const name of folders) { const rank = manifest.structure.order.folders.indexOf(name); s.folders.put({ name, protected: false, locked: false, ...(rank >= 0 ? { rank } : {}) }); }
      for (const note of notes) { const ids = manifest.structure.order.notes[note.folder]; const rank = Array.isArray(ids) ? ids.indexOf(note.id) : -1; s.notes.put({ ...note, rank: rank >= 0 ? rank : undefined }); }
      s.meta.put({ ...meta, initialized: true, structureBase: { version: manifest.structureVersion, value: manifest.structure } });
    });
  }
  async synchronize(): Promise<void> {
    if (this.running) return this.running;
    this.running = navigator.locks.request(this.databaseName, { ifAvailable: true }, async lock => {
      if (!lock) return;
      try {
        const start = await this.manifest(); this.online = true;
        for (const id of start.excluded) await this.exclude(id);
        const createdFolders = new Set<string>(); const deleted = new Set<string>();
        for (let i = 0; i < 1000; i++) {
          const next = await this.nextJob(); if (!next) break;
          const { id, job } = next;
          try {
            const receipt = await this.send(id, job);
            if (receipt.id !== id || (job.note && !/^[a-f0-9]{64}$/.test(receipt.version))) throw new Error('同步回执无效，队列仍保留');
            await this.acknowledge(id, job, receipt.version);
            if (job.note?.folder && !start.structure.folders.includes(job.note.folder)) createdFolders.add(job.note.folder);
            if (!job.note) deleted.add(id);
          } catch (error) {
            if (!(error instanceof SyncError)) throw error;
            if (error.status === 403) { await this.exclude(id); continue; }
            if (error.status !== 412 && error.status !== 404) throw error;
            let remote: Bundle | undefined;
            try { remote = await this.download(id); } catch (readError) { if (!(readError instanceof SyncError) || readError.status !== 404) throw readError; }
            await this.conflict(id, job, remote);
          }
        }
        let manifest = await this.manifest();
        await this.syncStructure(start, manifest, createdFolders, deleted);
        manifest = await this.manifest();
        for (const id of manifest.excluded) await this.exclude(id);
        const records = await this.tx('readonly', async tx => await readLocal<RecordState[]>(tx.objectStore('sync').getAll()));
        const remoteIDs = new Set(manifest.notes.map(n => n.id));
        for (const record of records) if (!record.dirty && !remoteIDs.has(record.id)) await this.applyRemote(record.id);
        for (const summary of manifest.notes) {
          const record = await this.tx('readonly', async tx => await readLocal<RecordState | undefined>(tx.objectStore('sync').get(summary.id)));
          if (record?.dirty || record?.base === summary.version) continue;
          try { await this.applyRemote(summary.id, await this.download(summary.id)); }
          catch (error) { if (error instanceof SyncError && error.status === 404) await this.applyRemote(summary.id); else throw error; }
        }
        await this.applyStructure(manifest);
      } catch (error) { this.online = false; throw error; }
    }).finally(() => { this.running = undefined; });
    return this.running;
  }
}
