const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.request.post(process.env.TEST_URL + '/api/folders', { data: { name: '目录交互测试' } });
    await page.request.post(process.env.TEST_URL + '/api/notes', { data: { title: '笔记交互测试', content: '正文' } });
    await page.goto(process.env.TEST_URL);
    await page.waitForFunction(() => !loading);
    await page.locator('#sidebar-toggle').click();
    await page.waitForFunction(() => Math.round(document.querySelector('main').getBoundingClientRect().x) === 64);
    await page.evaluate(() => {
      window.railCrossings = [];
      const button = document.querySelector('#rail-directory');
      for (const type of ['mouseenter', 'mouseleave']) button.addEventListener(type, () => window.railCrossings.push(type));
    });
    const box = await page.locator('#rail-directory').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - .25);
    await page.evaluate(() => new Promise(resolve => {
      let frames = 60;
      const tick = () => --frames ? requestAnimationFrame(tick) : resolve();
      requestAnimationFrame(tick);
    }));
    const crossings = await page.evaluate(() => window.railCrossings);
    assert.deepEqual(crossings, ['mouseenter'], 'Stationary pointer must not retrigger hover: ' + JSON.stringify(crossings));
    await page.mouse.move(1100, 600);
    await page.locator('#sidebar').waitFor({ state: 'hidden' });
    await page.evaluate(() => {
      window.peekChanges = [];
      new MutationObserver(records => {
        for (const record of records) if (record.attributeName === 'data-sidebar-peek') window.peekChanges.push(document.documentElement.dataset.sidebarPeek);
      }).observe(document.documentElement, { attributes: true });
    });
    await page.locator('#rail-new').click();
    assert.equal(await page.evaluate(() => window.peekChanges.includes('true')), false, 'New note action must not flash the directory');
    await page.locator('#rail-directory').click();
    await page.locator('#sidebar').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('#sidebar').getAnimations({ subtree: true }).length === 0);
    const flyoutBefore = await page.locator('#sidebar').boundingBox();
    await page.evaluate(() => { window.peekChanges = []; });
    for (let i = 0; i < 4; i++) await page.locator('#note-list').getByRole('button', { name: /文件夹 目录交互测试/ }).click();
    const flyoutAfter = await page.locator('#sidebar').boundingBox();
    assert.equal(flyoutAfter.x, flyoutBefore.x);
    assert.equal(flyoutAfter.y, flyoutBefore.y);
    assert.equal(await page.evaluate(() => window.peekChanges.includes('false')), false, 'Folder clicks must keep the flyout open');
    await page.evaluate(() => document.documentElement.dataset.theme = 'light');
    assert.equal(await page.locator('main').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
    console.log('PASS: stationary rail hover, new-note click without flyout flash, stable repeated folder clicks, original white daytime theme');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
