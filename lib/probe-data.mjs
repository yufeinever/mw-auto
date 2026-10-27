import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
import {safeEndpoint} from './response-observer.mjs';

export const keyOf = text => createHash('sha256').update(String(text)).digest('hex').slice(0,16);
export function addressType(host='') {
  host=host.toLowerCase().replace(/^\[|\]$/g,'');
  if(host.startsWith('::ffff:'))return addressType(host.slice(7));
  if(host==='localhost'||host==='::1'||/^127\./.test(host))return 'local';
  if(host==='0.0.0.0'||host==='::')return 'unspecified';
  if(/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\./.test(host)||/^(fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host))return 'private';
  return isIP(host)?'public':'domain';
}
export function endpoint(value) {
  try {
    const u=new URL(value);if(!['http:','https:','ws:','wss:'].includes(u.protocol))return null;
    const route=safeEndpoint(value).route.replaceAll('[id]',':id');
    return {endpoint:`${u.protocol}//${u.host}${route}`,host:u.host,addressType:addressType(u.hostname),instanceKey:keyOf(u.origin+u.pathname)};
  } catch{return null;}
}
export const methodOf=m=>['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','CONNECT'].includes(m)?m:'OTHER';
export const quantile=(values,p)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?+a[Math.max(0,Math.ceil(p*a.length)-1)].toFixed(2):null;};
export const stats=values=>({samples:values.filter(Number.isFinite).length,minMs:quantile(values,0),medianMs:quantile(values,.5),p95Ms:quantile(values,.95),maxMs:quantile(values,1)});
export function summarizeRequests(rows, seconds) {
  const groups=new Map();
  for(const r of rows){const k=r.method+' '+r.endpoint;const g=groups.get(k)||{method:r.method,endpoint:r.endpoint,host:r.host,addressType:r.addressType,rows:[]};g.rows.push(r);groups.set(k,g);}
  return [...groups.values()].map(({rows:a,...g})=>{
    const status={},buckets=new Map(),instances=new Map(),points=[];
    for(const r of a){if(r.status)status[r.status]=(status[r.status]||0)+1;
      const t=r.startMs; if(Number.isFinite(t)){const sec=Math.floor(t/1000);buckets.set(sec,(buckets.get(sec)||0)+1);const times=instances.get(r.instanceKey)||[];times.push(t);instances.set(r.instanceKey,times);points.push([t,1]);if(Number.isFinite(r.endMs))points.push([r.endMs,-1]);}}
    const intervals=[...instances.values()].flatMap(t=>t.sort((a,b)=>a-b).slice(1).map((v,i)=>v-t[i]));
    let concurrent=0,peakConcurrent=0;for(const [,n]of points.sort((a,b)=>a[0]-b[0]||a[1]-b[1])){concurrent+=n;peakConcurrent=Math.max(concurrent,peakConcurrent);}
    const failed=a.filter(r=>r.outcome==='failed').length,httpErrors=a.filter(r=>r.status>=400).length;
    const duration=stats(a.filter(r=>r.outcome==='finished'&&!r.stream).map(r=>r.durationMs));
    const headers=stats(a.map(r=>r.headersMs));
    return {...g,count:a.length,responses:a.filter(r=>r.status).length,httpErrors,failed,pending:a.filter(r=>r.outcome==='pending'||r.outcome==='incomplete').length,stream:a.filter(r=>r.stream).length,cache:a.filter(r=>r.fromCache).length,status,
      rpm:seconds>0?+(a.length*60/seconds).toFixed(2):null,averageRps:seconds>0?+(a.length/seconds).toFixed(3):null,peakSecondRequests:Math.max(0,...buckets.values()),peakConcurrent,duration,headers,intervalMedianMs:quantile(intervals,.5),intervalSamples:intervals.length,instances:instances.size,
      hints:[...(failed||httpErrors?['存在请求异常']:[]),...(a.length>=5&&seconds>0&&a.length/seconds>1?['频繁访问，需结合场景评估']:[]),...(duration.p95Ms!==null&&quantile(intervals,.5)>0&&duration.p95Ms>quantile(intervals,.5)?['耗时超过同资源访问间隔']:[])]};
  }).sort((a,b)=>b.count-a.count);
}

// Chromium trace entries are transient. Only this allowlisted shape may reach disk.
export function sanitizeTrace(e) {
  if(!String(e.cat||'').split(',').includes('netlog')||!/^[A-Z][A-Z0-9_]{1,100}$/.test(e.name||''))return null;
  const p=e.args?.params||{};const id=String(e.id??e.id2?.local??'');if(!id||!Number.isFinite(e.ts))return null;
  const row={name:e.name,phase:e.ph,timeMs:e.ts/1000,pid:e.pid,source:keyOf(`${e.pid}:${id}`)};
  const ep=endpoint(p.url);if(ep)Object.assign(row,ep);
  if(p.method)row.method=methodOf(p.method);
  if(Number.isInteger(p.net_error))row.netError=p.net_error;
  if(Number.isInteger(p.byte_count)&&p.byte_count>=0)row.bytes=p.byte_count;
  // Do not retain header lines. Extract only the HTTP status line in memory.
  if(e.name==='HTTP_TRANSACTION_READ_RESPONSE_HEADERS'){
    const headers=Array.isArray(p.headers)?p.headers:typeof p.headers==='string'?[p.headers]:[];
    const code=headers.map(h=>String(h).match(/^HTTP\/\S+\s+(\d{3})/)?.[1]).find(Boolean);if(code)row.status=Number(code);
    if(headers.some(h=>/^content-type:\s*text\/event-stream/i.test(String(h))))row.stream=true;
  }
  if(p.source_dependency?.id!==undefined){const dependency='0x'+Number(p.source_dependency.id).toString(16);row.dependency=keyOf(`${e.pid}:${dependency}`);}
  return row;
}
export function summarizeTrace(events) {
  const active=new Map(),requests=[],spans=[],open=new Map();
  for(const e of [...events].sort((a,b)=>a.timeMs-b.timeMs)){
    if(e.name==='REQUEST_ALIVE'&&e.phase==='b'&&e.endpoint){const r={...e,startMs:e.timeMs,method:'OTHER',outcome:'pending'};active.set(e.source,r);requests.push(r);}
    let r=active.get(e.source);
    if(r){if(e.name==='URL_REQUEST_START_JOB'&&e.phase==='b'){
        if(e.endpoint&&e.instanceKey!==r.instanceKey){r.endMs=e.timeMs;r.durationMs=e.timeMs-r.startMs;r.outcome='redirected';r={...e,startMs:e.timeMs,method:e.method||'OTHER',outcome:'pending'};requests.push(r);active.set(e.source,r);}
        if(e.method)r.method=e.method;
      }
      if(e.status){r.status=e.status;r.headersMs=Math.max(0,e.timeMs-r.startMs);}if(e.stream)r.stream=true;
      if(e.netError<0)r.netError=e.netError;
      if(e.name==='REQUEST_ALIVE'&&e.phase==='e'){r.endMs=e.timeMs;r.durationMs=Math.max(0,e.timeMs-r.startMs);r.outcome=r.netError<0?'failed':'finished';active.delete(e.source);}}
    if(/^(HOST_RESOLVER_MANAGER_REQUEST|TCP_CONNECT|SSL_CONNECT|PROXY_RESOLUTION_SERVICE)$/.test(e.name)){
      const k=e.source+':'+e.name;
      if(e.phase==='b'){const stack=open.get(k)||[];stack.push(e);open.set(k,stack);}
      if(e.phase==='e'){const start=open.get(k)?.pop();if(start)spans.push({name:e.name,pid:e.pid,durationMs:Math.max(0,e.timeMs-start.timeMs),failed:e.netError<0});}
    }
  }
  for(const r of active.values())r.outcome='incomplete';
  const names=[...new Set(spans.map(s=>s.name))];
  return {requests,phases:names.map(name=>({name,...stats(spans.filter(s=>s.name===name).map(s=>s.durationMs)),failed:spans.filter(s=>s.name===name&&s.failed).length})),unmatchedSpans:[...open.values()].reduce((n,s)=>n+s.length,0)};
}
