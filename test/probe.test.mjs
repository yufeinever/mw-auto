import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {endpoint,addressType,summarizeRequests,sanitizeTrace,summarizeTrace} from '../lib/probe-data.mjs';
import {ProbeManager} from '../lib/probe-manager.mjs';
import {startPageCapture,startNetworkCapture} from '../lib/probe-collectors.mjs';

test('probe redacts before persistence and classifies IPv4/IPv6 without guessing DNS',()=>{
  const ep=endpoint('http://user:secret@172.16.1.2:9070/workspace/ws_ABC123456/sessions/ses_secret?token=SECRET#cookie');
  assert.equal(ep.endpoint,'http://172.16.1.2:9070/workspace/:id/sessions/:id');
  assert.equal(ep.addressType,'private');assert.equal(addressType('172.32.1.1'),'public');assert.equal(addressType('[::1]'),'local');assert.equal(addressType('::ffff:10.0.0.1'),'private');assert.equal(addressType('fd00::1'),'private');assert.equal(addressType('server.internal'),'domain');
  const row=sanitizeTrace({cat:'netlog',name:'HTTP_TRANSACTION_READ_RESPONSE_HEADERS',ph:'n',id:'0x1',pid:1,ts:1000,args:{params:{headers:['HTTP/1.1 503 Unavailable','Authorization: secret'],postData:'secret',url:'https://host/api?token=SECRET'}}});
  assert.equal(row.status,503);assert.doesNotMatch(JSON.stringify(row),/secret|SECRET|Authorization|postData/);
});
test('frequency counts request starts including pending, errors stay distinct and intervals do not mix resources',()=>{
  const base={method:'GET',...endpoint('http://127.0.0.1/workspace/ws_abcdef/events')};
  const rows=[{...base,startMs:0,endMs:3000,durationMs:3000,headersMs:20,status:200,outcome:'finished'},
    {...base,startMs:1000,instanceKey:'other',status:500,outcome:'incomplete',headersMs:10},
    {...base,startMs:10000,endMs:11000,status:0,outcome:'failed'},
    {...base,startMs:20000,outcome:'pending'}];
  const [g]=summarizeRequests(rows,60);assert.equal(g.count,4);assert.equal(g.rpm,4);assert.equal(g.intervalMedianMs,10000);assert.equal(g.httpErrors,1);assert.equal(g.failed,1);assert.equal(g.pending,2);assert.equal(g.duration.samples,1);assert.equal(g.duration.p95Ms,3000);assert.equal(g.peakConcurrent,2);
});
test('NetLog reconstructs request and phase durations with source identity and keeps unmatched events incomplete',()=>{
  const raw=(name,ph,ts,params={},id='0x1')=>sanitizeTrace({name,ph,ts,cat:'netlog',id,pid:2,args:{params}});
  const events=[raw('REQUEST_ALIVE','b',1000,{url:'http://10.0.0.1/api'}),raw('URL_REQUEST_START_JOB','b',1100,{method:'GET'}),raw('HTTP_TRANSACTION_READ_RESPONSE_HEADERS','n',11000,{headers:['HTTP/1.1 200 OK']}),raw('REQUEST_ALIVE','e',21000),raw('TCP_CONNECT','b',1000,{},'0x2'),raw('TCP_CONNECT','e',6000,{},'0x2'),raw('REQUEST_ALIVE','b',30000,{url:'http://10.0.0.1/api'},'0x3')];
  const t=summarizeTrace(events);assert.equal(t.requests[0].durationMs,20);assert.equal(t.requests[0].headersMs,10);assert.equal(t.requests[0].method,'GET');assert.equal(t.requests[1].outcome,'incomplete');assert.equal(t.phases[0].medianMs,5);
});
test('page capture pairs CDP ids across redirects and stop without inventing end times',async()=>{
  const session=new EventEmitter();session.send=async()=>{};session.detach=async()=>{};
  const context=new EventEmitter(),page=new EventEmitter();page.context=()=>context;context.newCDPSession=async()=>session;context.pages=()=>[page];
  const s={gaps:0,dropped:0},events=[];const cap=await startPageCapture({contexts:()=>[context]},(k,r)=>events.push(structuredClone(r)),s);
  const request=(id,ts,url,extra={})=>session.emit('Network.requestWillBeSent',{requestId:id,timestamp:ts,wallTime:1700000000+ts,request:{url,method:'GET'},...extra});
  request('1',1,'http://10.0.0.1/api?token=SECRET');request('1',2,'http://10.0.0.1/models',{redirectResponse:{status:302}});
  session.emit('Network.responseReceived',{requestId:'1',timestamp:2.9,response:{status:200,mimeType:'application/json',timing:{requestTime:2.01,receiveHeadersEnd:90}}});
  session.emit('Network.loadingFinished',{requestId:'1',timestamp:2.5,encodedDataLength:20});request('2',3,'http://10.0.0.1/events');await cap.stop();
  assert.equal(cap.rows.length,3);assert.equal(cap.rows[0].outcome,'redirected');assert.equal(Math.round(cap.rows[1].headersMs),100);assert.equal(cap.rows[1].durationMs,500);assert.equal(cap.rows[2].outcome,'incomplete');assert.equal(cap.rows[2].durationMs,undefined);assert.doesNotMatch(JSON.stringify(events),/SECRET/);
});

test('NetLog separates redirected URLs and excludes SSE full duration from latency',()=>{
  const raw=(name,ph,ts,params={})=>sanitizeTrace({name,ph,ts,cat:'netlog',id:'0x1',pid:2,args:{params}});
  const t=summarizeTrace([
    raw('REQUEST_ALIVE','b',1000,{url:'http://10.0.0.1/api'}),
    raw('URL_REQUEST_START_JOB','b',1100,{url:'http://10.0.0.1/api',method:'GET'}),
    raw('HTTP_TRANSACTION_READ_RESPONSE_HEADERS','n',2000,{headers:['HTTP/1.1 302 Found']}),
    raw('URL_REQUEST_START_JOB','b',3000,{url:'http://10.0.0.1/events',method:'GET'}),
    raw('HTTP_TRANSACTION_READ_RESPONSE_HEADERS','n',4000,{headers:['HTTP/1.1 200 OK','Content-Type: text/event-stream']}),
    raw('REQUEST_ALIVE','e',11000)
  ]);
  assert.equal(t.requests.length,2);assert.equal(t.requests[0].outcome,'redirected');
  assert.equal(t.requests[1].headersMs,1);assert.equal(t.requests[1].durationMs,8);
  const rows=summarizeRequests(t.requests,60);assert.equal(rows.find(r=>r.endpoint.endsWith('/events')).duration.samples,0);
});

test('unavailable page subscription remains unavailable and foreign tracing is not stopped',async()=>{
  const s=new EventEmitter(),calls=[];let detached=0;
  s.detach=async()=>detached++;s.send=async name=>{calls.push(name);if(name==='Tracing.getCategories')return {categories:['netlog']};throw Error('busy');};
  const context=new EventEmitter(),page=new EventEmitter();page.context=()=>context;context.newCDPSession=async()=>s;context.pages=()=>[page];
  const status={gaps:0,dropped:0};const capture=await startPageCapture({contexts:()=>[context]},()=>{},status);await capture.stop();
  assert.equal(status.state,'unavailable');assert.equal(status.gaps,1);
  await assert.rejects(startNetworkCapture({newBrowserCDPSession:async()=>s},()=>{},{gaps:0,dropped:0}));
  assert.equal(calls.includes('Tracing.end'),false);assert.equal(detached,2);
});
test('manager rejects duplicate start, saves unavailable layers honestly, and reloads interrupted snapshots',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-probe-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  let reject;const manager=new ProbeManager(root,{connect:()=>new Promise((_,r)=>reject=r)});await manager.init();
  const first=manager.start({application:true},{seconds:5});await assert.rejects(manager.start({application:true}),/已有/);
  while(!reject)await new Promise(r=>setTimeout(r,5));reject(Error('unavailable'));const result=await first;assert.equal(result.status,'failed');assert.equal(result.layers.application.state,'unavailable');assert.equal(manager.active,null);
  const file=path.join(manager.dir,result.id,'summary.json');result.status='recording';result.layers.application.state='recording';await fs.writeFile(file,JSON.stringify(result));
  const reloaded=new ProbeManager(root);await reloaded.init();assert.equal((await reloaded.read(result.id)).status,'interrupted');assert.equal(reloaded.active,null);
  await assert.rejects(reloaded.start({application:'yes'}),/请选择/);await assert.rejects(reloaded.read('../secret'),/无效/);
});
