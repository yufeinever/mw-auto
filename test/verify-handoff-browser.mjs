// One browser acceptance scenario; talks to the live console read-only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loadPlaywright } from '../lib/dependencies.mjs';
import { VERSION } from '../lib/version.mjs';

const {chromium}=loadPlaywright();
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
  await page.goto('http://127.0.0.1:17866/');
  await page.waitForFunction(version=>document.querySelector('.version')?.textContent==='v'+version,VERSION);
  assert.equal(await page.locator('#cases tr').count(),44);
  // Simulate recovery UI in this browser only; never submit a client task.
  const state=await fetch('http://127.0.0.1:17866/api/state').then(r=>r.json());
  const fixture={id:'1792681482933-browser-fixture',status:'waiting_recovery',mode:'warm',selected:['MW-UI-011','MW-UI-012'],
    results:[{id:'MW-UI-011',functional:'interrupted',restored:false}],current:null,startedAt:new Date().toISOString(),
    schedulingHold:true,handoff:{caseId:'MW-UI-011',ready:false,reason:'浏览器模拟：等待原页面恢复'},
    logs:[{time:new Date().toISOString(),text:'浏览器模拟恢复等待；保留后续队列和原失败结论'}]};
  let polls=0;
  await page.route('**/api/state',route=>{polls++;return route.fulfill({json:{...state,active:fixture}});});
  await page.waitForFunction(()=>document.querySelector('#run-status').textContent==='等待客户端恢复');
  assert.equal(await page.locator('#recheck').isVisible(),true);
  assert.match(await page.locator('#handoff').innerText(),/恢复异常已记录/);
  const selected=await page.locator('#logs').evaluate(el=>{
    window.__selectionNode=el.firstChild;const range=document.createRange();range.selectNodeContents(el);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(range);return selection.toString();
  });
  const initialPolls=polls;
  fixture.logs.push({time:new Date().toISOString(),text:'选中文字期间到达的新日志'});
  await page.waitForTimeout(3400);
  assert.ok(polls>=initialPolls+2);
  assert.equal(await page.evaluate(()=>getSelection().toString()),selected);
  assert.equal(await page.evaluate(()=>window.__selectionNode.isConnected),true);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.waitForFunction(()=>document.querySelector('#logs').textContent.includes('选中文字期间到达的新日志'));
  await page.screenshot({path:'data/v0017-browser-recovery.png',fullPage:true});
  await page.unroute('**/api/state');await page.reload();
  await page.waitForFunction(()=>document.querySelectorAll('#cases tr').length===44);
  assert.deepEqual(errors,[]);
  const evidence={scenario:'live console rendering + simulated recovery state + selection across two polls',passed:true,pageErrors:errors,version:VERSION,polls,selectedLength:selected.length};
  await fs.writeFile('data/v0017-browser-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();}
