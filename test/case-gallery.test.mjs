import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {gallerySnapshot,galleryComplete} from '../lib/case-gallery.mjs';

test('all-case readiness includes offscreen lazy covers and refuses filtering or pagination',async t=>{
 const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 t.after(()=>browser.close());const p=await browser.newPage();
 const image='data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>';
 await p.setContent(`<main><input placeholder="请输入关键词查询"><button class="border-[var(--mw-brand)]">全部</button><h2>全部案例</h2><div class="mw-case-card">A<img src='${image}'></div><div style="margin-top:9000px" class="mw-case-card">B<img loading="lazy" src='${image}'></div></main>`);
 await p.locator('.mw-case-card').last().scrollIntoViewIfNeeded();
 await p.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
 assert.equal(galleryComplete(await p.evaluate(gallerySnapshot)),true);
 await p.locator('input').fill('filtered');
 assert.equal(galleryComplete(await p.evaluate(gallerySnapshot)),false);
 await p.locator('input').fill('');
 await p.locator('main').evaluate(e=>{const b=document.createElement('button');b.textContent='下一页';e.append(b);});
 assert.equal(galleryComplete(await p.evaluate(gallerySnapshot)),false);
 await p.getByRole('button',{name:'下一页'}).evaluate(e=>e.remove());
 await p.locator('img').last().evaluate(e=>e.src='data:image/png;base64,broken');
 await p.waitForFunction(()=>document.images[1].complete&&!document.images[1].naturalWidth);
 const bad=await p.evaluate(gallerySnapshot);assert.equal(bad.pendingImages,1);assert.equal(galleryComplete(bad),false);
});
