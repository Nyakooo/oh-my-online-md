// Every suite gets an isolated server and data directory, so existing notes are untouched.
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const suites = ['loading', 'save-state', 'search', 'editor', 'media', 'share', 'share-theme', 'large-note', 'folders', 'folder-policy', 'extension'];
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function startServer(binary, directory, password) {
  await fs.mkdir(directory);
  const port = await freePort();
  const process = spawn(binary, [], { env: { ...global.process.env, DATA_DIR: directory, PORT: String(port), PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; process.stderr.on('data', data => { output += data; });
  const url = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) {
    if (process.exitCode !== null) throw new Error('Server failed: ' + output);
    try { if ((await fetch(url + '/favicon.svg')).ok) return { process, url, directory }; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  process.kill(); throw new Error('Server did not start: ' + output);
}
(async () => {
  const selected = process.argv.slice(2);
  const run = selected.length ? selected : suites;
  if (run.some(name => !suites.includes(name))) throw new Error('Unknown browser suite');
  const work = await fs.mkdtemp('/tmp/online-md-browser-tests-');
  const binary = path.join(work, 'online-md');
  execFileSync('go', ['build', '-o', binary, '.'], { stdio: 'inherit' });
  try {
    for (const suite of run) {
      const password = ['share', 'extension'].includes(suite) ? 'test-password' : '';
      const server = await startServer(binary, path.join(work, suite), password);
      let second;
      try {
        if (suite === 'extension') second = await startServer(binary, path.join(work, suite + '-second'), password);
        const child = spawn(process.execPath, ['tests/' + suite + '.cjs'], { stdio: 'inherit', env: { ...process.env, TEST_URL: server.url, TEST_DATA_DIR: server.directory, TEST_PASSWORD: password, SECOND_TEST_URL: second?.url || '' } });
        const [code] = await once(child, 'exit'); if (code !== 0) throw new Error(suite + ' failed');
      } finally {
        server.process.kill(); if (second) second.process.kill();
        await Promise.all([once(server.process, 'exit'), ...(second ? [once(second.process, 'exit')] : [])]);
      }
    }
  } finally { await fs.rm(work, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exit(1); });
