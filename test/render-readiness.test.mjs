import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {installRendering} from '../lib/render-readiness.mjs';

test('render readiness accepts content and normal empty state without checking business text',async t=>{
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<main><section id="content"><div class="card">arbitrary server label</div></section></main>');
  await installRendering(page);
  assert.deepEqual(await page.evaluate(()=>window.__mwRender.state(document.querySelector('main'))),{ready:true,state:'content'});
  await page.locator('main').evaluate(e=>e.innerHTML='<section id="empty">暂无内容</section>');
  assert.deepEqual(await page.evaluate(()=>window.__mwRender.state(document.querySelector('main'))),{ready:true,state:'empty'});
});

test('render readiness separates loading and service error from a completed render',async t=>{
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<main><section id="state" aria-busy="true"><div>正在加载</div></section></main>');
  await installRendering(page);
  assert.equal((await page.evaluate(()=>window.__mwRender.state(document.querySelector('main')))).state,'loading');
  await page.locator('#state').evaluate(e=>e.outerHTML='<section role="alert">网络请求失败</section>');
  assert.equal((await page.evaluate(()=>window.__mwRender.state(document.querySelector('main')))).state,'error');
});
