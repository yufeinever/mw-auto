import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Manager, aggregateWarm } from '../lib/manager.mjs';
import { runColdStartup, homepageReadiness, prepareHomepage } from '../lib/cold-start.mjs';
import { loadPlaywright } from '../lib/dependencies.mjs';
import { createConsole } from '../server.mjs';

async function fixture(t,options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-cold-warm-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const m=new Manager(root,[{id:'a'}],options);await m.init();return m;
}
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition timeout');}
const sample=n=>({id:'a',functional:'pass',restored:true,assertions:[],limitations:[],measurements:[{label:'load',durationMs:n,targetRelation:'direct'}],performance:{hotThresholdMs:100}});

test('warm case executes twice, discards warmup, and records only the second execution',async t=>{
  let n=0;const times=[900,20],m=await fixture(t,{spawnCase:async()=>sample(times[n++])});
  const run=await m.start(['a']);await until(()=>!m.active);
  const r=(await m.read(run.id)).results[0];
  assert.equal(n,2);assert.equal(run.repetitions,2);assert.deepEqual(r.measurements.map(x=>[x.iteration,x.durationMs]),[[2,20]]);
  assert.equal(r.statistics[0].durationMs,20);assert.equal(r.statistics[0].meanMs,undefined);assert.equal(r.performance.comparison,'within_reference');
  assert.deepEqual(r.repetition,{planned:2,completed:2,warmupDiscarded:true,recordedIterations:[2]});
  assert.equal(JSON.stringify(r).includes('900'),false,'discard warmup timing from stored result');
});
test('failed second execution retains failure and cannot fabricate a formal timing',async t=>{
  let n=0;const m=await fixture(t,{spawnCase:async()=>++n===1?sample(900):{...sample(0),functional:'failed',measurements:[],reason:'timeout'}});
  const run=await m.start(['a']);await until(()=>!m.active);
  assert.equal(n,2);assert.equal(run.results[0].functional,'failed');assert.deepEqual(run.results[0].measurements,[]);
  assert.equal(run.results[0].repetition.completed,2);
  const stopped=aggregateWarm('a',[sample(900)]);assert.equal(stopped.functional,'partial');assert.equal(stopped.statistics.length,0);
});

test('second execution determines coverage and preserves every separately timed operation',()=>{
  const warmup={...sample(900),functional:'partial'},formal={...sample(20),measurements:[...sample(20).measurements,{label:'select',durationMs:40}]};
  const r=aggregateWarm('a',[warmup,formal]);
  assert.equal(r.functional,'pass');assert.deepEqual(r.statistics.map(s=>[s.label,s.durationMs]),[['load',20],['select',40]]);
  assert.equal(r.repeats.length,1);assert.equal(r.warmup.functional,'partial');
  assert.equal(aggregateWarm('a',[sample(20),{...sample(40),functional:'partial'}]).functional,'partial');
});

test('warmup failure or failed recovery stops before the formal execution',async t=>{
  for(const change of [{functional:'failed',reason:'warmup failed'},{functional:'blocked'},{restored:false}]){
    let calls=0;const m=await fixture(t,{spawnCase:async()=>{calls++;return {...sample(900),...change};}});
    const run=await m.start(['a']);await until(()=>!m.active||run.status==='waiting_recovery');
    if(m.active)await m.control('stop');
    assert.equal(calls,1);assert.notEqual(run.results[0].functional,'pass');
    assert.deepEqual(run.results[0].measurements,[]);assert.deepEqual(run.results[0].repetition.recordedIterations,[]);
  }
});

test('a stopped warmup has no formal result and legacy three-round aggregation remains readable',async t=>{
  let m; m=await fixture(t,{spawnCase:async()=>{m.active.stopRequested=true;return sample(900);}});
  const run=await m.start(['a']);await until(()=>!m.active);
  assert.equal(run.status,'stopped');assert.equal(run.results[0].functional,'partial');assert.deepEqual(run.results[0].measurements,[]);
  const legacy=aggregateWarm('a',[sample(900),sample(20),sample(30)],3);
  assert.equal(legacy.statistics[0].meanMs,25);assert.deepEqual(legacy.repetition.recordedIterations,[2,3]);
});

test('browser submits two executions, shows second-only timings and labels old averages as history',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-second-ui-'));
  const source=path.resolve(import.meta.dirname,'..');
  await fs.mkdir(path.join(root,'data'));await fs.mkdir(path.join(root,'runs'));
  await fs.cp(path.join(source,'public'),path.join(root,'public'),{recursive:true});
  const catalog=['a','b'].map(id=>({id,name:'case '+id,module:'test',hotSeconds:1,coldSeconds:1}));
  await fs.writeFile(path.join(root,'data/cases.json'),JSON.stringify(catalog));
  const legacy={id:'1234567890-legacy',mode:'warm',status:'completed',selected:['a'],startedAt:'2026-01-01',logs:[],results:[aggregateWarm('a',[sample(900),sample(20),sample(30)],3)]};
  const raw=JSON.stringify(legacy);await fs.writeFile(path.join(root,'runs',legacy.id+'.json'),raw);
  let calls=0;const app=await createConsole({port:0,projectRoot:root,managerOptions:{spawnCase:async()=>sample(++calls===1?900:42)}});
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  t.after(async()=>{await browser.close();await new Promise(r=>app.server.close(r));await fs.rm(root,{recursive:true,force:true});});
  const page=await browser.newPage();await page.goto('http://127.0.0.1:'+app.port);
  await page.locator('#run-cold:disabled').waitFor();
  assert.equal(await page.locator('#run').innerText(),'热启动所选');
  assert.equal(await page.getByRole('button',{name:'热启动',exact:true}).count(),2);
  assert.match(await page.locator('#cases tr').first().locator('.help').getAttribute('title'),/历史第2、3轮/);
  await page.locator('[data-run="b"]').click();await until(()=>calls===2&&!app.manager.active);
  await page.locator('[data-detail="b"]').click();
  await page.locator('#details').filter({hasText:'完成 2/2 次'}).waitFor();
  const row=await page.locator('#cases tr').last().innerText(),details=await page.locator('#details').innerText();
  assert.match(row,/42\s*ms/);assert.match(row,/目标 ≤ 1000 ms/);assert.equal(await page.locator('#cases tr').last().locator('.comparison.good').innerText(),'达标');assert.match(await page.locator('#cases tr').last().locator('.help').getAttribute('title'),/第2次执行结果/);assert.doesNotMatch(row,/第2次|首次预热/);assert.doesNotMatch(row,/900|均值/);
  assert.match(details,/第2次正式执行 42 ms/);assert.doesNotMatch(details,/900|第 3 轮/);
  await page.locator('[data-detail="a"]').click();assert.match(await page.locator('#details').innerText(),/历史第 2、3 轮均值 25 ms/);
  assert.equal(await fs.readFile(path.join(root,'runs',legacy.id+'.json'),'utf8'),raw);
});
test('cold launch requires user confirmation and exited processes, and reserves the queue during preflight',async t=>{
  let calls=0,resolve;const m=await fixture(t,{listProcesses:()=>new Promise(r=>resolve=r),spawnCase:async()=>{calls++;return sample(1);}});
  await assert.rejects(()=>m.startCold(false,['a']),/托盘/);
  const pending=m.startCold(true,['a']);await until(()=>!!resolve);
  await assert.rejects(()=>m.start(['a']),/占用/);await assert.rejects(()=>m.startCold(true,['a']),/占用/);
  resolve([123]);await assert.rejects(()=>pending,/仍在运行/);assert.equal(calls,0);assert.equal(m.active,null);
  m.listProcesses=async()=>[];const run=await m.startCold(true,['a']);await until(()=>!m.active);
  assert.equal(run.mode,'cold');assert.equal(run.repetitions,1);assert.equal(calls,1);
});
test('cold worker independently rejects a running MW without launching',async()=>{
  let launches=0;
  await assert.rejects(()=>runColdStartup({listProcesses:async()=>[123],launch:async()=>launches++}),/仍在运行/);
  assert.equal(launches,0);
});
test('cold clock includes launch and connection delay; timeout yields no sample and detaches without quitting MW',async()=>{
  let clock=0,closed=0,observed=0;
  const connection={browser:{close:async()=>closed++},page:{evaluate:async()=>({ready:++observed>1,taskCount:5})}};
  const options={listProcesses:async()=>[],launch:async()=>{clock+=700;},connect:async()=>{clock+=300;return connection;},prepare:async()=>{},now:()=>clock,sleep:async ms=>{clock+=ms;},timeoutMs:2000};
  const r=await runColdStartup(options);assert.ok(r.durationMs>=1200);assert.equal(closed,1);
  clock=0;closed=0;connection.page.evaluate=async()=>({ready:false});
  await assert.rejects(()=>runColdStartup(options),/没有生成耗时样本/);assert.equal(closed,1);
});
test('homepage readiness waits for initial task data and rejects an active loading indicator',async t=>{
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<main><h1>Mobile熠动，Work智简</h1><h2 id="recent-tasks-heading">工作任务（2）</h2><div data-testid="recent-tasks-scroll"></div><div data-testid="workspace-scroll"><div data-workspace-row-header>workspace</div></div><div role="textbox" contenteditable="true"></div></main>');
  await page.evaluate(()=>{location.hash='/workspace/test/session';});
  assert.equal((await page.evaluate(homepageReadiness)).ready,false,'empty list is not a loaded list');
  await page.evaluate(()=>{document.querySelector('[data-testid="recent-tasks-scroll"]').innerHTML='<button data-slot="context-menu-trigger">one</button><button>查看更多</button>';});
  assert.equal((await page.evaluate(homepageReadiness)).ready,true,'first page with a more button can be ready');
  await page.evaluate(()=>{document.querySelector('main').insertAdjacentHTML('beforeend','<div role="progressbar">loading</div>');});
  assert.equal((await page.evaluate(homepageReadiness)).ready,false);
});
test('cold homepage preparation selects the visible new-task control when an off-screen sidebar duplicates it',async t=>{
  const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  t.after(()=>browser.close());const page=await browser.newPage();
  await page.setContent('<button style="position:absolute;left:-600px">新建任务</button><button aria-label="新建任务" id="actual">New</button><script>actual.onclick=()=>location.hash="/workspace/test/session"</script>');
  await page.evaluate(()=>{location.hash='/workspace/test/session/history';});
  await prepareHomepage(page);assert.equal(await page.evaluate(()=>location.hash),'#/workspace/test/session');
});
test('cold HTTP endpoint is protected, runs once after confirmation, and keeps cold results out of warm latest',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-cold-http-'));await fs.mkdir(path.join(root,'data'));
  await fs.writeFile(path.join(root,'data/cases.json'),JSON.stringify([{id:'a'}]));
  let processes=[123],calls=0;
  const app=await createConsole({port:0,projectRoot:root,managerOptions:{listProcesses:async()=>processes,spawnCase:async(id,mode)=>{calls++;return {...sample(30),mode};}}});
  t.after(async()=>{await new Promise(r=>app.server.close(r));await fs.rm(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.port}`,state=await fetch(base+'/api/state').then(r=>r.json());
  const post=body=>fetch(base+'/api/cold-start',{method:'POST',headers:{'X-MW-CSRF':state.csrf},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/cold-start',{method:'POST',body:'{}'})).status,403);
  assert.equal((await post({ids:['a']})).status,409);
  assert.equal((await post({confirmed:true,ids:['a']})).status,409);assert.equal(calls,0);
  processes=[];assert.equal((await post({confirmed:true,ids:['../../bad']})).status,409);
  assert.equal((await post({confirmed:true,ids:['a']})).status,202);await until(()=>!app.manager.active);
  const after=await fetch(base+'/api/state').then(r=>r.json());
  assert.equal(calls,1);assert.equal(after.latestColdResults.a.mode,'cold');assert.equal(after.latestResults.a,undefined);
});
