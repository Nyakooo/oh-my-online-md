// Authenticated image loading is shared by the website and extension.
const noteAssets = new Map();
let noteAssetGeneration = 0;
const emptyNoteImage = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
function noteAssetPath(path, noteID = state.current) {
  if (noteID && /^assets\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(path)) return `/api/notes/${noteID}/${path}`;
  let candidate = path;
  const base = window.noteHost ? window.noteHost.serverURL('/api/') : location.origin + '/api/';
  if (path.startsWith(base)) candidate = '/api/' + path.slice(base.length);
  return /^\/api\/notes\/[a-f0-9]{32}\/assets\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(candidate) ? candidate : null;
}
function clearNoteAssets() {
  noteAssetGeneration++;
  for (const entry of noteAssets.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  noteAssets.clear();
}
function resolveNoteAsset(path) {
  const target = noteAssetPath(path);
  if (!target) return null;
  if (noteAssets.has(target)) return noteAssets.get(target).url || emptyNoteImage;
  const entry = {}; noteAssets.set(target, entry);
  const generation = noteAssetGeneration;
  noteRequest(target).then(async response => {
    if (!response.ok) throw new Error('图片读取失败，请检查连接或重新解锁文件夹');
    const blob = await response.blob();
    window.noteHost?.assertCurrent(response);
    if (generation !== noteAssetGeneration) return;
    entry.url = URL.createObjectURL(blob);
    window.dispatchEvent(new Event('note-assets-ready'));
  }).catch(error => { if (generation === noteAssetGeneration) { entry.failed = true; showNotice(error.message); } });
  return emptyNoteImage;
}

// Links to stored images need the same window authorization as their previews.
async function downloadNoteAsset(target) {
  const generation = noteAssetGeneration;
  const response = await noteRequest(target);
  if (!response.ok) throw new Error('附件读取失败，请检查文件夹是否解锁');
  const blob = await response.blob();
  window.noteHost?.assertCurrent(response);
  if (generation !== noteAssetGeneration) return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = target.split('/').pop(); anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
document.addEventListener('click', event => {
  const anchor = event.target.closest?.('#content a[href]');
  if (!anchor) return;
  const target = noteAssetPath(anchor.getAttribute('href') || '');
  if (!target) return;
  event.preventDefault();
  downloadNoteAsset(target).catch(error => showNotice(error.message));
});
