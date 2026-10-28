let opening: Promise<void> | undefined;
const appURL = chrome.runtime.getURL('app.html');
async function noteContexts() {
  return (await chrome.runtime.getContexts({})).filter(context => context.windowId >= 0 && context.documentUrl?.split(/[?#]/, 1)[0] === appURL);
}
async function openNotes(configure = false) {
  if (opening) return opening;
  opening = (async () => {
    const contexts = await noteContexts();
    const context = contexts.find(item => item.windowId >= 0);
    if (context) {
      const existing = await chrome.windows.get(context.windowId);
      await chrome.windows.update(context.windowId, { focused: true, ...(existing.state === 'minimized' ? { state: 'normal' } : {}) });
      if (configure) await chrome.runtime.sendMessage({ type: 'configure-notes' });
      return;
    }
    const { windowBounds } = await chrome.storage.local.get('windowBounds');
    if (configure) await chrome.storage.session.set({ showSettings: true });
    const bounds = windowBounds as chrome.windows.CreateData | undefined;
    await chrome.windows.create({ ...bounds, type: 'popup', url: appURL, focused: true, width: bounds?.width || 1120, height: bounds?.height || 800 });
  })();
  try { await opening; } finally { opening = undefined; }
}
chrome.action.onClicked.addListener(() => { openNotes().catch(console.error); });
chrome.commands.onCommand.addListener(command => { if (command === 'open-notes') openNotes().catch(console.error); });
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type !== 'open-notes') return;
  openNotes(Boolean(message.configure)).then(() => respond({ ok: true }), error => respond({ error: String(error) }));
  return true;
});
chrome.windows.onBoundsChanged.addListener(window => {
  if (window.type !== 'popup' || window.state !== 'normal') return;
  noteContexts().then(contexts => {
    if (!contexts.some(item => item.windowId === window.id)) return;
    const { left, top, width, height } = window;
    return chrome.storage.local.set({ windowBounds: { left, top, width, height } });
  }).catch(console.error);
});
