// Render every app icon from the same SVG. Run after changing web/favicon.svg.
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const svg = await readFile('web/favicon.svg', 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100%;height:100%}</style>${svg}`);
  await mkdir('extension/icons', { recursive: true });
  const images = [];
  for (const size of [16, 32, 48, 64, 128]) {
    await page.setViewportSize({ width: size, height: size });
    const png = await page.screenshot({ omitBackground: true });
    if (size !== 64) await writeFile(`extension/icons/${size}.png`, png);
    if (size !== 128) images.push({ size, png });
  }
  // ICO supports PNG entries; keep native favicon sizes without a second artwork.
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  await writeFile('web/favicon.ico', Buffer.concat([header, ...images.map(image => image.png)]));
} finally { await browser.close(); }
