import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {assessResult,assessRun} from '../lib/assessment.mjs';
import {createConsole} from '../server.mjs';
import {loadPlaywright} from '../lib/dependencies.mjs';
const sample=(id='MW-UI-005')=>({id,functional:'partial',testability:'partial',restored:true,assertions:['工作空间区展开、收起正常，5 个空间标题已挂载'],limitations:['没有逐项核对后台业务'],measurements:[{label:'展开工作空间区至空间标题就绪',durationMs:335.4,complete:true,targetRelation:'supporting'}]});
test('a reviewed visible completion passes without changing raw evidence or pretending business coverage',()=>{
 const raw=sample(),before=structuredClone(raw),result=assessResult(raw);
 assert.equal(result.functional,'pass');assert.equal(result.sourceFunctional,'partial');assert.match(result.assessment.scope,/工作空间列表/);
 assert.deepEqual(raw,before);assert.deepEqual(result.measurements,raw.measurements);assert.deepEqual(result.limitations,raw.limitations);
 assert.deepEqual(assessResult(result),result);
});
test('loading assessment requires successful terminal measurements, assertions, cleanup and full repetitions',()=>{
 const incomplete=[{restored:false},{cleanupIssues:['restore failed']},{assertions:[]},{measurements:[]},{reason:'not complete'},
  {measurements:[{...sample().measurements[0],complete:false}]},{measurements:[{...sample().measurements[0],durationMs:NaN}]},
  {originalScenario:{status:'blocked'}},{repetition:{planned:3,completed:2}}];
 for(const override of incomplete)assert.equal(assessResult({...sample(),...override}).functional,'partial');
 for(const functional of ['failed','blocked','interrupted'])assert.equal(assessResult({...sample(),functional,sourceFunctional:'partial'}).functional,functional);
});
test('explicitly loaded empty state passes, while missing and substituted scenarios retain their status',()=>{
 const empty={...sample('MW-UI-025'),assertions:['历史提问弹窗已加载，明确显示暂无历史提问'],measurements:[{label:'打开历史提问至浮层记录或明确空态就绪',durationMs:27.6,complete:true}]};
 assert.equal(assessResult(empty).functional,'pass');
 for(const id of ['MW-UI-013','MW-UI-018','MW-UI-037','MW-UI-045'])assert.equal(assessResult(sample(id)).functional,'partial');
});
test('browser shows cold operation times, shared startup, latest-result counts, and source assessment without rewriting history',async t=>{
 const source=path.dirname(path.dirname(fileURLToPath(import.meta.url))),root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-assessment-ui-'));
 await fs.mkdir(path.join(root,'data'));await fs.mkdir(path.join(root,'runs'));
 await fs.cp(path.join(source,'data/cases.json'),path.join(root,'data/cases.json'));await fs.cp(path.join(source,'public'),path.join(root,'public'),{recursive:true});
 const runId='1234567890-cold',startup={durationMs:7812.1,launchAt:'2026-10-20T10:10:45.182Z',scope:'simulated startup'};
 const run={id:runId,mode:'cold',status:'completed',startedAt:'2026-10-20T10:10:44.564Z',selected:['MW-UI-004','MW-UI-005','MW-UI-013','MW-UI-011'],coldStart:startup,coldStartCaseId:'MW-UI-004',current:null,logs:[],results:[
  {id:'MW-UI-004',functional:'pass',restored:true,startedAt:'2026-10-20T10:10:45Z',coldStart:startup,measurements:[]},
  {...sample(),startedAt:'2026-10-20T10:11:00Z',mode:'cold',batchStartupRef:{runId,caseId:'MW-UI-004'},startupPerformed:false},
  {...sample('MW-UI-013'),startedAt:'2026-10-20T10:11:01Z',originalScenario:{status:'blocked',reason:'原场景无入口'}},
  {id:'MW-UI-011',functional:'blocked',restored:true,startedAt:'2026-10-20T10:11:02Z',reason:'精选案例入口缺失',assertions:[],measurements:[]}
 ]};
 const warm={id:'1234567888-warm',mode:'warm',status:'completed',startedAt:'2026-10-20T09:00:00Z',selected:['MW-UI-005'],logs:[],results:[{...sample(),startedAt:'2026-10-20T09:00:01Z',measurements:[{label:'old',durationMs:100}]}]};
 const raw=JSON.stringify(run,null,2);await fs.writeFile(path.join(root,'runs',runId+'.json'),raw);await fs.writeFile(path.join(root,'runs',warm.id+'.json'),JSON.stringify(warm));
 const app=await createConsole({port:0,projectRoot:root});
 const browser=await loadPlaywright().chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
 t.after(async()=>{await browser.close();await new Promise(r=>app.server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${app.port}`,page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.locator('#passed').filter({hasText:'2'}).waitFor();
 assert.equal(await page.locator('#partial').innerText(),'1');assert.equal(await page.locator('#issues').innerText(),'1');
 const row=page.locator('tr').filter({has:page.locator('[data-detail="MW-UI-005"]')});
 assert.match(await row.locator('td').nth(3).innerText(),/100/);assert.match(await row.locator('td').nth(4).innerText(),/335.4/);
 assert.match(await page.locator('#cold-result').innerText(),/7812.1/);
 await row.locator('[data-detail]').click();assert.match(await page.locator('#detail-title').innerText(),/冷启动/);
 assert.match(await page.locator('#details').innerText(),/7812.1/);assert.match(await page.locator('#details').innerText(),/原记录为部分验证/);
 assert.equal(await page.locator('#cold-dialog').isVisible(),false);
 const projected=await fetch(base+'/api/runs/'+runId).then(r=>r.json());assert.equal(projected.results[1].functional,'pass');assert.equal(projected.results[2].functional,'partial');
 const original=await fetch(base+'/api/runs/'+runId+'?raw=1').then(r=>r.json());assert.deepEqual(original,run);assert.equal(await fs.readFile(path.join(root,'runs',runId+'.json'),'utf8'),raw);
 assert.deepEqual(errors,[]);assert.equal(assessRun(run).results[1].batchStartup.durationMs,7812.1);
});
