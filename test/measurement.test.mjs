import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {measure,Blocked} from '../lib/runtime.mjs';

test('renderer timing waits for terminal render and rejects an already satisfied terminal',async t=>{
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage();
  await page.setContent('<button id="go">Go</button><div id="done">waiting</div><script>go.onclick=()=>setTimeout(()=>done.textContent="ready",120)</script>');
  const ctx={page,measurements:[]};
  const result=await measure(ctx,()=>page.locator('#go').click(),'()=>document.querySelector("#done").textContent==="ready"','delayed-render');
  assert.ok(result.durationMs>=100,'must include the async render delay');
  assert.equal(ctx.measurements.length,1);
  let acted=false;
  await assert.rejects(()=>measure(ctx,async()=>{acted=true},'()=>true','pre-satisfied'),Blocked);
  assert.equal(acted,false,'must reject before the operation');
  await assert.rejects(()=>measure(ctx,()=>page.locator('#go').click(),'()=>false','missing-terminal',{timeoutMs:120}),/终态断言/);
  assert.equal(ctx.measurements.length,1,'timeout must not create a performance sample');
});
