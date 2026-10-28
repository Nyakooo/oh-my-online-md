// Build reproducible store art from a real, isolated extension instance.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
const root = 'docs/store';
const temp = await mkdtemp('/tmp/online-md-store-art-');
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
execFileSync('go', ['build', '-o', temp + '/server', '.']);
await mkdir(temp + '/data');
const server = spawn(temp + '/server', [], { env: { ...process.env, DATA_DIR: temp + '/data', PORT: String(port), PASSWORD: '' }, stdio: 'ignore' });
let context;
try {
  for (let n = 0; n < 100; n++) { try { if ((await fetch(base + '/favicon.svg')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const api = async (url, method, body) => { const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error(await response.text()); return response.json(); };
  for (const name of ['灵感收集', '私人笔记']) await api('/api/folders', 'POST', { name });
  for (const title of ['周末的小计划', '今天读到的一句话']) await api('/api/notes', 'POST', { title, content: '把想法记下来，慢慢整理。' });
  const child = await api('/api/notes', 'POST', { title: '下一个小项目', content: '## 灵感清单\n\n- [ ] 做一个喜欢的小工具\n- [x] 给灵感留一个位置\n\n随时记录，慢慢实现。' });
  await api(`/api/notes/${child.id}/folder`, 'PUT', { folder: '灵感收集' });
  await api('/api/folders/' + encodeURIComponent('私人笔记'), 'PUT', { name: '私人笔记', password: 'store-demo-only' });
  const note = await api('/api/notes', 'POST', { title: '给灵感一个自己的家', content: '# 今天，也记一点\n\n把突然想到的点子、读到的一句话，留在自己的服务器。\n\n## 一点点整理\n\n- [x] 用 Markdown 写下想法\n- [x] 拖拽归档到文件夹\n- [ ] 留一点时间，继续创造\n\n> 少一点打扰，多一点专注。\n\n## 从想法到行动\n\n```mermaid\nflowchart LR\n A[灵感] --> B[记录] --> C[整理] --> D[行动]\n```' });
  await cp('dist/extension', temp + '/extension', { recursive: true });
  const manifest = JSON.parse(await readFile(temp + '/extension/manifest.json', 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*']; // Fixture copy only; never distribute this grant.
  await writeFile(temp + '/extension/manifest.json', JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(temp + '/profile', { channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, args: ['--disable-extensions-except=' + temp + '/extension', '--load-extension=' + temp + '/extension'] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto(`chrome-extension://${id}/app.html`);
  await page.locator('#connection-page').waitFor();
  await page.locator('#server-url').fill(base); await page.locator('#connect-server').click();
  await page.locator('#connection-page').waitFor({ state: 'hidden' });
  await page.locator('#loading-panel').waitFor({ state: 'hidden' });
  await page.locator(`[data-note-id="${note.id}"]`).click(); await page.waitForFunction(() => !loading);
  for (const platform of ['chrome', 'edge']) await mkdir(`${root}/${platform}`, { recursive: true });
  const shots = [];
  const shot = async name => { const file = `${root}/chrome/${name}.png`; await page.screenshot({ path: file }); shots.push(file); };
  await page.locator('#edit-tab').click(); await shot('01-markdown-editor-1280x800');
  await page.locator('#preview-tab').click(); await page.locator('.diagram-canvas svg').waitFor();
  await page.locator('#theme-toggle').click(); await shot('02-preview-dark-1280x800');
  await page.locator('#theme-toggle').click();
  await page.getByRole('button', { name: '展开文件夹 灵感收集', exact: true }).click();
  await page.getByRole('button', { name: '解锁文件夹 私人笔记', exact: true }).click();
  await page.locator('#folder-dialog').waitFor(); await shot('03-folders-password-1280x800');
  await page.locator('#folder-cancel').click();
  await page.locator('#connection-settings').click(); await page.locator('#server-url').fill('https://notes.example.com');
  await shot('04-server-settings-1280x800');
  for (const file of shots) await cp(file, file.replace('/chrome/', '/edge/'));
  const svg = await readFile('web/favicon.svg', 'utf8');
  const render = await context.newPage();
  const renderHTML = async (html, width, height, file, transparent = false) => { await render.setViewportSize({ width, height }); await render.setContent(html); await render.evaluate(() => document.fonts.ready); await render.screenshot({ path: file, omitBackground: transparent }); };
  const iconHTML = (size, pad) => `<style>html,body{margin:0;background:transparent;width:${size}px;height:${size}px}svg{position:absolute;left:${pad}px;top:${pad}px;width:${size-pad*2}px;height:${size-pad*2}px}</style>${svg}`;
  await renderHTML(iconHTML(128, 16), 128, 128, root + '/chrome/icon-128.png', true);
  await renderHTML(iconHTML(300, 0), 300, 300, root + '/edge/logo-300.png', true);
  const image = 'data:image/png;base64,' + (await readFile(shots[0])).toString('base64');
  const css = '*{box-sizing:border-box}body{margin:0;font-family:Arial,"Noto Sans CJK SC",sans-serif;color:#342b28;background:#fff9ec}svg{display:block}.brand{display:flex;align-items:center;gap:12px;font-weight:700}.hint{color:#786e60}.kbd{display:inline-flex;gap:7px;margin-top:24px}kbd{padding:8px 13px;border:1px solid #d8c7a2;border-bottom-width:3px;border-radius:8px;background:#fffdf7;font:15px Arial}.tiny{font-size:12px;color:#8e8170}';
  const small = `<style>${css}body{padding:29px 32px;background:radial-gradient(circle at 92% 5%,#ffe39b,transparent 70%),#fff9ec}.brand{font-size:22px}.brand svg{width:58px;height:58px}h1{font-size:30px;line-height:1.3;letter-spacing:-1px;margin:21px 0 9px}.hint{font-size:14px}.foot{margin-top:20px;font-size:12px;color:#8e8170}</style><div class="brand">${svg}简记</div><h1>灵感来了，<br>随手记一下。</h1><div class="hint">连接自己的服务器 · Markdown 笔记</div><div class="foot">快捷唤出 / 拖拽整理 / 图片粘贴</div>`;
  const banner = `<style>${css}body{height:560px;padding:51px 54px;background:radial-gradient(ellipse at 3% 100%,#ffedba,transparent 75%),#fff9ec;overflow:hidden}.brand{font-size:26px}.brand svg{width:56px;height:56px}h1{font-size:53px;line-height:1.25;letter-spacing:-2px;margin:30px 0 18px}.hint{font-size:17px;line-height:1.8}.frame{position:absolute;left:562px;top:47px;width:784px;height:490px;border:1px solid #ded8c8;border-radius:15px;overflow:hidden;box-shadow:0 22px 50px #66501d20}.frame img{display:block;width:100%;height:100%}</style><div class="brand">${svg}简记</div><h1>你的笔记，<br>随叫随到。</h1><div class="hint">连接自己的服务器<br>Markdown 编辑 · 文件夹整理 · 图片粘贴</div><div class="kbd"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>Y</kbd></div><div class="tiny" style="margin-top:12px">浏览器内快捷唤出 · macOS 使用 ⌘⇧Y</div><div class="frame"><img src="${image}"></div>`;
  for (const platform of ['chrome', 'edge']) {
    await renderHTML(small, 440, 280, `${root}/${platform}/promo-small-440x280.png`);
    await renderHTML(banner, 1400, 560, `${root}/${platform}/promo-banner-1400x560.png`);
  }
  await writeFile(root + '/source/promo-small.html', small);
  // Keep screenshot references relative instead of embedding a duplicate PNG in source.
  await writeFile(root + '/source/promo-banner.html', banner.replace(image, '../chrome/01-markdown-editor-1280x800.png'));
  await writeFile(root + '/source/README.md', '截图来自 v' + manifest.version + ' 的真实 MV3 扩展和独立的本机示例服务器。全部为演示数据。可运行 pnpm build:extension && node scripts/build-store-assets.mjs 重新生成；脚本仅在临时副本中预授予本机示例服务器权限，分发包保持可选主机权限。宣传排版源文件和各平台成品一并保留。\n');
  console.log('Store assets saved in docs/store/chrome and docs/store/edge');
} finally { await context?.close(); server.kill(); await rm(temp, { recursive: true, force: true }); }
