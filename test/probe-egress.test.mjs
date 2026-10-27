import test from 'node:test';
import assert from 'node:assert/strict';
import {linkTraceRequests,summarizeEgress,egressFromSummary} from '../lib/probe-egress.mjs';
import {sanitizeTrace,endpoint,summarizeTrace} from '../lib/probe-data.mjs';

const row=(name,id,ts,params={},ph='n')=>sanitizeTrace({cat:'netlog',name,id:'0x'+id.toString(16),pid:8,ts:ts*1000,ph,args:{params}});
const fixture=()=>[
  row('REQUEST_ALIVE',1,10,{url:'https://api.example.com/api/models?token=SECRET'},'b'),
  row('URL_REQUEST_START_JOB',1,11,{method:'GET'},'b'),
  row('TCP_CONNECT_ATTEMPT',3,12,{address:'10.0.0.1:443'},'b'),
  row('TCP_CONNECT_ATTEMPT',3,13,{remote_address:'10.0.0.1:443',local_address:'10.0.0.2:2000',headers:'SECRET'},'e'),
  row('SOCKET_POOL_BOUND_TO_SOCKET',2,14,{source_dependency:{id:3}}),
  row('HTTP_STREAM_REQUEST_BOUND_TO_JOB',1,15,{source_dependency:{id:2}}),
  row('HTTP_TRANSACTION_READ_RESPONSE_HEADERS',1,16,{headers:['HTTP/1.1 200 OK']}),
  row('REQUEST_ALIVE',1,20,{},'e')
];

test('explicit request-job-socket chain associates API with successful peer and network-stack PID, without secrets',()=>{
  const events=fixture(),requests=linkTraceRequests(summarizeTrace(events).requests,events);
  assert.deepEqual(requests[0].egressPaths,[{peer:'10.0.0.1:443',networkPid:8,transport:'TCP',evidence:'socket_bound'}]);
  const report=summarizeEgress({networkRows:requests,seconds:60,connections:[{pid:8,remote:'10.0.0.1:443',addressType:'private',role:'NetworkService'}]});
  assert.equal(report.entries.length,1);assert.equal(report.entries[0].routes[0].count,1);assert.equal(report.entries[0].routes[0].networkPid,8);
  assert.doesNotMatch(JSON.stringify({events,report}),/SECRET|local_address|Authorization/);
  assert.ok(events.every(e=>!Object.hasOwn(e,'headers')));
});

test('failed attempts, unrelated dependencies, closed sockets and bindings from another request window cannot prove an exit',()=>{
  for(const kind of ['failed','closed','unrelated','outside']){
    const events=fixture();
    if(kind==='failed')events[3]=row('TCP_CONNECT_ATTEMPT',3,13,{net_error:-7},'e');
    if(kind==='closed')events.push(row('SOCKET_CLOSED',3,13.5));
    if(kind==='unrelated')events[5]=row('HTTP2_SESSION_POOL_FOUND_EXISTING_SESSION',1,15,{source_dependency:{id:2}});
    if(kind==='outside')events[5]={...events[5],timeMs:21};
    assert.equal(linkTraceRequests(summarizeTrace(events).requests,events)[0].egressPaths.length,0,kind);
  }
});

test('proxy peer differs from URL target; cache, UDP and connection samples do not become backend HTTP requests',()=>{
  const r={...endpoint('https://api.example.com/api/models'),method:'GET',startMs:0,endMs:100,durationMs:100,headersMs:50,outcome:'finished',peer:'127.0.0.1:7890',protocol:'h2'};
  const report=summarizeEgress({pageRows:[r,{...r,fromCache:true}],events:[{name:'UDP_CONNECT',peer:'1.1.1.1:443',pid:8}],connections:[{pid:9,remote:'10.0.0.1:443',addressType:'private'}],seconds:60});
  assert.equal(report.entries.find(e=>e.address==='127.0.0.1:7890').routes[0].evidence,'cdp_peer');
  const cache=report.entries.find(e=>e.address==='api.example.com:443');assert.equal(cache.routes[0].evidence,'cache');assert.deepEqual(cache.protocols,[]);
  assert.equal(report.entries.find(e=>e.address==='1.1.1.1:443').routes.length,0);
  assert.equal(report.entries.find(e=>e.address==='10.0.0.1:443').routes.length,0);
});

test('API counts are partitioned per peer and source; same address alone never supplies PID or socket evidence',()=>{
  const r={...endpoint('https://10.0.0.1/api/models'),method:'GET',startMs:1,outcome:'pending'};
  const report=summarizeEgress({pageRows:[{...r,peer:'10.0.0.1:443',protocol:'h2'},{...r,peer:'10.0.0.2:443',protocol:'h2'}],networkRows:[r],seconds:60,connections:[{pid:100,remote:'10.0.0.1:443',addressType:'private'}]});
  const a=report.entries.find(e=>e.address==='10.0.0.1:443'),b=report.entries.find(e=>e.address==='10.0.0.2:443');
  assert.equal(a.routes.find(r=>r.source==='application').count,1);assert.equal(a.routes.find(r=>r.source==='network').count,1);assert.equal(b.routes[0].count,1);
  assert.ok(a.routes.every(r=>r.networkPid===null));assert.ok(a.routes.some(r=>r.evidence==='url_target'));
});

test('old summaries yield labelled URL candidates without modifying history or allocating counts to multiple peers',()=>{
  const view={application:{interfaces:[{...endpoint('https://10.0.0.1/api/models'),method:'GET',count:4,peers:['10.0.0.1:443','10.0.0.2:443']}]},network:{interfaces:[]},process:{connections:[]}};
  const original=JSON.stringify(view),report=egressFromSummary(view);assert.equal(JSON.stringify(view),original);
  assert.equal(report.derivedFromSummary,true);assert.equal(report.entries.length,1);assert.equal(report.entries[0].routes[0].count,4);assert.equal(report.entries[0].routes[0].evidence,'url_target');
});
