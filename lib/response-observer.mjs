import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';

export const OBSERVATION_POLICY='response-observation-v1';
const hash=value=>createHash('sha256').update(String(value)).digest('hex').slice(0,16);
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
const elapsed=(end,start)=>Number.isFinite(end)&&Number.isFinite(start)&&end>=start?+(1000*(end-start)).toFixed(2):null;
const events=new Set(['request_start','upstream_response','upstream_non2xx','request_failed','model_rewrite','stream_end','response_provider_fallback','gateway_trace_headers']);
const reasons=new Set(['completed','aborted','cancelled','error','timeout','client_closed','upstream_error']);
const segments=new Set(['workspace','workspaces','events','activity-summary','deliverables-summary','opencode','agent','session','message','part','event','status','health','engine','runtime','aggregate','mail','reminders','due','api','v1','chat','completions','responses','models','skills','experts','tools','cases','search','sessions','snapshot','config','opencode-config','mcp','global','permission','question','runtime-config','application','artifacts','resolve','capabilities','env','keys','knowledge','list','local','reload','asset','assets','admin','platform','detail','install-package','static-resource','mw2yunxi','contact','resources','out','manager']);
const model=value=>typeof value==='string'&&value.length<=64&&!/gh[pousr]_|sk-|Bearer|token|secret/i.test(value)&&/^[\p{L}\p{N} ._:/-]+$/u.test(value)?value:undefined;

// Never persist full URLs, query strings, arbitrary path segments, headers or bodies.
export function safeEndpoint(value){
  try{const u=new URL(value);return {transport:['http:','https:','ws:','wss:'].includes(u.protocol)?u.protocol.slice(0,-1):'other',
    hostKey:hash(u.hostname),port:u.port||undefined,local:['127.0.0.1','localhost','[::1]'].includes(u.hostname),
    route:u.pathname.split('/').slice(0,12).map(s=>!s?'':segments.has(s)?s:'[id]').join('/')};}
  catch{return {transport:'unknown',route:'[unknown]'};}
}

// Completed asset-proxy entries: the cache branch can still fetch remotely.
export function parseAssetLine(line,phase='execution') {
  const m=line.match(/\[assets-perf\]\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(.*)$/);
  if(!m)return null;
  const stamp=line.match(/^(\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?)/)?.[1];
  const timestamp=stamp&&Number.isFinite(Date.parse(stamp))?new Date(stamp).toISOString():null;
  let u;try{u=new URL(m[2],'http://asset-proxy.invalid');}catch{return null;}
  const tail=m[3],numeric=key=>{const found=tail.match(new RegExp(`(?:^|\\s)${key}=(\\d+)ms`));return found?Number(found[1]):null;};
  const assetType=u.searchParams.get('assetType');
  return {source:'main-assets-perf',association:'completion-in-case-window',timestamp,observedAt:new Date().toISOString(),phase,method:m[1],
    route:safeEndpoint(u.href).route,...(['expert','group','skill','connector','case'].includes(assetType)?{assetType}:{}),
    status:Number(tail.match(/status=(\d{3})/)?.[1])||null,networkEvidence:/\bfetch=\d+ms/.test(tail)?'network-fetch-completed':'cache-branch-network-unknown',
    cache:tail.includes('(cache)')?'unknown':'not-used',fetchMs:numeric('fetch'),tokenMs:numeric('token'),totalMs:numeric('total')};
}

// A model call can be joined to other log events, but is NOT automatically the current UI case.
export function parseProxyLine(line,phase='execution'){
  const m=line.match(/\[model-proxy\]\s+(\w+)\s+(\{.*\})\s*$/);
  if(!m||!events.has(m[1]))return null;
  let d;try{d=JSON.parse(m[2]);}catch{return null;}if(!d||typeof d!=='object')return null;
  const call=d.modelCallId||d['x-model-call-id'],session=d.sessionId||d['x-session-id'],message=d.msgId||d['x-msg-id'];
  const stamp=line.match(/^(\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?)/)?.[1];
  const timestamp=stamp&&Number.isFinite(Date.parse(stamp))?new Date(stamp).toISOString():null;
  return {event:m[1],phase,timestamp,observedAt:new Date().toISOString(),association:'unattributed',
    ...(typeof call==='string'?{callKey:hash(call)}:{}),...(typeof session==='string'?{sessionKey:hash(session)}:{}),...(typeof message==='string'?{messageKey:hash(message)}:{}),
    ...(Number.isInteger(d.status)&&d.status>=100&&d.status<=599?{status:d.status}:{}),
    ...(finite(d.durationMs)!==null?{reportedDurationMs:d.durationMs}:{}),...(finite(d.bytes)!==null?{bytes:d.bytes}:{}),
    ...(m[1]==='request_failed'?{failureStage:['connect','request','response','stream'].includes(d.stage)?d.stage:'unknown',errorCodes:[...new Set((JSON.stringify(d.error)||'').match(/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|UND_ERR_[A-Z_]+/g)||[])]}:{}),
    ...(typeof d.reason==='string'?{reason:reasons.has(d.reason)?d.reason:'other'}:{}),
    ...(model(d.requestedModelId)?{requestedModel:model(d.requestedModelId)}:{}),...(model(d.effectiveModelId)?{effectiveModel:model(d.effectiveModelId)}:{})};
}

function bounded(promise,ms=2500){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('observer_timeout')),ms);})]).finally(()=>clearTimeout(timer));}

export async function startResponseObserver({logPath=process.env.MW_MODEL_LOG_PATH||path.join(os.homedir(),'.mobilework/electron/logs/main.log'),onSnapshot=()=>{},intervalMs=2000,maxRequests=160,maxEvents=80}={}){
  const startedAt=new Date().toISOString(),network={status:'not_attached',requests:[],counts:{started:0,responses:0,finished:0,failed:0,sse:0,webSocketFrames:0},dropped:0},proxy={status:'unavailable',events:[],dropped:0,rotationCount:0,gaps:0},assets={status:'unavailable',events:[],dropped:0,note:'Completed assets-perf entries only; missing entries do not prove no requests; cache branch may fetch remotely.'};
  let phase='startup',offset=0,identity=null,carry='',discardLine=false,closed=false,polling=null,timer,session=null,listeners=[],generation=0;
  const pending=new Map();
  const identify=s=>`${s.dev}:${s.ino}:${s.birthtimeMs}`;
  try{const s=await fs.stat(logPath);identity=identify(s);offset=s.size;proxy.status='observing';
    if(s.size){const h=await fs.open(logPath,'r');try{const b=Buffer.alloc(1);await h.read(b,0,1,s.size-1);discardLine=b[0]!==10;}finally{await h.close();}}
  }catch{proxy.status='unavailable';}
  function snapshot(){return JSON.parse(JSON.stringify({policy:OBSERVATION_POLICY,startedAt,observedAt:new Date().toISOString(),phase,complete:closed,network,proxy,assets,
    interpretation:{network:'page-target-window',proxy:'same-time-unattributed',ttft:'not_collected',note:'请求耗时与页面操作计时分开；同期模型日志未证明属于本用例，stream_end不代表回答成功。'}}));}
  async function pollLog(){
    let handle;
    try{
      handle=await fs.open(logPath,'r');const stat=await handle.stat(),next=identify(stat);
      if(identity!==next||stat.size<offset){if(identity!==null)proxy.rotationCount++;offset=0;carry='';discardLine=false;identity=next;}
      if(stat.size-offset>262144){offset=stat.size-262144;carry='';discardLine=true;proxy.gaps++;}
      const size=stat.size-offset;if(size>0){
        const b=Buffer.alloc(size),{bytesRead}=await handle.read(b,0,size,offset);offset+=bytesRead;
        let text=carry+b.subarray(0,bytesRead).toString('utf8');carry='';
        if(discardLine){const end=text.indexOf('\n');if(end<0){proxy.status='observing';return;}text=text.slice(end+1);discardLine=false;}
        const lines=text.split('\n');carry=lines.pop();
        if(carry.length>32768){carry='';discardLine=true;proxy.gaps++;}
        for(const line of lines){const asset=parseAssetLine(line,phase);if(asset&&asset.timestamp&&Date.parse(asset.timestamp)>=Date.parse(startedAt)){if(assets.events.length<maxEvents)assets.events.push(asset);else assets.dropped++;}const event=parseProxyLine(line,phase);if(!event)continue;
          // Rotated/recreated files may contain historical material. Keep only this window.
          if(!event.timestamp||Date.parse(event.timestamp)<Date.parse(startedAt))continue;
          if(proxy.events.length>=maxEvents){proxy.dropped++;continue;}proxy.events.push(event);
        }
      }
      proxy.status='observing';assets.status='observing';
    }catch{proxy.status='unavailable';assets.status='unavailable';}finally{await handle?.close().catch(()=>{});}
  }
  async function flush(){if(polling)return polling;polling=(async()=>{await pollLog();try{onSnapshot(snapshot());}catch{}})();try{await polling;}finally{polling=null;}}
  async function detach(){
    generation++;const old=session;session=null;
    for(const [event,handler]of listeners)old?.off(event,handler);listeners=[];
    for(const r of pending.values())if(r.outcome==='pending')r.outcome='observation_ended';pending.clear();
    if(old)await bounded(old.detach()).catch(()=>{});
  }
  async function attach(page){
    await detach();if(closed)return;
    const attempt=generation;let candidate;
    try{
      const connecting=page.context().newCDPSession(page).then(s=>{if(attempt!==generation||closed){s.detach().catch(()=>{});throw new Error('late_attach');}return s;});
      candidate=await bounded(connecting);session=candidate;
      const on=(name,fn)=>{const safe=e=>{try{fn(e);}catch{network.dropped++;}};session.on(name,safe);listeners.push([name,safe]);};
      on('Network.requestWillBeSent',e=>{
        network.counts.started++;
        const previous=pending.get(e.requestId);
        if(previous){previous.outcome=e.redirectResponse?'redirected':'observation_ended';if(e.redirectResponse)previous.status=e.redirectResponse.status;pending.delete(e.requestId);}
        if(network.requests.length>=maxRequests){network.dropped++;return;}
        const row={key:network.requests.length+1,...safeEndpoint(e.request.url),method:['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(e.request.method)?e.request.method:'other',phase,
          startedAt:new Date().toISOString(),startMonotonic:e.timestamp,outcome:'pending'};
        network.requests.push(row);pending.set(e.requestId,row);
      });
      on('Network.responseReceived',e=>{network.counts.responses++;const r=pending.get(e.requestId);if(!r)return;
        r.status=e.response.status;r.responseObservedMs=elapsed(e.timestamp,r.startMonotonic);
        const timing=e.response.timing;
        r.headersMs=timing&&finite(timing.receiveHeadersEnd)!==null?elapsed(timing.requestTime+timing.receiveHeadersEnd/1000,r.startMonotonic):null;
        r.fromCache=!!(e.response.fromDiskCache||e.response.fromServiceWorker);
      });
      on('Network.loadingFinished',e=>{network.counts.finished++;const r=pending.get(e.requestId);if(!r)return;r.durationMs=elapsed(e.timestamp,r.startMonotonic);r.bytes=finite(e.encodedDataLength);r.outcome='finished';pending.delete(e.requestId);});
      on('Network.loadingFailed',e=>{network.counts.failed++;const r=pending.get(e.requestId);if(!r)return;r.outcome='failed';r.durationMs=elapsed(e.timestamp,r.startMonotonic);r.errorCode=/^net::ERR_[A-Z_]+$/.test(e.errorText)?e.errorText:'network_failure';pending.delete(e.requestId);});
      on('Network.eventSourceMessageReceived',()=>network.counts.sse++);
      on('Network.webSocketFrameReceived',()=>network.counts.webSocketFrames++);
      await bounded(session.send('Network.enable'));network.status='observing';
    }catch{await detach();network.status='unavailable';}
  }
  timer=setInterval(()=>{void flush();},intervalMs);timer.unref?.();
  return {attach,snapshot,flush,async setPhase(next){await flush();phase=['startup','execution','cleanup'].includes(next)?next:'execution';},
    async stop(){if(closed)return snapshot();clearInterval(timer);await flush();await detach();closed=true;const result=snapshot();try{onSnapshot(result);}catch{}return result;}};
}
