import { readFile, access } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
export const version = pkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version || '') || manifest.version !== version) throw new Error('package.json and extension/manifest.json versions must match');
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${version}`) throw new Error(`Release tag must be v${version}, got ${process.env.RELEASE_TAG}`);
await access(new URL(`../docs/releases/v${version}.md`, import.meta.url));
console.log(`Version verified: ${version}${process.env.RELEASE_TAG ? ' / ' + process.env.RELEASE_TAG : ''}`);
