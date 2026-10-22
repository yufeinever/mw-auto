import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {Manager} from '../lib/manager.mjs';
import {runColdStartup} from '../lib/cold-start.mjs';
import {casePhase,visibleResults,executionPlan} from '../public/batch-view.js';
import {metricRows} from '../public/metric-view.js';
import {createConsole} from '../server.mjs';
import {loadPlaywright} from '../lib/dependencies.mjs';

const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const catalog=[{id:'a',name:'用例 A',module:'测试',coldSeconds:1,hotSeconds:1},{id:'b',name:'用例 B',module:'测试',coldSeconds:1,hotSeconds:1}];
async function root(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-combined-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
async function until(fn){for(let i=0;i<400;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('condition timeout');}
const sample=(id,mode)=>({id,functional:'pass',restored:true,assertions:['synthetic'],measurements:[{label:'sample',durationMs:20,complete:true}],...(mode==='cold'||mode==='manual-restart'?{coldStart:{durationMs:mode==='cold'?100:null,scope:'synthetic',method:mode}}:{})});

test('combined batch runs a full cold round then one hot round; recovery failures do not stop either round',async t=>{
  const calls=[];
  const m=new Manager(await root(t),catalog,{listProcesses:async()=>[123],spawnCase:async(id,mode)=>{
      calls.push([id,mode]);return {...sample(id,mode),...(id==='b'&&mode==='after-cold-start'?{functional:'failed',restored:false}:{})};
    }});t.after(()=>m.close());await m.init();
  await assert.rejects(()=>m.startCombined(['a'],'unknown'),/重启/);
  const run=await m.startCombined(['a','b'],'manual');await until(()=>!m.active);
  assert.equal(run.selected.length,2);assert.equal(executionPlan(run).length,4);assert.equal(run.schedulingHold,false);
  assert.deepEqual(calls,[['a','manual-restart'],['b','after-cold-start'],['a','warm'],['b','warm']]);
  assert.deepEqual(run.results.map(r=>[r.id,r.mode,r.round]),[['a','cold',1],['b','cold',1],['a','warm',2],['b','warm',2]]);
  assert.equal(run.results[1].functional,'failed');assert.equal(run.results[1].restored,false);assert.equal(run.status,'completed');
  for(const r of run.results){assert.ok(r.startedAt&&r.endedAt);assert.equal(r.measurements.length,1);assert.equal(r.repetition,undefined);}
  assert.equal(metricRows(run.results[2])[0].history,false);
});

test('tray-exit path rejects a running client and keeps cold startup evidence for the hot round',async t=>{
  let processes=[1];const calls=[];
  const m=new Manager(await root(t),catalog,{listProcesses:async()=>processes,spawnCase:async(id,mode)=>{calls.push(mode);processes=[2];return sample(id,mode);}});
  t.after(()=>m.close());await m.init();await assert.rejects(()=>m.startCombined(['a'],'launch'),/托盘退出/);assert.equal(calls.length,0);
  processes=[];const run=await m.startCombined(['a'],'launch');await until(()=>!m.active);
  assert.deepEqual(calls,['cold','warm']);assert.equal(run.coldStart.durationMs,100);assert.equal(run.results.length,2);assert.equal(run.results[0].startupPerformed,true);
});

test('manual restart waits for readiness without launching or inventing a startup measurement',async()=>{
  let observed=0,closed=0,clock=0;
  const result=await runColdStartup({alreadyRestarted:true,listProcesses:async()=>{throw Error('must not require exited client');},
    launch:async()=>{throw Error('must not relaunch');},connect:async()=>({browser:{close:async()=>closed++},page:{evaluate:async()=>({home:true,ready:++observed>1,reason:'resources_loading'})}}),
    now:()=>clock,sleep:async()=>{clock+=100;},prepare:async()=>{throw Error('unexpected navigation');}});
  assert.equal(observed,3);assert.equal(closed,1);assert.equal(result.durationMs,null);assert.equal(result.launchAt,null);
  assert.equal(result.method,'user-confirmed-restart-observed-homepage-ready');
});

test('current batch replaces old results with queued phases and actual per-phase timestamps',()=>{
  const old={id:'a',functional:'pass',startedAt:'2026-10-21T12:00:00Z',endedAt:'2026-10-21T12:01:00Z'};
  const state={latestResults:{a:old},latestColdResults:{a:old}};
  const run={mode:'combined',selected:['a','b'],plan:['cold','warm'].flatMap(mode=>['a','b'].map(id=>({id,mode}))),results:[],status:'running',current:'b',currentMode:'cold',currentStartedAt:'2026-10-22T12:00:00Z'};
  assert.equal(visibleResults(state,run,'cold').a,undefined);assert.equal(visibleResults(state,run,'warm').a,undefined);
  assert.equal(casePhase(run,'a','cold',old).status,'queued');assert.equal(casePhase(run,'a','warm',old).startedAt,null);
  assert.equal(casePhase(run,'b','cold').status,'running');assert.equal(casePhase(run,'b','cold').startedAt,run.currentStartedAt);
  run.results.push({...old,mode:'cold',functional:'failed',startedAt:'2026-10-22T11:00:00Z'});
  assert.equal(casePhase(run,'a','cold').status,'failed');assert.equal(casePhase(run,'a','warm').status,'queued');
  run.status='stopped';run.current=null;assert.equal(casePhase(run,'a','warm').status,'cancelled');
  assert.equal(visibleResults(state,run,'warm',true).a,undefined);assert.equal(old.functional,'pass');
});

test('browser/API acceptance: restart choices, queued rows, both rounds, timestamps and retained selection',async t=>{
  const dir=await root(t);await fs.mkdir(path.join(dir,'data'));await fs.cp(path.join(source,'public'),path.join(dir,'public'),{recursive:true});await fs.writeFile(path.join(dir,'data/cases.json'),JSON.stringify(catalog));
  let release;const calls=[];
  const app=await createConsole({port:0,projectRoot:dir,managerOptions:{listProcesses:async()=>[123],spawnCase:async(id,mode)=>{
    calls.push([id,mode]);if(calls.length===1)await new Promise(r=>{release=r;});return sample(id,mode);
  }}});
  const old={id:'1234567890-history',startedAt:'2026-10-21T12:00:00Z',status:'stopped',schedulingHold:true,handoff:{ready:false,reason:'legacy cleanup failure'},mode:'warm',selected:['a','b'],logs:[],results:catalog.map(c=>({...sample(c.id,'warm'),restored:false,startedAt:'2026-10-21T12:00:00Z',endedAt:'2026-10-21T12:01:00Z'}))};await app.manager.save(old);
  const {chromium}=loadPlaywright(),browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
  t.after(async()=>{release?.();await browser.close();app.manager.close();await new Promise(r=>app.server.close(r));});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${app.port}/`);await page.waitForFunction(()=>document.querySelectorAll('#cases tr').length===2);
  await page.locator('#run').click();assert.equal(await page.locator('#restart-dialog').isVisible(),true);assert.match(await page.locator('#restart-target').innerText(),/共 4 次/);
  await page.locator('#restart-help').click();assert.equal(await page.locator('#restart-guide').isVisible(),true);
  await page.locator('#restart-launch').click();await page.waitForFunction(()=>document.querySelector('#restart-message').textContent.includes('托盘退出'));assert.equal(calls.length,0);
  await page.locator('#restart-manual').click();await page.waitForFunction(()=>document.querySelector('[data-case="b"] .queued'));
  const retired=await app.manager.read(old.id);assert.equal(retired.schedulingHold,false);assert.deepEqual(retired.results,old.results);assert.equal(retired.handoff.ready,false);
  assert.equal(await page.locator('[data-case="b"] .queued').count(),2);assert.equal(await page.locator('[data-case="b"] .pass').count(),0);
  assert.ok(!(await page.locator('[data-case="b"] .case-start').innerText()).includes('2026'));
  assert.ok((await page.locator('[data-case="a"] .case-start').innerText()).includes('2026'));
  assert.equal(await page.locator('thead th').count(),8);
  await page.screenshot({path:path.join(source,'data/v0018-queued.png'),fullPage:true});
  release();await until(()=>!app.manager.active);await page.waitForFunction(()=>document.querySelector('#counter').textContent==='4 / 4 次执行');
  assert.equal(await page.locator('[data-case="b"] .pass').count(),2);assert.ok((await page.locator('[data-case="b"] .case-end').innerText()).includes('2026'));
  const s=await fetch(`http://127.0.0.1:${app.port}/api/state`).then(r=>r.json());assert.equal(s.latestResults.a.round,2);assert.equal(s.latestColdResults.a.round,1);assert.equal(s.runs[0].total,4);
  const text=await page.locator('#logs').evaluate(el=>{const r=document.createRange();r.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(r);return getSelection().toString();});
  await page.waitForTimeout(3100);assert.equal(await page.evaluate(()=>getSelection().toString()),text);await page.evaluate(()=>getSelection().removeAllRanges());
  await page.screenshot({path:path.join(source,'data/v0018-completed.png'),fullPage:true});
  // A successful business assertion must not hide a failed cleanup.
  const stopped=await app.manager.read(s.latest.id);stopped.status='stopped';stopped.schedulingHold=true;stopped.handoff={ready:false,caseId:'b',reason:'synthetic cleanup failure'};
  stopped.results.at(-1).restored=false;stopped.results.at(-1).cleanupIssues=['synthetic cleanup failure'];await app.manager.save(stopped);
  await page.waitForFunction(()=>document.querySelector('[data-case="b"] .recovery_failed'));
  assert.equal((await app.manager.read(stopped.id)).results.at(-1).functional,'pass');assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(source,'data/v0018-browser-verification.json'),JSON.stringify({passed:true,pageErrors:errors,calls,scope:'isolated console with synthetic workers; no real MW restart or product execution'},null,2));
});
