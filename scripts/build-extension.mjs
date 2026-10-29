import { build } from 'esbuild';
import { version } from './check-version.mjs';
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await import('./build-editor.mjs');
const out = 'dist/extension';
const archive = `oh-my-online-md-extension_v${version}.zip`;
await rm(out, { recursive: true, force: true });
await rm(`dist/${archive}`, { force: true });
await mkdir(out, { recursive: true });
for (const file of ['editor.bundle.js', 'diagrams.bundle.js', 'editor.LICENSE.txt', 'app.js', 'note-assets.js', 'folder-session.js', 'folders.js', 'theme-init.js', 'favicon.svg', 'favicon.ico']) await cp('web/' + file, out + '/' + file);
let html = await readFile('web/index.html', 'utf8');
// Native popup title bars reliably use the bundled PNG instead of a cached SVG.
html = html.replace(/<link rel="(?:alternate )?icon"[^>]*>\n/g, '');
html = html.replace('</head>', '<link rel="icon" href="icons/32.png" type="image/png" sizes="32x32"></head>');
html = html.replace('</head>', '<link rel="stylesheet" href="extension.css"></head>');
html = html.replace('<body>', '<body>' + await readFile('extension/connection.html', 'utf8'));
html = html.replace('<div class="actions">', '<div class="actions"><button class="icon-button" id="connection-settings" aria-label="服务器设置" title="服务器设置"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="m10 3 4 0 1 3 3 1 3 3 0 4-3 1-1 3-3 3-4 0-1-3-3-1-3-3 0-4 3-1 1-3Z"/></svg></button>');
html = html.replace('</aside>', '<div class="server-footer"><span class="server-dot"></span><div class="server-footer-info"><span id="server-connection-label">尚未连接</span><span id="storage-usage" role="status" hidden></span></div></div></aside>');
html = html.replace('<script src="/folders.js">', '<script src="host.js"></script><script src="/folders.js">');
await writeFile(out + '/app.html', html);
for (const file of ['manifest.json', 'options.html', 'extension.css']) await cp('extension/' + file, out + '/' + file);
await cp('extension/icons', out + '/icons', { recursive: true });
await build({ entryPoints: ['extension/worker.ts', 'extension/host.ts', 'extension/options.ts'], outdir: out, bundle: true, format: 'iife', target: 'chrome116', sourcemap: false });
await cp('LICENSE', out + '/LICENSE');
await cp('docs/browser-extension.md', out + '/README.md');
await cp('THIRD_PARTY_NOTICES.md', out + '/THIRD_PARTY_NOTICES.md');
// Use the system zip utility when available; the unpacked build is always usable.
try { execFileSync('zip', ['-q', '-r', `../${archive}`, '.'], { cwd: out }); }
catch (error) { if (error.code !== 'ENOENT') throw error; console.warn('zip 不可用；扩展构建目录已生成。'); }
console.log('Extension ready: dist/extension');
