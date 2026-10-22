import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {measure} from '../lib/runtime.mjs';
import {skillPickerReady,marketInstallReady} from '../lib/skill-readiness.mjs';

test('skill popup timer waits for list content, and refuses loading or a broken visible icon',async t=>{
 const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());const p=await browser.newPage();
 await p.setContent('<button id="open">技能</button><main id="host"></main>');
 await p.evaluate(()=>document.getElementById('open').onclick=()=>{document.getElementById('host').innerHTML='<section><input placeholder="输入名称搜索..."><div id="rows"></div><button>添加技能</button></section>';setTimeout(()=>document.getElementById('rows').innerHTML='<button role="checkbox" aria-checked="false"><span class="truncate">Sample</span></button>',160);});
 const ctx={page:p,measurements:[]};const sample=await measure(ctx,()=>p.locator('#open').click(),`(${skillPickerReady.toString()})`,'popup');assert.ok(sample.durationMs>=140);
 await p.locator('section').evaluate(e=>e.setAttribute('aria-busy','true'));assert.equal(await p.evaluate(skillPickerReady),false);
 await p.locator('section').evaluate(e=>{e.removeAttribute('aria-busy');const i=document.createElement('img');i.src='data:image/png;base64,broken';e.append(i);});
 await p.waitForFunction(()=>document.images[0].complete);assert.equal(await p.evaluate(skillPickerReady),false);
});

test('market download completion requires the chosen card installed state, never a spinner or an unrelated card',async t=>{
 const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});t.after(()=>browser.close());const p=await browser.newPage();
 await p.setContent('<main><div role="button"><p>Other</p><button aria-label="已安装"></button></div><div id="target" role="button"><p>Office办公助手</p><button aria-label="安装"></button></div></main>');
 assert.equal(await p.evaluate(marketInstallReady),false);
 await p.locator('#target button').evaluate(e=>{e.setAttribute('aria-label','下载中');e.disabled=true;});assert.equal(await p.evaluate(marketInstallReady),false);
 await p.locator('#target button').evaluate(e=>e.setAttribute('aria-label','已安装'));assert.equal(await p.evaluate(marketInstallReady),true);
});
