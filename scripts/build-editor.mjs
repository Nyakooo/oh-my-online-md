import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const result = await build({
  entryPoints: ['web/editor.js'], bundle: true, minify: true, format: 'iife',
  outfile: 'web/editor.bundle.js', legalComments: 'eof', metafile: true,
  banner: { js: '/*! Bundled dependencies and licenses: /editor.LICENSE.txt */' }
});
const diagrams = await build({
  entryPoints: ['web/diagrams.js'], bundle: true, minify: true, format: 'iife',
  outfile: 'web/diagrams.bundle.js', legalComments: 'eof', metafile: true
});
const roots = new Set();
for (const input of Object.keys({ ...result.metafile.inputs, ...diagrams.metafile.inputs })) {
  const match = input.match(/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) roots.add(match[1]);
}
const notices = [];
for (const root of [...roots].sort()) {
  const pkg = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md']) {
    try {
      notices.push(`${pkg.name} ${pkg.version}\n${await readFile(`${root}/${filename}`, 'utf8')}`);
      break;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
await writeFile('web/editor.LICENSE.txt', notices.join('\n\n----------------------------------------\n\n'));
