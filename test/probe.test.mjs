import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {endpoint,addressType,summarizeRequests,sanitizeTrace,summarizeTrace,summarizeChannels,summarizeTransports} from '../lib/probe-data.mjs';
import {recordProcessSample} from '../lib/probe-process-data.mjs';
import {protocolCoverage} from '../public/probe-coverage.js';
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

test('WS frames and SSE events/chunks remain independent from HTTP counts and never persist payloads',async()=>{
  const session=new EventEmitter();session.send=async()=>{};session.detach=async()=>{};
  const context=new EventEmitter(),page=new EventEmitter();page.context=()=>context;context.newCDPSession=async()=>session;context.pages=()=>[page];
  const events=[],status={gaps:0,dropped:0};const cap=await startPageCapture({contexts:()=>[context]},(k,r)=>events.push(structuredClone(r)),status);
  session.emit('Network.webSocketCreated',{requestId:'w',url:'wss://10.0.0.1/events?token=SECRET'});
  session.emit('Network.webSocketWillSendHandshakeRequest',{requestId:'w',timestamp:1,request:{headers:{Authorization:'SECRET'}}});
  session.emit('Network.webSocketHandshakeResponseReceived',{requestId:'w',timestamp:1.1,response:{status:101,headers:{Cookie:'SECRET'}}});
  session.emit('Network.webSocketFrameSent',{requestId:'w',timestamp:2,response:{opcode:1,payloadData:'机密'}});
  session.emit('Network.webSocketFrameReceived',{requestId:'w',timestamp:2.1,response:{opcode:2,payloadData:'AQIDBA=='}});
  session.emit('Network.webSocketClosed',{requestId:'w',timestamp:3});
  session.emit('Network.webSocketFrameReceived',{requestId:'existing',timestamp:4,response:{opcode:1,payloadData:'SECRET'}});
  session.emit('Network.requestWillBeSent',{requestId:'s',timestamp:1,wallTime:1700000001,request:{url:'https://10.0.0.1/events',method:'GET'}});
  session.emit('Network.responseReceived',{requestId:'s',timestamp:1.2,response:{status:200,mimeType:'text/event-stream',protocol:'h2',remoteIPAddress:'10.0.0.1',remotePort:443,timing:{requestTime:1,receiveHeadersEnd:100}}});
  session.emit('Network.eventSourceMessageReceived',{requestId:'s',timestamp:2,data:'SECRET',eventName:'PRIVATE',eventId:'SESSION'});
  session.emit('Network.dataReceived',{requestId:'s',timestamp:2,dataLength:30,encodedDataLength:20});
  await cap.stop();
  assert.equal(cap.rows.length,1);assert.equal(cap.rows[0].protocol,'h2');assert.equal(cap.rows[0].peer,'10.0.0.1:443');
  const groups=summarizeChannels(cap.channels,cap.rows,60),ws=groups.find(r=>r.endpoint?.startsWith('wss:')),sse=groups.find(r=>r.kind==='SSE');
  assert.equal(ws.sentFrames,1);assert.equal(ws.sentBytes,6);assert.equal(ws.receivedBytes,4);assert.equal(ws.handshake.samples,1);
  assert.equal(sse.receivedEvents,1);assert.equal(sse.receivedChunks,1);assert.equal(sse.receivedBytes,30);assert.equal(sse.incomplete,1);
  assert.equal(groups.find(r=>r.endpoint===null).preexisting,1);
  assert.equal(summarizeRequests(cap.rows,60)[0].duration.samples,0);
  assert.doesNotMatch(JSON.stringify(events),/SECRET|机密|AQIDBA|PRIVATE|SESSION|"headers":|payloadData/);
  assert.equal(page.listenerCount('close'),0);
});

test('NetLog UDP/QUIC use numeric peers and allowlisted sizes; protocol layers are not added together',()=>{
  const raw=(name,params)=>sanitizeTrace({cat:'netlog',name,ph:'n',id:'0x1',pid:3,ts:1000,args:{params}});
  const events=[raw('UDP_BYTES_RECEIVED',{address:'[fd00::2]:443',byte_count:40,bytes:'SECRET'}),raw('UDP_CONNECT',{address:'bad?token=SECRET'}),raw('QUIC_SESSION_PACKET_RECEIVED',{peer_address:'10.0.0.1:443',self_address:'SECRET'}),raw('QUIC_SESSION_PACKET_SENT',{size:40,packet_sequence_number:'SECRET'})];
  const t=summarizeTransports(events);assert.equal(t.length,2);assert.equal(t.find(r=>r.protocol==='UDP').receivedBytes,40);assert.deepEqual(t.find(r=>r.protocol==='UDP').peers,['[fd00::2]:443']);
  assert.equal(t.find(r=>r.protocol==='QUIC').sentBytes,40);assert.equal(t.find(r=>r.protocol==='QUIC').receivedBytes,0);
  assert.doesNotMatch(JSON.stringify(events),/SECRET|self_address|packet_sequence|"bytes":"/);
});

test('UDP bindings never become remote requests and failed UDP samples are kept distinct',()=>{
  const a={sampleCount:0,layers:{process:{gaps:0}},connections:new Map(),udpEndpoints:new Map()},events=[];
  const data={at:'2026-10-27T00:00:00.000Z',processCount:2,tcpStatus:'ok',udpStatus:'ok',connections:[{pid:1,role:'main',remoteAddress:'10.0.0.1',remotePort:443,localAddress:'10.0.0.2',localPort:2000,state:'Established'}],udpEndpoints:[{pid:2,role:'NetworkService',localAddress:'::',localPort:5000}]};
  recordProcessSample(a,data,(k,row)=>events.push(row));recordProcessSample(a,{...data,udpStatus:'failed',udpEndpoints:[]},()=>{});
  assert.equal(a.connections.size,1);assert.equal(a.udpEndpoints.size,1);assert.equal([...a.udpEndpoints.values()][0].samples,1);assert.equal(a.layers.process.udpSamples,1);assert.equal(a.layers.process.udpFailures,1);assert.equal(a.layers.process.tcpSamples,2);assert.equal(a.layers.process.gaps,1);
  assert.equal(events.find(r=>r.kind==='udp_endpoint').remote,undefined);
});

test('coverage distinguishes disabled, unavailable, old data and no samples; QUIC does not prove HTTP3',()=>{
  const v={collectorRevision:2,enabled:{application:true,network:true,process:true},layers:{application:{state:'stopped'},network:{state:'stopped'},process:{state:'stopped'}},application:{requests:0,channels:[]},network:{transports:[{protocol:'QUIC',events:3}]},process:{connections:[],udpEndpoints:[]},endedAt:'2026-10-27'};
  const report=()=>protocolCoverage(v);assert.equal(report().find(r=>r.type==='SSE').state,'本批未观察到');assert.equal(report().find(r=>r.type==='Chromium QUIC').state,'已观察到');
  v.enabled.application=false;assert.equal(report().find(r=>r.type==='WebSocket').state,'未启用');v.enabled.application=true;v.layers.application.state='unavailable';assert.equal(report().find(r=>r.type==='WebSocket').state,'不可用');
  delete v.collectorRevision;assert.equal(report().find(r=>r.type==='UDP本地端点').state,'旧批次未采集');assert.equal(report().find(r=>r.type.includes('Node.js')).state,'未覆盖');
});

test('NetLog drains segments, declares rollover gaps and stops its timer without ending foreign traces',async()=>{
  const session=new EventEmitter(),calls=[];let detached=0;
  session.detach=async()=>detached++;
  session.send=async method=>{calls.push(method);if(method==='Tracing.getCategories')return {categories:['netlog']};if(method==='Tracing.end'){session.emit('Tracing.dataCollected',{value:[{cat:'netlog',name:'UDP_BYTES_SENT',ph:'n',id:'0x1',pid:3,ts:1000,args:{params:{byte_count:7}}}]});session.emit('Tracing.tracingComplete',{dataLossOccurred:false});}return {};};
  const emitted=[],status={gaps:0,dropped:0};const capture=await startNetworkCapture({newBrowserCDPSession:async()=>session},(kind,row)=>emitted.push(row),status,{segmentMs:5,stopTimeoutMs:100});
  const limit=Date.now()+1000;while(!status.rollovers&&Date.now()<limit)await new Promise(r=>setTimeout(r,5));
  await capture.stop();const count=calls.length;await new Promise(r=>setTimeout(r,15));
  assert.ok(status.segments>=2);assert.ok(status.gaps>=1);assert.equal(status.state,'partial');assert.equal(detached,1);assert.equal(calls.length,count);assert.ok(emitted.some(r=>r.kind==='trace_boundary'));assert.ok(capture.events.length>=2);
});
