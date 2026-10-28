const {chromium} = require('playwright');
const assert = require('node:assert/strict');
(async () => {
 const browser=await chromium.launch();
 const page=await browser.newPage({baseURL:process.env.TEST_URL||'http://localhost:10778'});
 let id;
 try {
  const result=await page.request.post('/api/notes',{data:{title:'大文本保存回归',content:''}});id=(await result.json()).id;
  await page.goto('/');
  await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存');
  const line='大文本保存测试 0123456789\n';
  const content=line.repeat(Math.ceil(2.1*1024*1024/Buffer.byteLength(line)));
  await page.evaluate(text=>{contentEditor.setValue(text,true);markDirty()},content);
  await page.locator('#save-note').click();
  await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存');
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='已保存');
  assert.equal(await page.evaluate(()=>contentEditor.getValue()),content);
  const writes=[];
  page.on('request',request=>{if(request.method()==='PUT'||request.method()==='POST')writes.push(request.url())});
  await page.evaluate(()=>{contentEditor.setValue(('x'.repeat(1023)+'\n').repeat(16384)+'x',true);markDirty()});
  await page.locator('#save-note').click();
  await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='保存失败');
  assert.match(await page.locator('#notice').textContent(),/16 MiB/);
  assert.equal(writes.length,0,'oversized text must be rejected before uploads or save requests');
  assert.equal(await page.evaluate(()=>contentEditor.getValue().length),16*1024*1024+1);
  const disk=await (await page.request.get(`/api/notes/${id}`)).json();
  assert.equal(disk.content,content,'rejected save must preserve last saved content');
  await page.evaluate(()=>{contentEditor.setValue('代理超限提示测试',true);markDirty()});
  await page.route('**/api/notes/*',route=>route.request().method()==='PUT'?route.fulfill({status:413,contentType:'text/html',body:'Request Entity Too Large'}):route.continue());
  await page.locator('#save-note').click();
  await page.waitForFunction(()=>document.querySelector('#save-state').textContent==='保存失败');
  assert.match(await page.locator('#notice').textContent(),/32m/);
  assert.equal(await page.evaluate(()=>contentEditor.getValue()),'代理超限提示测试');
  await page.unroute('**/api/notes/*');
  console.log('PASS: 2.1 MiB Unicode save/reload, 16 MiB client limit before network writes, preserved text/disk content and proxy 413 guidance');
 } finally {
  if(id)await page.request.delete(`/api/notes/${id}`);
  await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1});
