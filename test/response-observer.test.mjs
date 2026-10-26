import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {startResponseObserver,parseProxyLine} from '../lib/response-observer.mjs';
import {executeWorker} from '../lib/worker.mjs';
import {aggregateWarm} from '../lib/manager.mjs';
import {createConsole} from '../server.mjs';
import {loadPlaywright} from '../lib/dependencies.mjs';
import {observationMarkdown} from '../public/response-view.js';
const root=path.resolve(import.meta.dirname,'..');
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mw-observer-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
const log=(event,data)=>`${new Date().toISOString()} [INFO] [main] [model-proxy] ${event} ${JSON.stringify(data)}\n`;
const wait=ms=>new Promise(r=>setTimeout(r,ms));

test('proxy tail only observes new lines, redacts data, tolerates rotation and missing files',async t=>{
 const dir=await temp(t),file=path.join(dir,'main.log');await fs.writeFile(file,log('upstream_response',{status:418,durationMs:999}));
 const observer=await startResponseObserver({logPath:file,intervalMs:60000,maxEvents:3});t.after(()=>observer.stop());
 const line=log('upstream_response',{status:503,durationMs:40205,headers:{Authorization:'PRIVATE'},url:'https://PRIVATE',body:'PRIVATE'});
 await fs.appendFile(file,line.slice(0,-2));await observer.flush();assert.equal(observer.snapshot().proxy.events.length,0);
 await fs.appendFile(file,line.slice(-2)+log('stream_end',{reason:'completed',durationMs:0,modelCallId:'private-call'}));await observer.flush();
 const snapshot=observer.snapshot();assert.equal(snapshot.proxy.events.length,2);assert.equal(snapshot.proxy.events[0].status,503);
 assert.equal(snapshot.proxy.events[1].association,'unattributed');assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE|private-call|418/);
 await fs.rename(file,file+'.old');await fs.writeFile(file,log('request_start',{modelCallId:'private-call'}));await observer.flush();
 assert.equal(observer.snapshot().proxy.rotationCount,1);assert.equal(observer.snapshot().proxy.events[2].callKey,snapshot.proxy.events[1].callKey);
 await fs.appendFile(file,log('request_failed',{reason:'PRIVATE'}));await observer.flush();assert.equal(observer.snapshot().proxy.dropped,1);
 await fs.unlink(file);await observer.flush();assert.equal(observer.snapshot().proxy.status,'unavailable');
 assert.equal(parseProxyLine('not json'),null);assert.equal((await observer.stop()).complete,true);
});

test('network metadata handles redirects, HTTP errors and transport failures without bodies or URLs',async t=>{
 const dir=await temp(t),cdp=new EventEmitter();cdp.send=async()=>{};cdp.detach=async()=>{};
 const observer=await startResponseObserver({logPath:path.join(dir,'absent'),intervalMs:60000,maxRequests:4});t.after(()=>observer.stop());
 await observer.attach({context:()=>({newCDPSession:async()=>cdp})});await observer.setPhase('execution');
 const request=(id,time)=>cdp.emit('Network.requestWillBeSent',{requestId:id,timestamp:time,request:{url:'https://user:PRIVATE@example.test/workspace/private-session/message?token=PRIVATE',method:'GET'}});
 request('a',10);cdp.emit('Network.responseReceived',{requestId:'a',timestamp:10.05,response:{status:503,timing:{requestTime:10,receiveHeadersEnd:40},headers:{Authorization:'PRIVATE'}}});
 cdp.emit('Network.loadingFinished',{requestId:'a',timestamp:10.06,encodedDataLength:114});
 request('b',11);cdp.emit('Network.loadingFailed',{requestId:'b',timestamp:11.03,errorText:'PRIVATE error'});
 request('c',12);cdp.emit('Network.requestWillBeSent',{requestId:'c',timestamp:12.1,redirectResponse:{status:302},request:{url:'https://example.test/health',method:'GET'}});
 cdp.emit('Network.eventSourceMessageReceived',{data:'PRIVATE'});cdp.emit('Network.webSocketFrameReceived',{response:{payloadData:'PRIVATE'}});request('over',13);
 const result=await observer.stop(),rows=result.network.requests;
 assert.equal(rows[0].headersMs,40);assert.equal(rows[0].durationMs,60);assert.equal(rows[0].status,503);
 assert.equal(rows[1].errorCode,'network_failure');assert.equal(rows[2].outcome,'redirected');assert.equal(rows[3].outcome,'observation_ended');
 assert.equal(result.network.dropped,1);assert.equal(result.network.counts.sse,1);assert.equal(cdp.listenerCount('Network.loadingFinished'),0);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|private-session|example.test|user:/);
});

test('worker timeout retains completed samples and observation while warmup evidence stays separate',async t=>{
 const dir=await temp(t),file=path.join(dir,'worker.mjs');
 await fs.writeFile(file,`process.send({type:'progress',stage:'收尾',measurements:[{label:'已完成操作',durationMs:25,complete:true}],observation:{policy:'response-observation-v1',complete:false,proxy:{status:'observing',events:[{event:'upstream_response',status:503,association:'unattributed'}]}}});setInterval(()=>{},1000);`);
 const r=await executeWorker({file,cwd:dir,timeoutMs:1200});assert.equal(r.functional,'interrupted');assert.equal(r.workerExited,true);assert.equal(r.measurements[0].durationMs,25);assert.equal(r.observation.complete,false);
 const aggregate=aggregateWarm('case',[{...r,startedAt:new Date().toISOString()}, {...r,functional:'pass',restored:true}],2);
 assert.equal(aggregate.observationAttempts.length,2);assert.equal(aggregate.measurements.length,1);assert.equal(aggregate.measurements[0].iteration,2);
 assert.equal(aggregate.warmup.measurements[0].durationMs,25);
 const report=observationMarkdown([aggregate]);assert.match(report,/预热/);assert.match(report,/未归属/);assert.match(report,/503/);assert.equal(aggregate.functional,'interrupted');
});

test('built console renders response evidence and legacy records without page errors',async t=>{
 const dir=await temp(t);await fs.mkdir(path.join(dir,'data'));await fs.mkdir(path.join(dir,'runs'));await fs.cp(path.join(root,'public'),path.join(dir,'public'),{recursive:true});
 const catalog=[{id:'MW-UI-005',row:5,name:'响应验证',module:'测试',script:'fixture',coldSeconds:1,hotSeconds:1},{id:'MW-UI-006',row:6,name:'旧记录',module:'测试',script:'fixture'}];await fs.writeFile(path.join(dir,'data/cases.json'),JSON.stringify(catalog));
 const observation={complete:true,network:{status:'observing',counts:{started:1},requests:[{method:'GET',route:'/events',phase:'execution',status:200,local:true,headersMs:5,durationMs:8,outcome:'finished'}]},proxy:{status:'observing',events:[{event:'upstream_response',status:503,reportedDurationMs:40205,phase:'execution',association:'unattributed'}]}};
 const run={id:'response-fixture',status:'completed',mode:'warm',selected:catalog.map(c=>c.id),startedAt:new Date().toISOString(),logs:[],results:catalog.map((c,i)=>({id:c.id,mode:'warm',functional:'pass',restored:true,assertions:[],measurements:[],...(i===0?{observation}:{} )}))};await fs.writeFile(path.join(dir,'runs/response-fixture.json'),JSON.stringify(run));
 const app=await createConsole({port:0,projectRoot:dir});t.after(()=>new Promise(r=>app.server.close(r)));
 const {chromium}=loadPlaywright(),browser=await chromium.launch({channel:'msedge',headless:true});t.after(()=>browser.close());const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${app.port}`);await page.locator('[data-detail="MW-UI-005"]').click();
 await page.getByRole('heading',{name:'网络与模型响应',exact:true}).waitFor();assert.match(await page.locator('#details').innerText(),/未确认用例归属/);
 await page.getByText('查看采集明细',{exact:true}).click();assert.match(await page.locator('#details').innerText(),/503/);assert.match(await page.locator('#details').innerText(),/40205/);
 const exported=await(await fetch(`http://127.0.0.1:${app.port}/api/runs/response-fixture`)).json();assert.equal(exported.results[0].observation.proxy.events[0].status,503);
 await page.locator('[data-detail="MW-UI-006"]').click();assert.match(await page.locator('#details').innerText(),/历史记录未采集/);assert.deepEqual(errors,[]);
});

test('live MW passive observation collects real traffic without changing route or draft', {skip:process.env.MW_LIVE_OBSERVE!=='1'},async t=>{
 const {chromium}=loadPlaywright(),browser=await chromium.connectOverCDP('http://127.0.0.1:9223',{timeout:5000});t.after(()=>browser.close());
 const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>/MobileWork\/resources\/app-dist\/index\.html/i.test(p.url()));assert.equal(pages.length,1);const page=pages[0];
 const view=()=>page.evaluate(()=>({url:location.href,draft:[...document.querySelectorAll('[role="textbox"][contenteditable="true"]')].filter(e=>e.getClientRects().length).map(e=>e.textContent)}));
 const before=await view(),observer=await startResponseObserver();t.after(()=>observer.stop());await observer.attach(page);await observer.setPhase('execution');await wait(10000);const result=await observer.stop();
 assert.equal(result.network.status,'observing');assert.ok(result.network.counts.responses>0);assert.deepEqual(await view(),before);
 await fs.writeFile(path.join(root,'data/v0020-live-observation.json'),JSON.stringify(result,null,2));
});
