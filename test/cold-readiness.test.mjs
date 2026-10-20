import test from 'node:test';
import assert from 'node:assert/strict';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {homepageReadiness,runColdStartup} from '../lib/cold-start.mjs';

test('cold observer opens a missing region once and lets animation finish despite an unchanged expand label',async t=>{
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent(`<main><h1>Mobile熠动，Work智简</h1>
    <h2 id="recent-tasks-heading">工作任务（1）<button aria-label="展开" id="expand">toggle</button></h2>
    <div data-testid="recent-tasks-scroll" id="tasks" style="display:none"><button data-slot="context-menu-trigger">fixture</button></div>
    <div data-testid="workspace-section"><div data-testid="workspace-scroll"><div data-workspace-row-header>space</div></div></div>
    <div role="textbox" contenteditable="true"></div></main>
    <script>window.clicks=0;expand.onclick=()=>{window.clicks++;tasks.style.display=tasks.style.display==='none'?'block':'none';tasks.animate([{opacity:.1},{opacity:1}],{duration:320});};</script>`);
  await page.evaluate(()=>{location.hash='/workspace/test/session';});
  const sample=await runColdStartup({listProcesses:async()=>[],launch:async()=>{},connect:async()=>({page,browser:{close:async()=>{}}}),timeoutMs:3000});
  assert.equal(await page.evaluate(()=>window.clicks),1);
  assert.ok(sample.durationMs>=300,'must wait for the animation instead of retriggering it');
  assert.equal(sample.observations.ready,true);assert.equal(sample.observations.resources.finiteAnimations,0);
  assert.equal((await page.evaluate(homepageReadiness)).ready,true);
});

test('an already ready page is only observed, never prepared or clicked',async()=>{
  let clock=0,preparations=0,closed=0;
  const sample=await runColdStartup({listProcesses:async()=>[],launch:async()=>{},
    connect:async()=>({page:{evaluate:async()=>({ready:true,home:true,reason:'ready'})},browser:{close:async()=>closed++}}),
    prepare:async()=>preparations++,now:()=>clock,sleep:async ms=>{clock+=ms;},timeoutMs:500});
  assert.equal(preparations,0);assert.equal(closed,1);assert.equal(sample.observations.ready,true);
});

test('a pending font/image/animation state is observed without repeating navigation',async()=>{
  let clock=0,observations=0,preparations=0;
  const sample=await runColdStartup({listProcesses:async()=>[],launch:async()=>{},
    connect:async()=>({page:{evaluate:async()=>({ready:++observations>=3,home:true,reason:observations>=3?'ready':'resources_pending'})},browser:{close:async()=>{}}}),
    prepare:async()=>preparations++,now:()=>clock,sleep:async ms=>{clock+=ms;},timeoutMs:1000});
  assert.equal(preparations,0);assert.equal(sample.durationMs,300);
});

test('timeout retains safe readiness diagnostics and no timing sample',async()=>{
  let clock=0;
  await assert.rejects(()=>runColdStartup({listProcesses:async()=>[],launch:async()=>{},
    connect:async()=>({page:{evaluate:async()=>({ready:false,home:true,reason:'resources_pending',resources:{finiteAnimations:1}})},browser:{close:async()=>{}}}),
    now:()=>clock,sleep:async ms=>{clock+=ms;},timeoutMs:300}),e=>{
      assert.equal(e.coldDiagnostic.stage,'observe');assert.equal(e.coldDiagnostic.observations.resources.finiteAnimations,1);
      assert.deepEqual(e.coldDiagnostic.preparationActions,[]);assert.match(e.message,/没有生成耗时样本/);return true;
    });
});
