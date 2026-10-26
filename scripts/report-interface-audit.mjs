import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runId=process.argv[2];
if(!/^[a-z0-9-]{10,80}$/.test(runId||''))throw Error('Supply a run id');
const run=JSON.parse(await fs.readFile(path.join(root,'runs',runId+'.json'),'utf8'));
const catalog=JSON.parse(await fs.readFile(path.join(root,'data/cases.json'),'utf8'));
const ipc=await fs.readFile(path.join(root,'data','interface-audit-20261026',runId+'-ipc.json'),'utf8').then(JSON.parse).catch(()=>null);
// Runtime.enable can replay older console markers; keep only this observation window.
if(ipc)ipc.events=ipc.events.filter(e=>Date.parse(e.at)>=Date.parse(ipc.readyAt||ipc.startedAt));
const authProbes=[];
try{const log=await fs.readFile(path.join(os.homedir(),'.mobilework/electron/logs/main.log'),'utf8');for(const line of log.split(/\r?\n/)){
  const stamp=line.match(/^(\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?)/)?.[1],m=line.match(/\[assets-perf\] oidc token probe -> (valid|invalid|unknown) in (\d+)ms/);
  if(!stamp||!m)continue;const time=Date.parse(stamp);if(time<Date.parse(run.startedAt)||time>Date.parse(run.endedAt||new Date().toISOString()))continue;
  authProbes.push({at:new Date(time).toISOString(),state:m[1],durationMs:Number(m[2]),association:'same-time-unattributed',destinationBasis:'installed oidc code and current configuration; URL not present in this log event',configuredRoute:'/mw2yunxi/rbacmgr/api/gm/user/mw/info'});
}}catch{}
const clean=value=>String(value??'').replace(/\|/g,'／').replace(/[\r\n]+/g,' ');
const observations=result=>result.observationAttempts?.length?result.observationAttempts.filter(a=>a.observation):result.observation?[{iteration:1,observation:result.observation}]:[];
const group=(rows,key)=>{const out=new Map();for(const r of rows){const k=key(r);out.set(k,[...(out.get(k)||[]),r]);}return [...out].map(([key,items])=>({key,count:items.length,items}));};
const stats=rows=>{const values=rows.filter(r=>r.outcome==='finished'&&Number.isFinite(r.durationMs)).map(r=>r.durationMs).sort((a,b)=>a-b);return {requests:rows.length,completed:values.length,meanMs:values.length?+(values.reduce((a,b)=>a+b,0)/values.length).toFixed(2):null,p95Ms:values.length?values[Math.ceil(values.length*.95)-1]:null,maxMs:values.at(-1)??null,httpErrors:rows.filter(r=>r.status>=400).length,networkFailures:rows.filter(r=>r.outcome==='failed').length,canceled:rows.filter(r=>r.errorCode==='net::ERR_ABORTED').length};};
const network=[],assets=[],proxy=[],rows=[];
for(const spec of catalog){
  const result=run.results.find(r=>r.id===spec.id),attempts=result?observations(result):[];
  const requests=attempts.flatMap(a=>(a.observation.network?.requests||[]).map(r=>({...r,caseId:spec.id,iteration:a.iteration})));
  const assetEvents=attempts.flatMap(a=>(a.observation.assets?.events||[]).map(r=>({...r,caseId:spec.id,iteration:a.iteration})));
  const proxyEvents=attempts.flatMap(a=>(a.observation.proxy?.events||[]).map(r=>({...r,caseId:spec.id,iteration:a.iteration})));
  network.push(...requests);assets.push(...assetEvents);proxy.push(...proxyEvents);
  const http=requests.filter(r=>['http','https'].includes(r.transport));
  rows.push({id:spec.id,name:spec.name,status:result?.functional||'not_run',reason:result?.reason||'',restored:result?.restored??null,
    ipcCoverage:!ipc?'not_captured':!result?.startedAt?'not_run':Date.parse(result.startedAt)<Date.parse(ipc.readyAt||ipc.startedAt)?'partial_or_not_captured':'captured',
    ipcRoutes:group((ipc?.events||[]).filter(e=>e.caseId===spec.id),e=>`${e.kind} ${e.method||''} ${e.route||''}${e.assetType?' [type='+e.assetType+']':''}`).map(({key,count})=>({key,count})),
    attempts:attempts.length,formalIterations:result?.repetition?.recordedIterations||[],measurements:result?.measurements?.map(m=>({label:m.label,durationMs:m.durationMs}))||[],
    warmup:result?.warmup?.functional,local:stats(http.filter(r=>r.local)),remote:stats(http.filter(r=>!r.local)),nonHttp:requests.length-http.length,
    localRoutes:group(http.filter(r=>r.local),r=>`${r.method} ${r.route}`).map(({key,count})=>({key,count})),
    remoteRoutes:group(http.filter(r=>!r.local),r=>`${r.transport} ${r.hostKey}:${r.port||'default'} ${r.method} ${r.route}`).map(({key,count})=>({key,count})),
    assetRoutes:group(assetEvents,r=>`${r.method} ${r.route}${r.assetType?' [type='+r.assetType+']':''} [${r.networkEvidence}]`).map(({key,count})=>({key,count})),
    proxyFailures:proxyEvents.filter(e=>e.event==='request_failed'||e.status>=400).length,
    dropped:attempts.reduce((n,a)=>n+(a.observation.network?.dropped||0)+(a.observation.assets?.dropped||0)+(a.observation.proxy?.dropped||0),0),
    logGaps:attempts.reduce((n,a)=>n+(a.observation.proxy?.gaps||0),0),
    complete:attempts.length>0&&attempts.every(a=>a.observation.complete),
    phases:[...new Set(requests.map(r=>r.phase))]});
}
const http=network.filter(r=>['http','https'].includes(r.transport));
const httpBusiness=http.filter(r=>r.method!=='OPTIONS');
const report={runId,status:run.status,startedAt:run.startedAt,endedAt:run.endedAt,selected:run.selected.length,recorded:run.results.length,
  outcomes:Object.fromEntries(group(run.results,r=>r.functional).map(g=>[g.key,g.count])),
  transportFailuresExcludingCanceled:http.filter(r=>r.outcome==='failed'&&r.errorCode!=='net::ERR_ABORTED').length,
  unfinishedRequests:http.filter(r=>['observation_ended','pending'].includes(r.outcome)).length,
  preflightRequests:http.length-httpBusiness.length,businessRequests:httpBusiness.length,
  businessRouteGroups:group(httpBusiness,r=>`${r.local?'local':'remote'} ${r.hostKey}:${r.port||'default'} ${r.method} ${r.route}`).map(({key,count})=>({key,count})),
  note:'Case-window observations include preparation, background and cleanup; not proof of causal action attribution. Assets logs only include completed entries; cache branch may fetch remotely. Model events are unattributed. Warmup and formal request samples both retained, timing measurements remain formal only.',
  local:stats(http.filter(r=>r.local)),remotePage:stats(http.filter(r=>!r.local)),nonHttp:network.length-http.length,
  assets:{events:assets.length,networkCompleted:assets.filter(r=>r.networkEvidence==='network-fetch-completed').length,cacheBranchUnknown:assets.filter(r=>r.networkEvidence!=='network-fetch-completed').length},
  proxy:{events:proxy.length,failures:proxy.filter(r=>r.event==='request_failed'||r.status>=400).length},
  authProbes,ipc:{startedAt:ipc?.startedAt,readyAt:ipc?.readyAt,complete:ipc?.complete,eventCount:ipc?.events.length||0,errors:ipc?.errors||[],note:ipc?.method},
  networkRouteGroups:group(http,r=>`${r.local?'local':'remote'} ${r.hostKey}:${r.port||'default'} ${r.method} ${r.route}`).map(({key,count,items})=>({key,count,cases:[...new Set(items.map(i=>i.caseId))]})),rows};
const lines=['# 热启动44项实跑：请求证据清单','',`批次：${runId}；状态：${run.status}；已记录：${run.results.length}/${run.selected.length}。`,`开始：${run.startedAt}；结束：${run.endedAt||'尚未结束'}。`,'',
'本表仅使用本次实际执行保存的数据。每项请求为该用例执行窗口所观察到，包含准备、后台及清理；不把时间相近等同点击因果。预热与正式轮次请求均保留，页面性能成绩仍按原热测规则。失败/阻塞时不能声称已遍历该功能内部全部路径。','',
'主进程资产日志只覆盖已打印的完成记录；日志无记录不等于无远端调用。(cache)仅说明经过缓存分支，不能断言缓存命中。模型事件仍为同期未归属。非HTTP资源不算远端API。所有路由均脱敏，分组数不代表产品全量接口数。','',
`额外IPC记录自 ${ipc?.startedAt||'未启动'} 开始，覆盖范围在每项注明。临时不暂停CDP日志点只记录真实函数调用，不能证明HTTP已出网/成功；该诊断手段可能影响运行时间，本批不用于严格性能排名。同期身份探活完成日志 ${authProbes.length} 条，其中unknown ${authProbes.filter(e=>e.state==='unknown').length} 条；日志未关联到具体用例，且unknown并不唯一代表超时。`,'',
'| 用例 | 功能 | 执行结果 | 观测轮次 | 本地HTTP | 页面远端HTTP | 资产完成日志 | 同期模型错误 | 丢弃/日志缺口 |',
'| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
...rows.map(r=>`| ${r.id} | ${clean(r.name)} | ${r.status} | ${r.attempts} | ${r.local.requests} | ${r.remote.requests} | ${r.assetRoutes.reduce((n,a)=>n+a.count,0)} | ${r.proxyFailures} | ${r.dropped}/${r.logGaps} |`),'',
'## 逐项实际路由与执行限制',''];
for(const r of rows){lines.push(`### ${r.id} ${r.name}`,'',`执行：${r.status}；恢复：${r.restored}；完整采集：${r.complete}。`,...(r.reason?[`原因：${clean(r.reason)}`]:[]),'',
`正式计时动作：${r.measurements.length?r.measurements.map(m=>`${m.label} ${m.durationMs}ms`).join('；'):'未取得正式计时样本，不宣称目标操作通过。'}`,'',
'| 来源 | 实际记录的路由模板 | 次数 |','| --- | --- | ---: |',
...r.localRoutes.map(a=>`| 页面→本地 | ${clean(a.key)} | ${a.count} |`),...r.remoteRoutes.map(a=>`| 页面→远端 | ${clean(a.key)} | ${a.count} |`),...r.assetRoutes.map(a=>`| 主进程资产日志 | ${clean(a.key)} | ${a.count} |`),...r.ipcRoutes.map(a=>`| IPC实际发起（${r.ipcCoverage}） | ${clean(a.key)} | ${a.count} |`),'');}
lines.push('## 页面HTTP路由汇总','', '| 路由组 | 请求样本 | 出现用例 |','| --- | ---: | --- |',...report.networkRouteGroups.map(g=>`| ${clean(g.key)} | ${g.count} | ${g.cases.join('、')} |`),'');
const dir=path.join(root,'data','interface-audit-20261026');await fs.mkdir(dir,{recursive:true});
await fs.writeFile(path.join(dir,runId+'.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(dir,runId+'.md'),lines.join('\n'));
console.log(JSON.stringify({runId,status:report.status,recorded:report.recorded,local:report.local,remote:report.remotePage,assets:report.assets,proxy:report.proxy,report:path.join(dir,runId+'.md')}));
